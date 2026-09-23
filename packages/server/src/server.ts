import './proxy.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  CallLogger,
  ProviderIdSchema,
  ProviderRegistry,
  loadConfig,
  updateConfig,
  type GatewayKeyEntry,
} from '@freemodelfinder/core';
import { registerOpenAIRoutes } from './routes/openai.js';
import { registerAnthropicRoutes } from './routes/anthropic.js';
import { registerGeminiRoutes } from './routes/gemini.js';
import { ModelWatcher } from './watcher.js';
import { registerOnboardingRoutes } from './onboarding.js';
import {
  createRuntimeIdentity,
  DESKTOP_CONTROL_PROTOCOL,
  removeRuntimeDescriptor,
  writeRuntimeDescriptor,
  type RuntimeDescriptor,
} from './runtime.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  registry?: ProviderRegistry;
  watchIntervalMs?: number;
  uiDir?: string;
}

export type DeploymentMode = 'local' | 'server';

export interface ServerRuntimeOptions extends ServerOptions {
  mode?: DeploymentMode;
  adminPort?: number;
  gatewayPort?: number;
  adminOrigin?: string;
  publicUrl?: string;
}

export interface ServerRuntime {
  mode: DeploymentMode;
  adminApp: FastifyInstance;
  gatewayApp?: FastifyInstance;
  registry: ProviderRegistry;
  listen: () => Promise<{ adminUrl: string; gatewayUrl?: string }>;
  close: () => Promise<void>;
}

interface SharedRuntimeState {
  registry: ProviderRegistry;
  watcher?: ModelWatcher;
  runtime: Omit<RuntimeDescriptor, 'port'>;
  revision: number;
  catalogRevision: number;
  desktopSignature?: string;
  catalogSignature?: string;
  requestShutdown?: () => Promise<void>;
}

interface AppOptions {
  mode: DeploymentMode;
  surface: 'local' | 'admin' | 'gateway';
  state: SharedRuntimeState;
  watchIntervalMs?: number;
  uiDir?: string;
  adminOrigin?: string;
  adminPort: number;
  gatewayPort: number;
  publicUrl?: string;
  ownsWatcher: boolean;
}

const PROTECTED_PREFIXES = ['/v1/', '/v1beta/'];
export const SERVER_VERSION = '0.1.0-rc.4';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

const LOCAL_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'tauri.localhost']);

const PROVIDER_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  zhipu: 'Zhipu AI',
  siliconflow: 'SiliconFlow',
  modelscope: 'ModelScope',
  nvidia: 'NVIDIA NIM',
  github: 'GitHub Models',
  cohere: 'Cohere',
  huggingface: 'Hugging Face',
  sensenova: 'SenseNova',
  custom: 'Custom',
};

function isPublicGatewayRoute(method: string, url: string): boolean {
  if (method === 'GET' && url === '/v1/models') return true;
  if (method === 'GET' && /^\/v1\/videos\/[^/]+$/.test(url)) return true;
  if (method !== 'POST') return false;
  if (
    url === '/v1/chat/completions' ||
    url === '/v1/messages' ||
    url === '/v1/images/generations' ||
    url === '/v1/videos' ||
    url === '/v1/videos/status' ||
    url === '/v1/videos/proxy'
  )
    return true;
  return /^\/v1beta\/models\/.+:(generateContent|streamGenerateContent)$/.test(url);
}

function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xKey = req.headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.trim()) return xKey.trim();
  const googKey = req.headers['x-goog-api-key'];
  if (typeof googKey === 'string' && googKey.trim()) return googKey.trim();
  return null;
}

function keyMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hasRuntimeControlToken(req: FastifyRequest, state: SharedRuntimeState): boolean {
  const provided = req.headers['x-fmf-control-token'];
  return typeof provided === 'string' && keyMatches(provided, state.runtime.controlToken);
}

function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return LOOPBACK_HOSTS.has(addr);
}

function hasTrustedOrigin(req: FastifyRequest, adminOrigin?: string): boolean {
  const candidates = [req.headers['origin'], req.headers['referer']];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol === 'tauri:') return true;
      if (LOCAL_ORIGIN_HOSTS.has(u.hostname)) return true;
      if (adminOrigin && u.origin === adminOrigin) return true;
    } catch {
      /* ignore malformed origin */
    }
  }
  return false;
}

function isTrustedUiRequest(req: FastifyRequest, adminOrigin?: string): boolean {
  const clientHeader = req.headers['x-fmf-client'];
  const hasUiHeader = typeof clientHeader === 'string' && clientHeader.toLowerCase() === 'ui';
  const isLoopback = isLoopbackAddress(req.socket?.remoteAddress ?? null);

  if (isLoopback) {
    if (hasUiHeader) return hasTrustedOrigin(req, adminOrigin);
    const hasOrigin = !!(req.headers['origin'] || req.headers['referer']);
    if (!hasOrigin) return false;
    return hasTrustedOrigin(req, adminOrigin);
  }

  if (hasUiHeader && !adminOrigin && process.env.FREEMODELFINDER_TRUST_UI === 'true') return true;

  return false;
}

function generateApiKey(): string {
  return `fmf-${randomBytes(24).toString('base64url')}`;
}

function generateKeyId(): string {
  return `key-${randomBytes(6).toString('hex')}`;
}

function activeGatewayKeys(
  gateway: { apiKey?: string; keys?: GatewayKeyEntry[] } | undefined,
): GatewayKeyEntry[] {
  if (gateway?.keys?.length) return gateway.keys;
  if (gateway?.apiKey) return [{ id: 'default', key: gateway.apiKey, createdAt: 0 }];
  return [];
}

function buildKeyMeta(keys: readonly string[]): Array<{ id: string; hint: string }> {
  return keys
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter((k) => !!k)
    .map((k, i) => ({
      id: `k${i}`,
      hint: `…${k.length >= 4 ? k.slice(-4) : k.length >= 2 ? k.slice(-2) : k}`,
    }));
}

function providerKeyPool(cred: { apiKey?: string; apiKeys?: string[] } | undefined): string[] {
  const pool = cred?.apiKeys?.filter((k) => !!k?.trim()) ?? [];
  if (pool.length) return pool;
  return cred?.apiKey?.trim() ? [cred.apiKey.trim()] : [];
}

function sourceKeyPool(apiKey: string | string[] | undefined): string[] {
  if (Array.isArray(apiKey)) return apiKey.filter((k) => typeof k === 'string' && !!k.trim());
  return typeof apiKey === 'string' && apiKey.trim() ? [apiKey.trim()] : [];
}

function findMatchingGatewayKey(
  provided: string | null,
  keys: GatewayKeyEntry[],
): GatewayKeyEntry | null {
  if (!provided) return null;
  const now = Date.now();
  for (const entry of keys) {
    if (!entry.key) continue;
    if (entry.expiresAt && entry.expiresAt < now) continue;
    if (keyMatches(provided, entry.key)) return entry;
  }
  return null;
}

function normalizeHttpsOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must not include a path, query, or fragment`);
  }
  return url.origin;
}

async function enforceServerGatewayAuth(
  registry: ProviderRegistry,
  persist: boolean,
): Promise<void> {
  const current = registry.getConfig();
  const hasKey =
    activeGatewayKeys(current.gateway).length > 0 || !!current.gateway?.keys?.some((k) => k.key);
  if (hasKey && current.gateway?.requireAuth) return;
  if (!persist) {
    const key = generateApiKey();
    registry.updateConfig({
      ...current,
      gateway: {
        ...current.gateway,
        apiKey: current.gateway?.apiKey || key,
        keys: current.gateway?.keys?.length
          ? current.gateway.keys
          : [{ id: generateKeyId(), key, createdAt: Date.now() }],
        requireAuth: true,
      },
    });
    return;
  }
  const next = await updateConfig((cfg) => {
    const existing = activeGatewayKeys(cfg.gateway);
    const key = cfg.gateway?.apiKey || existing[0]?.key || generateApiKey();
    cfg.gateway = {
      ...cfg.gateway,
      apiKey: key,
      keys: cfg.gateway?.keys?.length
        ? cfg.gateway.keys
        : [{ id: generateKeyId(), key, createdAt: Date.now() }],
      requireAuth: true,
    };
    return cfg;
  });
  registry.updateConfig(next);
}

async function createApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.x-api-key',
          'req.headers.x-goog-api-key',
          'req.headers.x-fmf-control-token',
          'req.body.apiKey',
          'req.body.apiKeys',
          'req.body.credential.apiKey',
          'req.body.sources[*].apiKey',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  if (opts.surface !== 'gateway') {
    await app.register(cors, {
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }
        try {
          const url = new URL(origin);
          callback(
            null,
            url.protocol === 'tauri:' ||
              LOCAL_ORIGIN_HOSTS.has(url.hostname) ||
              (!!opts.adminOrigin && url.origin === opts.adminOrigin),
          );
        } catch {
          callback(null, false);
        }
      },
    });
  }

  const getRegistry = () => opts.state.registry;
  const callLogger = new CallLogger();
  callLogger.cleanup().catch(() => {});

  app.addHook('onClose', async () => {
    await callLogger.flush();
  });

  if (opts.ownsWatcher) {
    const watcher = new ModelWatcher({
      intervalMs: opts.watchIntervalMs ?? 60 * 60 * 1000,
      getRegistry,
      logger: app.log,
      onCatalogChange: () => {
        opts.state.catalogRevision += 1;
        opts.state.revision += 1;
      },
    });
    await watcher.init();
    watcher.start();
    opts.state.watcher = watcher;
    app.addHook('onClose', async () => {
      watcher.stop();
    });
  }

  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0] ?? req.url;
    const desktopControlRoute =
      url === '/api/desktop/state' ||
      url === '/api/default-model' ||
      url === '/api/auto-route' ||
      url === '/api/runtime/shutdown';
    if (
      opts.surface !== 'gateway' &&
      url.startsWith('/api/') &&
      !isTrustedUiRequest(req, opts.adminOrigin) &&
      !(desktopControlRoute && hasRuntimeControlToken(req, opts.state))
    ) {
      return reply.code(403).send({ error: 'management API is available only to the local UI' });
    }
    if (opts.surface === 'gateway' && !isPublicGatewayRoute(req.method, url)) return;
    if (!PROTECTED_PREFIXES.some((p) => url.startsWith(p))) return;
    const gateway = getRegistry().getConfig().gateway;
    const hasAnyKey = activeGatewayKeys(gateway).length > 0;
    if (opts.surface !== 'gateway' && (!gateway?.requireAuth || !hasAnyKey)) return;
    if (opts.surface !== 'gateway' && isTrustedUiRequest(req, opts.adminOrigin)) return;
    const provided = extractBearer(req);
    const matchedKey = findMatchingGatewayKey(provided, activeGatewayKeys(gateway));
    if (!matchedKey) {
      return reply.code(401).send({
        error: {
          message: 'Missing or invalid API key. Include `Authorization: Bearer <key>`.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
    if (matchedKey.dailyRequestLimit || matchedKey.dailyTokenLimit) {
      const usage = await callLogger.usageForGatewayKey(matchedKey.id);
      if (matchedKey.dailyRequestLimit && usage.requests >= matchedKey.dailyRequestLimit) {
        return reply.code(429).send({
          error: {
            message: `Daily request limit reached for this key (${matchedKey.dailyRequestLimit}/day).`,
            type: 'rate_limit_error',
            code: 'daily_request_limit',
          },
        });
      }
      if (matchedKey.dailyTokenLimit && usage.tokens >= matchedKey.dailyTokenLimit) {
        return reply.code(429).send({
          error: {
            message: `Daily token limit reached for this key (${matchedKey.dailyTokenLimit}/day).`,
            type: 'rate_limit_error',
            code: 'daily_token_limit',
          },
        });
      }
    }
  });

  app.get('/healthz', async () => ({
    ok: true,
    service: 'freemodelfinder',
    version: SERVER_VERSION,
    instanceId: opts.state.runtime.instanceId,
    desktopControlProtocol: DESKTOP_CONTROL_PROTOCOL,
    uiAvailable: Boolean(opts.uiDir),
    ts: Date.now(),
  }));

  if (opts.surface !== 'gateway') {
    app.get('/api/desktop/state', async () => {
      const cfg = getRegistry().getConfig();
      const { models, failedProviders } = await getRegistry().listAllModels();
      const catalogSignature = JSON.stringify(
        models.map((model) => [model.provider, model.id, model.displayName ?? '']),
      );
      if (opts.state.catalogSignature !== catalogSignature) {
        if (opts.state.catalogSignature !== undefined) opts.state.catalogRevision += 1;
        opts.state.catalogSignature = catalogSignature;
      }
      const available = new Set(models.map((model) => `${model.provider}:${model.id}`));
      const defaultModel = cfg.defaultModel;
      const selectionValid =
        !defaultModel || defaultModel === 'auto' || available.has(defaultModel);
      const desktopSignature = JSON.stringify({
        defaultModel,
        autoRoute: cfg.autoRoute,
        onboarding: cfg.onboarding,
        catalogRevision: opts.state.catalogRevision,
      });
      if (opts.state.desktopSignature !== desktopSignature) {
        if (opts.state.desktopSignature !== undefined) opts.state.revision += 1;
        opts.state.desktopSignature = desktopSignature;
      }
      const grouped = new Map<string, Array<{ id: string; value: string; label: string }>>();
      for (const model of models) {
        const entries = grouped.get(model.provider) ?? [];
        entries.push({
          id: model.id,
          value: `${model.provider}:${model.id}`,
          label: model.displayName ?? model.id,
        });
        grouped.set(model.provider, entries);
      }
      const onboardingHandled = !!cfg.onboarding?.completedAt || !!cfg.onboarding?.dismissedAt;
      const hasConfiguredProvider = getRegistry().listEnabledProviders().length > 0;
      return {
        instanceId: opts.state.runtime.instanceId,
        serviceVersion: SERVER_VERSION,
        protocolVersion: DESKTOP_CONTROL_PROTOCOL,
        revision: opts.state.revision,
        catalogRevision: opts.state.catalogRevision,
        defaultModel: defaultModel ?? null,
        selectionValid,
        onboardingRequired: !hasConfiguredProvider && !onboardingHandled,
        auto: {
          available: models.length > 0,
          enabled: !!cfg.autoRoute?.enabled,
          strategy: cfg.autoRoute?.strategy ?? 'capability',
        },
        providers: Array.from(grouped, ([id, providerModels]) => ({
          id,
          label: PROVIDER_LABELS[id] ?? id,
          models: providerModels,
        })),
        failedProviders,
      };
    });

    app.post('/api/runtime/shutdown', async (req, reply) => {
      if (!hasRuntimeControlToken(req, opts.state)) {
        return reply.code(401).send({ error: 'invalid runtime control token' });
      }
      await reply.send({ ok: true, instanceId: opts.state.runtime.instanceId });
      setImmediate(() => void opts.state.requestShutdown?.());
    });

    app.get('/api/config', async () => {
      const cfg = getRegistry().getConfig();
      const custom = cfg.providers.custom;
      const customExtra = (custom?.credentials?.extra ?? {}) as {
        sources?: Array<{
          id: string;
          label?: string;
          baseUrl: string;
          hasKey?: boolean;
          apiKey?: string | string[];
          models?: Array<{ id: string; displayName?: string; contextWindow?: number }>;
        }>;
        models?: Array<{ id: string; displayName?: string; contextWindow?: number }>;
      };
      const rawSources = Array.isArray(customExtra.sources) ? customExtra.sources : null;
      const legacyBaseUrl = custom?.credentials?.baseUrl ?? '';
      const legacyModels = Array.isArray(customExtra.models) ? customExtra.models : [];
      const legacyHasKey = !!custom?.credentials?.apiKey;
      const sources = rawSources
        ? rawSources.map((s) => ({
            id: String(s.id ?? ''),
            label: s.label ?? '',
            baseUrl: String(s.baseUrl ?? ''),
            hasKey: !!(Array.isArray(s.apiKey)
              ? s.apiKey.some((x) => typeof x === 'string' && x)
              : s.apiKey),
            keyMeta: buildKeyMeta(sourceKeyPool(s.apiKey)),
            models: Array.isArray(s.models) ? s.models : [],
          }))
        : legacyBaseUrl
          ? [
              {
                id: 'default',
                label: 'Custom',
                baseUrl: legacyBaseUrl,
                hasKey: legacyHasKey,
                keyMeta: legacyHasKey ? buildKeyMeta([custom.credentials?.apiKey ?? '']) : [],
                models: legacyModels,
              },
            ]
          : [];
      return {
        version: cfg.version,
        port: cfg.port,
        defaultModel: cfg.defaultModel,
        onboarding: cfg.onboarding,
        providers: Object.fromEntries(
          Object.entries(cfg.providers).map(([id, s]) => [
            id,
            {
              enabled: s?.enabled ?? false,
              hasKey: !!s?.credentials?.apiKey,
              keyCount:
                (s?.credentials?.apiKeys?.filter((k) => !!k?.trim()) ?? []).length ||
                (s?.credentials?.apiKey ? 1 : 0),
              keyMeta: buildKeyMeta(providerKeyPool(s?.credentials)),
              credentialError: s?.credentialError,
            },
          ]),
        ),
        custom: {
          enabled: !!custom?.enabled,
          hasKey: legacyHasKey,
          baseUrl: legacyBaseUrl,
          models: legacyModels,
          sources,
        },
      };
    });

    registerOnboardingRoutes(app, {
      getRegistry,
      updateRegistry: (config) => getRegistry().updateConfig(config),
      refreshSnapshot: () => opts.state.watcher?.tick(true) ?? Promise.resolve(null),
    });

    app.post<{
      Body: {
        provider: string;
        apiKey?: string;
        apiKeys?: string[];
        enabled?: boolean;
        baseUrl?: string;
        clearCredentials?: boolean;
        appendKeys?: string[];
        removeKeyIndex?: number;
        models?: Array<{ id: string; displayName?: string; contextWindow?: number }>;
        sources?: Array<{
          id: string;
          label?: string;
          baseUrl: string;
          apiKey?: string;
          models?: Array<{ id: string; displayName?: string; contextWindow?: number }>;
        }>;
        appendSourceKeys?: { sourceId: string; keys: string[] };
        removeSourceKey?: { sourceId: string; index: number };
      };
    }>('/api/providers', async (req, reply) => {
      const {
        provider,
        apiKey,
        apiKeys,
        enabled,
        baseUrl,
        clearCredentials,
        models,
        sources,
        appendKeys,
        removeKeyIndex,
        appendSourceKeys,
        removeSourceKey,
      } = req.body ?? {};
      if (!provider) return reply.code(400).send({ error: 'provider required' });
      const parsedProvider = ProviderIdSchema.safeParse(provider);
      if (!parsedProvider.success || parsedProvider.data === 'ollama') {
        return reply.code(400).send({ error: `unsupported provider: ${provider}` });
      }
      const providerId = parsedProvider.data;
      const cleanApiKeys = Array.isArray(apiKeys)
        ? (apiKeys
            .map((k) => (typeof k === 'string' ? k.trim() : ''))
            .filter((k) => !!k) as string[])
        : undefined;
      const cleanApiKey =
        cleanApiKeys !== undefined
          ? (cleanApiKeys[0] ?? '')
          : typeof apiKey === 'string'
            ? apiKey.trim()
            : apiKey;
      const cleanBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim() : baseUrl;
      const cleanModels = Array.isArray(models)
        ? models
            .map((m) => ({
              id: typeof m?.id === 'string' ? m.id.trim() : '',
              displayName:
                typeof m?.displayName === 'string' && m.displayName.trim()
                  ? m.displayName.trim()
                  : undefined,
              contextWindow:
                typeof m?.contextWindow === 'number' && m.contextWindow > 0
                  ? m.contextWindow
                  : undefined,
            }))
            .filter((m) => m.id)
        : undefined;
      const cleanSources = Array.isArray(sources)
        ? sources
            .map((s) => {
              const id = typeof s?.id === 'string' ? s.id.trim() : '';
              const bu = typeof s?.baseUrl === 'string' ? s.baseUrl.trim() : '';
              if (!id || !bu) return null;
              const rawKey = s?.apiKey;
              let key: string | string[] | undefined;
              if (Array.isArray(rawKey)) {
                const keys = rawKey
                  .map((k) => (typeof k === 'string' ? k.trim() : ''))
                  .filter((k) => !!k);
                if (keys.length) key = keys.length === 1 ? keys[0] : keys;
              } else if (typeof rawKey === 'string' && rawKey.trim()) {
                key = rawKey.trim();
              }
              const label =
                typeof s?.label === 'string' && s.label.trim() ? s.label.trim() : undefined;
              const modelsList = Array.isArray(s?.models)
                ? s!
                    .models!.map((m) => ({
                      id: typeof m?.id === 'string' ? m.id.trim() : '',
                      displayName:
                        typeof m?.displayName === 'string' && m.displayName.trim()
                          ? m.displayName.trim()
                          : undefined,
                      contextWindow:
                        typeof m?.contextWindow === 'number' && m.contextWindow > 0
                          ? m.contextWindow
                          : undefined,
                    }))
                    .filter((m) => m.id)
                : [];
              return {
                id,
                label,
                baseUrl: bu.replace(/\/$/, ''),
                ...(Array.isArray(rawKey)
                  ? (() => {
                      const keys = rawKey
                        .map((k) => (typeof k === 'string' ? k.trim() : ''))
                        .filter((k) => !!k);
                      return keys.length ? { apiKey: keys.length === 1 ? keys[0] : keys } : {};
                    })()
                  : key
                    ? { apiKey: key }
                    : {}),
                models: modelsList,
              };
            })
            .filter((s): s is NonNullable<typeof s> => !!s)
        : undefined;
      const cleanAppendKeys = Array.isArray(appendKeys)
        ? appendKeys.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => !!k)
        : undefined;
      if (appendKeys !== undefined && (!cleanAppendKeys || cleanAppendKeys.length === 0)) {
        return reply.code(400).send({ error: 'appendKeys must be non-empty' });
      }
      if (
        removeKeyIndex !== undefined &&
        (typeof removeKeyIndex !== 'number' ||
          !Number.isInteger(removeKeyIndex) ||
          removeKeyIndex < 0)
      ) {
        return reply.code(400).send({ error: 'removeKeyIndex must be a non-negative integer' });
      }
      if (
        (appendSourceKeys !== undefined || removeSourceKey !== undefined) &&
        providerId !== 'custom'
      ) {
        return reply.code(400).send({ error: 'source key ops require provider "custom"' });
      }
      const appendSourceKeyList =
        appendSourceKeys && Array.isArray(appendSourceKeys.keys)
          ? appendSourceKeys.keys
              .map((k) => (typeof k === 'string' ? k.trim() : ''))
              .filter((k) => !!k)
          : undefined;
      if (
        appendSourceKeys !== undefined &&
        (typeof appendSourceKeys.sourceId !== 'string' ||
          !appendSourceKeys.sourceId.trim() ||
          !appendSourceKeyList ||
          appendSourceKeyList.length === 0)
      ) {
        return reply.code(400).send({ error: 'appendSourceKeys invalid' });
      }
      if (
        removeSourceKey !== undefined &&
        (typeof removeSourceKey.sourceId !== 'string' ||
          !removeSourceKey.sourceId.trim() ||
          typeof removeSourceKey.index !== 'number' ||
          !Number.isInteger(removeSourceKey.index) ||
          removeSourceKey.index < 0)
      ) {
        return reply.code(400).send({ error: 'removeSourceKey invalid' });
      }
      const curCfg = getRegistry().getConfig();
      if (removeKeyIndex !== undefined && providerId !== 'custom') {
        const pool = providerKeyPool(curCfg.providers[providerId]?.credentials);
        if (removeKeyIndex >= pool.length) {
          return reply.code(400).send({ error: 'removeKeyIndex out of range' });
        }
      }
      if (removeSourceKey || appendSourceKeys) {
        const customExtra = (curCfg.providers.custom?.credentials?.extra ?? {}) as {
          sources?: Array<{ id?: string; apiKey?: string | string[] }>;
        };
        const list = Array.isArray(customExtra.sources) ? customExtra.sources : [];
        if (removeSourceKey) {
          const target = list.find((s) => s?.id === removeSourceKey.sourceId);
          if (!target) {
            return reply.code(404).send({ error: `unknown source: ${removeSourceKey.sourceId}` });
          }
          const pool = sourceKeyPool(target.apiKey);
          if (removeSourceKey.index >= pool.length) {
            return reply.code(400).send({ error: 'removeSourceKey index out of range' });
          }
        }
        if (appendSourceKeys) {
          const target = list.find((s) => s?.id === appendSourceKeys.sourceId);
          if (!target) {
            return reply.code(404).send({ error: `unknown source: ${appendSourceKeys.sourceId}` });
          }
        }
      }
      try {
        const next = await updateConfig((cfg) => {
          const cur = (cfg.providers[providerId] ?? { enabled: false }) as {
            enabled: boolean;
            credentials?: {
              apiKey: string;
              apiKeys?: string[];
              baseUrl?: string;
              extra?: Record<string, unknown>;
            };
          };
          const shouldClear = clearCredentials === true || cleanApiKey === '';
          const prevExtra = cur.credentials?.extra ?? {};

          if (providerId === 'custom') {
            if (clearCredentials === true) {
              cfg.providers[providerId] = {
                ...cur,
                enabled: enabled ?? false,
                credentials: undefined,
              };
              return cfg;
            }
            const nextExtra: Record<string, unknown> = { ...prevExtra };
            if (cleanSources !== undefined) {
              nextExtra.sources = cleanSources;
              delete (nextExtra as { models?: unknown }).models;
            } else if (cleanModels !== undefined) {
              nextExtra.models = cleanModels;
            }
            if (removeSourceKey || appendSourceKeys) {
              const list = Array.isArray(nextExtra.sources)
                ? (nextExtra.sources as Array<{
                    id: string;
                    apiKey?: string | string[];
                    label?: string;
                    baseUrl: string;
                    models?: Array<{ id: string }>;
                  }>)
                : [];
              if (removeSourceKey) {
                const idx = list.findIndex((s) => s.id === removeSourceKey.sourceId);
                if (idx >= 0) {
                  const pool = sourceKeyPool(list[idx]?.apiKey);
                  if (removeSourceKey.index < pool.length) {
                    const nextPool = pool.filter((_, i) => i !== removeSourceKey.index);
                    if (nextPool.length === 0) delete list[idx]!.apiKey;
                    else list[idx]!.apiKey = nextPool.length === 1 ? nextPool[0] : nextPool;
                    nextExtra.sources = list;
                  }
                }
              }
              if (appendSourceKeys) {
                const idx = list.findIndex((s) => s.id === appendSourceKeys.sourceId);
                if (idx >= 0 && appendSourceKeyList?.length) {
                  const pool = [...sourceKeyPool(list[idx]?.apiKey), ...appendSourceKeyList];
                  list[idx]!.apiKey = pool.length === 1 ? pool[0] : pool;
                  nextExtra.sources = list;
                }
              }
            }
            const topKey =
              cleanApiKey ?? cur.credentials?.apiKeys?.[0] ?? cur.credentials?.apiKey ?? '';
            const topApiKeys =
              cleanApiKeys !== undefined
                ? cleanApiKeys
                : (cur.credentials?.apiKeys ?? (topKey ? [topKey] : []));
            const topBaseUrl = cleanBaseUrl !== undefined ? cleanBaseUrl : cur.credentials?.baseUrl;
            cfg.providers[providerId] = {
              ...cur,
              enabled: enabled ?? cur.enabled,
              credentials: {
                apiKey: topApiKeys[0] ?? topKey,
                ...(topApiKeys.length ? { apiKeys: topApiKeys } : {}),
                baseUrl: topBaseUrl,
                extra: nextExtra,
              },
            };
            return cfg;
          }

          const nextExtra = {
            ...prevExtra,
            ...(cleanModels !== undefined ? { models: cleanModels } : {}),
          };
          let nextApiKeys =
            cleanApiKeys !== undefined
              ? cleanApiKeys
              : cleanApiKey
                ? [cleanApiKey]
                : (cur.credentials?.apiKeys ??
                  (cur.credentials?.apiKey ? [cur.credentials.apiKey] : undefined));
          if (removeKeyIndex !== undefined && !shouldClear) {
            const base = nextApiKeys ?? providerKeyPool(cur.credentials);
            if (removeKeyIndex < base.length) {
              nextApiKeys = base.filter((_, i) => i !== removeKeyIndex);
            }
          }
          if (cleanAppendKeys?.length && !shouldClear) {
            nextApiKeys = [...(nextApiKeys ?? []), ...cleanAppendKeys];
          }
          const removeEmptiedKeys =
            removeKeyIndex !== undefined &&
            !shouldClear &&
            Array.isArray(nextApiKeys) &&
            nextApiKeys.length === 0;
          const nextKey = nextApiKeys?.[0] ?? cleanApiKey ?? '';
          cfg.providers[providerId] = {
            ...cur,
            enabled: enabled ?? cur.enabled,
            credentials: shouldClear
              ? undefined
              : removeEmptiedKeys
                ? {
                    apiKey: '',
                    baseUrl: cleanBaseUrl ?? cur.credentials?.baseUrl,
                    extra: nextExtra,
                  }
                : nextKey || (nextApiKeys?.length ?? 0) > 0
                  ? {
                      apiKey: nextKey,
                      ...(nextApiKeys?.length ? { apiKeys: nextApiKeys } : {}),
                      baseUrl: cleanBaseUrl ?? cur.credentials?.baseUrl,
                      extra: nextExtra,
                    }
                  : cur.credentials
                    ? {
                        ...cur.credentials,
                        baseUrl:
                          cleanBaseUrl !== undefined ? cleanBaseUrl : cur.credentials.baseUrl,
                        extra: nextExtra,
                      }
                    : undefined,
          };
          return cfg;
        });
        opts.state.registry = new ProviderRegistry(next);
        opts.state.catalogRevision += 1;
        opts.state.revision += 1;
        void opts.state.watcher?.tick(true);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        const hint =
          code === 'EPERM' || code === 'EACCES'
            ? '（配置目录写入被拒绝，请检查 ~/.freemodelfinder 权限或设置 FREEMODELFINDER_HOME 到有写权限的目录）'
            : '';
        req.log.error({ err, provider: providerId }, 'failed to save provider config');
        return reply.code(500).send({ error: `${message}${hint}`, code });
      }
    });

    app.post<{ Body: { baseUrl: string; apiKey?: string } }>(
      '/api/custom/fetch-models',
      async (req, reply) => {
        const { baseUrl: rawBaseUrl, apiKey } = req.body ?? {};
        if (!rawBaseUrl) return reply.code(400).send({ error: 'baseUrl required' });
        const base = rawBaseUrl.replace(/\/+$/, '');
        const modelsPath = /\/v1\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`;
        const url = modelsPath;
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        try {
          const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return reply
              .code(502)
              .send({ error: `upstream ${resp.status}: ${text.slice(0, 200)}` });
          }
          const json = (await resp.json()) as {
            data?: Array<{ id: string; object?: string }>;
          };
          const models = (json.data ?? [])
            .filter((m) => m.object === 'model' || !m.object)
            .map((m) => ({ id: m.id }));
          return { models };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.code(502).send({ error: msg });
        }
      },
    );

    app.post<{ Body: { model: string } }>('/api/default-model', async (req, reply) => {
      const model = req.body?.model?.trim();
      if (!model) return reply.code(400).send({ error: 'model required' });
      if (model !== 'auto') {
        const { models } = await getRegistry().listAllModels();
        const available = models.some((item) => `${item.provider}:${item.id}` === model);
        if (!available) return reply.code(400).send({ error: `model is not available: ${model}` });
      }
      const next = await updateConfig((cfg) => ({ ...cfg, defaultModel: model }));
      getRegistry().updateConfig(next, { preserveModels: true });
      opts.state.revision += 1;
      return { ok: true, defaultModel: model, revision: opts.state.revision };
    });

    app.get('/api/auto-route', async () => {
      const cfg = getRegistry().getConfig();
      const ar = cfg.autoRoute ?? { enabled: false, strategy: 'capability' as const };
      const router = getRegistry().getAutoRouter();
      return {
        enabled: !!ar.enabled,
        strategy: ar.strategy,
        profiles: ar.profiles ?? [],
        fallbackChain: ar.fallbackChain ?? [],
        imageModel: ar.imageModel,
        videoModel: ar.videoModel,
        textTiers: ar.textTiers,
        cooldowns: router.listCooldowns(),
        rememberedPreference: router.getRememberedPreference(),
        recentNotices: getRegistry().peekNotices(),
      };
    });

    app.post<{
      Body: {
        enabled?: boolean;
        strategy?: 'capability' | 'speed' | 'rate-limit';
        fallbackChain?: string[];
        profiles?: unknown;
        imageModel?: string;
        videoModel?: string;
        textTiers?: { simple?: string; medium?: string; complex?: string };
      };
    }>('/api/auto-route', async (req, reply) => {
      const { enabled, strategy, fallbackChain, profiles, imageModel, videoModel, textTiers } =
        req.body ?? {};
      if (strategy && !['capability', 'speed', 'rate-limit'].includes(strategy)) {
        return reply.code(400).send({ error: 'invalid strategy' });
      }
      const next = await updateConfig((cfg) => {
        const cur = cfg.autoRoute ?? { enabled: false, strategy: 'capability' as const };
        const prevTiers = cur.textTiers;
        cfg.autoRoute = {
          enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
          strategy: strategy ?? cur.strategy,
          fallbackChain: Array.isArray(fallbackChain) ? fallbackChain : cur.fallbackChain,
          profiles: Array.isArray(profiles) ? (profiles as never) : cur.profiles,
          imageModel: typeof imageModel === 'string' ? imageModel : cur.imageModel,
          videoModel: typeof videoModel === 'string' ? videoModel : cur.videoModel,
          textTiers: textTiers
            ? {
                simple: textTiers.simple ?? prevTiers?.simple,
                medium: textTiers.medium ?? prevTiers?.medium,
                complex: textTiers.complex ?? prevTiers?.complex,
              }
            : prevTiers,
        };
        return cfg;
      });
      getRegistry().updateConfig(next, { preserveModels: true });
      return { ok: true, autoRoute: next.autoRoute };
    });

    app.post<{ Body: { model?: string } }>('/api/auto-route/clear-cooldown', async (req) => {
      const router = getRegistry().getAutoRouter();
      if (req.body?.model) {
        router.clearCooldown(req.body.model);
      } else {
        for (const c of router.listCooldowns()) router.clearCooldown(c.model);
        router.resetPreference();
      }
      return { ok: true, cooldowns: router.listCooldowns() };
    });

    app.get<{
      Querystring: {
        limit?: string;
        model?: string;
        provider?: string;
        status?: string;
        kind?: string;
        since?: string;
      };
    }>('/api/logs', async (req) => {
      const q = req.query ?? {};
      const data = await callLogger.list({
        limit: q.limit ? Number(q.limit) : undefined,
        model: q.model,
        provider: q.provider,
        status:
          q.status === 'success' || q.status === 'error' || q.status === 'rate_limited'
            ? q.status
            : undefined,
        kind: q.kind === 'chat' || q.kind === 'image' || q.kind === 'video' ? q.kind : undefined,
        since: q.since ? Number(q.since) : undefined,
      });
      return { data };
    });

    app.get<{ Querystring: { range?: string } }>('/api/stats', async (req) => {
      const rangeRaw = req.query?.range;
      const range =
        rangeRaw === '7d' || rangeRaw === '30d' || rangeRaw === 'all' ? rangeRaw : 'today';
      return await callLogger.aggregate(range);
    });

    app.get('/api/gateway', async () => {
      const cfg = getRegistry().getConfig();
      const gw = cfg.gateway ?? {};
      const keys = activeGatewayKeys(gw);
      return {
        hasKey: keys.length > 0,
        apiKey: gw.apiKey ?? keys[0]?.key ?? null,
        keys: keys.map((k) => ({
          id: k.id,
          label: k.label ?? null,
          key: k.key,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt ?? null,
          dailyRequestLimit: k.dailyRequestLimit ?? null,
          dailyTokenLimit: k.dailyTokenLimit ?? null,
        })),
        requireAuth: !!gw.requireAuth,
        port: opts.mode === 'server' ? opts.gatewayPort : cfg.port,
        mode: opts.mode,
        adminPort: opts.adminPort,
        gatewayPort: opts.gatewayPort,
        publicBaseUrl: opts.publicUrl ?? null,
        authLocked: opts.mode === 'server',
      };
    });

    app.post<{
      Body: {
        action?: 'generate' | 'revoke' | 'update' | 'create' | 'delete';
        requireAuth?: boolean;
        id?: string;
        label?: string;
        expiresAt?: number | null;
        dailyRequestLimit?: number | null;
        dailyTokenLimit?: number | null;
      };
    }>('/api/gateway', async (req, reply) => {
      const { action, requireAuth, id, label, expiresAt, dailyRequestLimit, dailyTokenLimit } =
        req.body ?? {};
      if (opts.mode === 'server' && (action === 'revoke' || requireAuth === false)) {
        return reply.code(409).send({
          error: 'gateway authentication is mandatory in server mode; rotate the key instead',
        });
      }
      if (opts.mode === 'server' && action === 'delete' && id) {
        const currentKeys = activeGatewayKeys(getRegistry().getConfig().gateway);
        if (currentKeys.length <= 1) {
          return reply.code(409).send({
            error: 'cannot delete the last gateway key in server mode',
          });
        }
      }
      const next = await updateConfig((cfg) => {
        const cur = cfg.gateway ?? {};
        const keys = [...activeGatewayKeys(cur)];
        let requireAuthNext = cur.requireAuth;
        if (action === 'generate' || action === 'create') {
          const entry: GatewayKeyEntry = {
            id: generateKeyId(),
            key: generateApiKey(),
            createdAt: Date.now(),
            ...(label ? { label } : {}),
            ...(typeof expiresAt === 'number' && expiresAt > 0 ? { expiresAt } : {}),
            ...(typeof dailyRequestLimit === 'number' && dailyRequestLimit > 0
              ? { dailyRequestLimit }
              : {}),
            ...(typeof dailyTokenLimit === 'number' && dailyTokenLimit > 0
              ? { dailyTokenLimit }
              : {}),
          };
          keys.push(entry);
          if (action === 'generate') requireAuthNext = cur.requireAuth ?? true;
        } else if (action === 'delete' && id) {
          const idx = keys.findIndex((k) => k.id === id);
          if (idx >= 0) keys.splice(idx, 1);
        } else if (action === 'revoke') {
          keys.length = 0;
          requireAuthNext = false;
        } else if (action === 'update' && id) {
          const entry = keys.find((k) => k.id === id);
          if (entry) {
            if (typeof label === 'string') entry.label = label;
            entry.expiresAt =
              typeof expiresAt === 'number' && expiresAt > 0 ? expiresAt : undefined;
            entry.dailyRequestLimit =
              typeof dailyRequestLimit === 'number' && dailyRequestLimit > 0
                ? dailyRequestLimit
                : undefined;
            entry.dailyTokenLimit =
              typeof dailyTokenLimit === 'number' && dailyTokenLimit > 0
                ? dailyTokenLimit
                : undefined;
          }
        }
        if (action === 'update' && typeof requireAuth === 'boolean' && !id) {
          requireAuthNext = opts.mode === 'server' ? true : requireAuth;
        } else if (action === 'generate') {
          requireAuthNext =
            opts.mode === 'server'
              ? true
              : typeof requireAuth === 'boolean'
                ? requireAuth
                : (requireAuthNext ?? true);
        }
        cfg.gateway = {
          ...cur,
          // Keep legacy apiKey synced with the first key for backward compat.
          apiKey: keys[0]?.key,
          keys,
          requireAuth: opts.mode === 'server' ? true : requireAuthNext,
        };
        return cfg;
      });
      if (opts.mode === 'server' && action === 'delete' && id) {
        const remaining = activeGatewayKeys(next.gateway);
        if (remaining.length === 0) {
          return reply.code(409).send({
            error: 'cannot delete the last gateway key in server mode',
          });
        }
      }
      getRegistry().updateConfig(next, { preserveModels: true });
      const gw = next.gateway ?? {};
      const keys = activeGatewayKeys(gw);
      return {
        ok: true,
        hasKey: keys.length > 0,
        apiKey: gw.apiKey ?? keys[0]?.key ?? null,
        keys: keys.map((k) => ({
          id: k.id,
          label: k.label ?? null,
          key: k.key,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt ?? null,
          dailyRequestLimit: k.dailyRequestLimit ?? null,
          dailyTokenLimit: k.dailyTokenLimit ?? null,
        })),
        requireAuth: !!gw.requireAuth,
        mode: opts.mode,
        adminPort: opts.adminPort,
        gatewayPort: opts.gatewayPort,
        publicBaseUrl: opts.publicUrl ?? null,
        authLocked: opts.mode === 'server',
      };
    });
  }

  registerOpenAIRoutes(app, getRegistry, {
    includeManagement: opts.surface !== 'gateway',
    callLogger,
  });
  registerAnthropicRoutes(app, getRegistry);
  registerGeminiRoutes(app, getRegistry);

  if (opts.surface !== 'gateway') {
    app.get<{ Querystring: { since?: string; limit?: string } }>(
      '/v1/models/changes',
      async (req) => {
        const watcher = opts.state.watcher!;
        const snapshot = watcher.getSnapshot();
        const status = watcher.getStatus();
        const sinceRaw = req.query?.since;
        const limitRaw = req.query?.limit;
        const since = sinceRaw ? Number(sinceRaw) : 0;
        const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 50;
        const added = (snapshot?.added ?? []).filter((c) => c.detectedAt > since).slice(0, limit);
        const removed = (snapshot?.removed ?? [])
          .filter((c) => c.detectedAt > since)
          .slice(0, limit);
        return {
          updatedAt: snapshot?.updatedAt ?? 0,
          total: snapshot?.models.length ?? 0,
          watcher: {
            intervalMs: status.intervalMs,
            lastRunAt: status.lastRunAt,
            lastError: status.lastError,
            running: status.running,
          },
          added,
          removed,
        };
      },
    );

    app.post('/v1/models/refresh', async () => {
      const watcher = opts.state.watcher!;
      const snapshot = await watcher.tick(true);
      const status = watcher.getStatus();
      return {
        ok: !status.lastError,
        error: status.lastError,
        updatedAt: snapshot?.updatedAt ?? 0,
        total: snapshot?.models.length ?? 0,
      };
    });
  }

  if (opts.uiDir) {
    const uiRoot = resolve(opts.uiDir);
    await app.register(fastifyStatic, {
      root: uiRoot,
      prefix: '/',
      index: false,
    });
    app.get('/', async (_req, reply) => reply.sendFile('index.html'));
    app.get('/settings', async (_req, reply) => reply.sendFile('settings.html'));
  }

  return app;
}

export async function createServer(opts: ServerOptions = {}): Promise<{
  app: FastifyInstance;
  registry: ProviderRegistry;
  listen: (port?: number, host?: string) => Promise<string>;
}> {
  const state: SharedRuntimeState = {
    registry: opts.registry ?? new ProviderRegistry(await loadConfig()),
    runtime: createRuntimeIdentity(SERVER_VERSION),
    revision: 1,
    catalogRevision: 1,
  };
  const defaultPort = opts.port ?? state.registry.getConfig().port ?? 11435;
  const listenHost = opts.host ?? '127.0.0.1';
  const app = await createApp({
    mode: 'local',
    surface: 'local',
    state,
    watchIntervalMs: opts.watchIntervalMs,
    uiDir: opts.uiDir,
    adminPort: defaultPort,
    gatewayPort: defaultPort,
    ownsWatcher: true,
  });
  state.requestShutdown = async () => app.close();
  app.addHook('onClose', async () => removeRuntimeDescriptor(state.runtime.instanceId));
  return {
    app,
    get registry() {
      return state.registry;
    },
    listen: async (port?: number, host?: string) => {
      const url = await app.listen({ port: port ?? defaultPort, host: host ?? listenHost });
      await writeRuntimeDescriptor({
        ...state.runtime,
        port: Number(new URL(url).port),
      });
      return url;
    },
  };
}

export async function createServerRuntime(opts: ServerRuntimeOptions = {}): Promise<ServerRuntime> {
  const mode = opts.mode ?? 'local';
  if (mode === 'local') {
    const local = await createServer(opts);
    return {
      mode,
      adminApp: local.app,
      get registry() {
        return local.registry;
      },
      listen: async () => ({ adminUrl: await local.listen(opts.port, opts.host) }),
      close: async () => local.app.close(),
    };
  }

  const adminPort = opts.adminPort ?? 11435;
  const gatewayPort = opts.gatewayPort ?? 11436;
  if (adminPort === gatewayPort) throw new Error('admin port and gateway port must be different');
  if (!opts.adminOrigin) throw new Error('admin origin is required in server mode');
  if (!opts.publicUrl) throw new Error('public URL is required in server mode');
  const adminOrigin = normalizeHttpsOrigin(opts.adminOrigin, 'admin origin');
  const publicUrl = normalizeHttpsOrigin(opts.publicUrl, 'public URL');
  const registry = opts.registry ?? new ProviderRegistry(await loadConfig());
  await enforceServerGatewayAuth(registry, !opts.registry);
  const state: SharedRuntimeState = {
    registry,
    runtime: createRuntimeIdentity(SERVER_VERSION),
    revision: 1,
    catalogRevision: 1,
  };
  const adminApp = await createApp({
    mode,
    surface: 'admin',
    state,
    watchIntervalMs: opts.watchIntervalMs,
    uiDir: opts.uiDir,
    adminOrigin,
    adminPort,
    gatewayPort,
    publicUrl,
    ownsWatcher: true,
  });
  let gatewayApp: FastifyInstance;
  try {
    gatewayApp = await createApp({
      mode,
      surface: 'gateway',
      state,
      adminPort,
      gatewayPort,
      publicUrl,
      ownsWatcher: false,
    });
  } catch (error) {
    await adminApp.close();
    throw error;
  }

  return {
    mode,
    adminApp,
    gatewayApp,
    get registry() {
      return state.registry;
    },
    listen: async () => {
      let adminUrl: string;
      const listenHost = opts.host ?? '127.0.0.1';
      try {
        adminUrl = await adminApp.listen({ port: adminPort, host: listenHost });
        const gatewayUrl = await gatewayApp.listen({ port: gatewayPort, host: listenHost });
        return { adminUrl, gatewayUrl };
      } catch (error) {
        await Promise.allSettled([gatewayApp.close(), adminApp.close()]);
        throw error;
      }
    },
    close: async () => {
      await Promise.allSettled([gatewayApp.close(), adminApp.close()]);
    },
  };
}
