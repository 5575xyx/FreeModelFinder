import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  SUBSCRIPTION_ADAPTERS,
  SubscriptionRefreshError,
  getCredentialRuntime,
  redact,
  runSharedFlight,
  subscriptionFlightKey,
  updateConfig,
  type ParsedSubscription,
  type ProviderRegistry,
  type SubscriptionAccountProfile,
} from '@freemodelfinder/core';

export const SUBSCRIPTION_PROVIDERS = ['codex', 'claude', 'google'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

/** 导入文件只允许落在这几个 `~/.<dir>` 白名单目录内，防任意文件读。 */
const IMPORT_ROOT_DIRS = ['.codex', '.claude', '.gemini'] as const;

export const IMPORT_HINTS: ReadonlyArray<{ provider: SubscriptionProvider; path: string }> = [
  { provider: 'codex', path: '~/.codex/auth.json' },
  { provider: 'claude', path: '~/.claude/.credentials.json' },
  { provider: 'google', path: '~/.gemini/oauth_creds.json' },
];

function redactMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return typeof value === 'string' && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * 把 `~/...` 形式解析为绝对路径，并强制其落在 `~/.codex`、`~/.claude`、`~/.gemini`
 * 三者之一内。任何穿越（`../`）或落在白名单外的路径都返回 null（调用方回 400）。
 */
export function resolveImportPath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('~/')) return null;
  const home = resolve(homedir());
  const resolved = resolve(home, trimmed.slice(2));
  for (const dir of IMPORT_ROOT_DIRS) {
    const root = resolve(home, dir);
    if (resolved.startsWith(root + sep)) return resolved;
  }
  return null;
}

function profileFields(
  profile: SubscriptionAccountProfile | undefined,
  payload: Record<string, string>,
): { email?: string; plan?: string } {
  const email = profile?.email || payload.email || undefined;
  const plan = profile?.plan || payload.plan || undefined;
  return {
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * 未指定 provider 时按 `codex → claude → google` 顺序试解析，第一个成功者即所用平台。
 *
 * 三家的形状互斥，顺序其实无关：codex 认 `tokens.*`、claude 认 `claudeAiOauth`、
 * google 认顶层 `refresh_token` + `client_secret`，任一家的文件不会被另一家解析成功。
 */
function detectProvider(
  raw: string,
): { provider: SubscriptionProvider; parsed: ParsedSubscription } | null {
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    try {
      return { provider, parsed: SUBSCRIPTION_ADAPTERS[provider].parseImport(raw) };
    } catch {
      // 形状不对就试下一家
    }
  }
  return null;
}

interface RefreshLine {
  provider: SubscriptionProvider;
  id: string;
  ok: boolean;
  /** HTTP 语义状态：200 成功 / 404 账号不存在 / 400 致命 / 502 暂时性。 */
  status: number;
  fields?: { email?: string; plan?: string };
  error?: string;
}

/**
 * 手动刷新单个账号。
 *
 * 必须与 provider 内部的自动刷新共用同一把单飞锁：Codex 等轮换型 OAuth 下，用户点"刷新"的
 * 瞬间若恰有一次请求触发了后台刷新，同一个 refresh_token 会被发两次，上游判为
 * refresh_token_reused / invalid_grant，账号直接报废。
 */
async function refreshAccount(provider: SubscriptionProvider, id: string): Promise<RefreshLine> {
  const runtime = getCredentialRuntime();
  const adapter = SUBSCRIPTION_ADAPTERS[provider];
  try {
    const fields = await runSharedFlight(subscriptionFlightKey(provider, id), async () => {
      // 单飞只对**在途**刷新去重，settled 后立即剔除；因此锁内必须重读运行时池，
      // 否则用的是进入路由时读到的、可能已被另一次刷新消费掉的 refresh token。
      const fresh = (await runtime.getPool(provider)).accounts.find((entry) => entry.id === id);
      if (!fresh) return null;
      const result = await adapter.refresh({
        refreshToken: fresh.payload.refreshToken ?? '',
        payload: fresh.payload,
      });
      const next = profileFields(result.profile, result.payload);
      await runtime.upsertAccount(provider, {
        ...fresh,
        status: 'active',
        payload: result.payload,
        ...(next.email ? { label: next.email } : {}),
      });
      return next;
    });
    if (!fields) {
      return { provider, id, ok: false, status: 404, error: 'account not found' };
    }
    return { provider, id, ok: true, status: 200, fields };
  } catch (error) {
    if (error instanceof SubscriptionRefreshError && error.kind === 'fatal') {
      // 同样要重读后写回：拿陈旧对象 spread 会把已轮换掉的 payload 一并写回去。
      const fresh = (await runtime.getPool(provider)).accounts.find((entry) => entry.id === id);
      if (fresh) {
        await runtime.upsertAccount(provider, { ...fresh, status: 'invalid' });
      }
      return { provider, id, ok: false, status: 400, error: redactMessage(error) };
    }
    return { provider, id, ok: false, status: 502, error: redactMessage(error) };
  }
}

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  getRegistry: () => ProviderRegistry,
): void {
  app.get('/api/subscription/import-hints', async () => IMPORT_HINTS);

  app.get('/api/subscription/credentials', async () => {
    const runtime = getCredentialRuntime();
    const accounts: Array<Record<string, unknown>> = [];
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      const pool = await runtime.getPool(provider);
      const usage = new Map(
        runtime.snapshotUsage(provider).map((entry) => [entry.accountId, entry]),
      );
      for (const account of pool.accounts) {
        const stats = usage.get(account.id);
        const extra = profileFields(undefined, account.payload);
        accounts.push({
          provider,
          id: account.id,
          label: account.label ?? account.id,
          ...extra,
          status: account.status,
          addedAt: account.addedAt,
          ...(account.payload.expiresAt ? { expiresAt: account.payload.expiresAt } : {}),
          cooldowns: runtime.listAccountCooldowns(provider, account.id),
          usage: {
            requests: stats?.requests ?? 0,
            promptTokens: stats?.promptTokens ?? 0,
            completionTokens: stats?.completionTokens ?? 0,
            ...(stats?.lastError !== undefined ? { lastError: stats.lastError } : {}),
          },
        });
      }
    }
    return { accounts };
  });

  app.post<{ Querystring: { provider?: string }; Body: { raw?: string; path?: string } }>(
    '/api/subscription/credentials',
    async (req, reply) => {
      const body = req.body ?? {};
      const rawPresent = typeof body.raw === 'string' && body.raw.length > 0;
      const pathPresent = typeof body.path === 'string' && body.path.trim().length > 0;
      if (rawPresent === pathPresent) {
        return reply.code(400).send({ error: 'exactly one of raw or path is required' });
      }

      const providerParam = req.query.provider;
      if (providerParam !== undefined && !isSubscriptionProvider(providerParam)) {
        return reply.code(400).send({ error: `unknown provider: ${providerParam}` });
      }

      let content: string;
      if (rawPresent) {
        content = body.raw as string;
      } else {
        const resolved = resolveImportPath(body.path as string);
        if (!resolved) {
          return reply
            .code(400)
            .send({ error: 'path must point inside ~/.codex, ~/.claude or ~/.gemini' });
        }
        try {
          content = await readFile(resolved, 'utf8');
        } catch (error) {
          return reply.code(400).send({ error: redactMessage(error) });
        }
      }

      let provider: SubscriptionProvider;
      let parsed: ParsedSubscription;
      if (providerParam !== undefined) {
        provider = providerParam;
        try {
          parsed = SUBSCRIPTION_ADAPTERS[provider].parseImport(content);
        } catch (error) {
          return reply.code(400).send({ error: redactMessage(error) });
        }
      } else {
        const detected = detectProvider(content);
        if (!detected) {
          return reply
            .code(400)
            .send({ error: 'could not detect the provider from the supplied credential' });
        }
        provider = detected.provider;
        parsed = detected.parsed;
      }

      const fields = profileFields(parsed.profile, parsed.payload);
      const id = SUBSCRIPTION_ADAPTERS[provider].accountIdOf(parsed.profile, parsed.payload);
      const label = fields.email ?? id;
      // getProvider 的第一道闸门是 config.providers.<id>.enabled，而三家订阅 provider 在
      // store.ts 里默认关闭、设置页也不含它们的开关。不在这儿启用的话，"导入成功"之后
      // /v1/models 不列出订阅模型、auto 选不到、显式 codex:… 一律抛 "provider codex is not
      // enabled" —— 整个功能等于没接上。
      // 先启用再落账号：listEnabledProviders 会用 hasCredentials() 过滤，尚无账号的 provider
      // 不会往 /v1/models 里塞用不了的模型，所以这个顺序没有副作用窗口。
      const next = await updateConfig((cfg) => {
        const current = cfg.providers[provider] ?? { enabled: false };
        cfg.providers[provider] = { ...current, enabled: true };
        return cfg;
      });
      // 磁盘写入只是必要条件：/v1/models、auto 与显式 codex:… 全部经由 registry.getProvider，
      // 而它读的是内存 this.config。不同步的话，导入后仍要等 1 小时的配置 watcher 或重启才
      // 真正可用 —— 正是上面启用 provider 想消除的症状。这里不 preserveModels：改动的正是
      // provider 拓扑，需要让新 provider 的模型目录在下一次刷新时被纳入。
      getRegistry().updateConfig(next);
      await getCredentialRuntime().upsertAccount(provider, {
        id,
        status: 'active',
        addedAt: Date.now(),
        label,
        payload: parsed.payload,
      });
      return reply.send({ ok: true, account: { provider, id, ...fields } });
    },
  );

  app.delete<{ Querystring: { provider?: string; id?: string } }>(
    '/api/subscription/credentials',
    async (req, reply) => {
      const providerParam = req.query.provider ?? '';
      const id = req.query.id ?? '';
      if (!isSubscriptionProvider(providerParam)) {
        return reply.code(400).send({ error: `unknown provider: ${providerParam}` });
      }
      const provider = providerParam;
      const runtime = getCredentialRuntime();
      const pool = await runtime.getPool(provider);
      if (!pool.accounts.some((entry) => entry.id === id)) {
        return reply.code(404).send({ error: 'account not found' });
      }
      await runtime.removeAccount(provider, id);
      return reply.send({ ok: true });
    },
  );

  app.post<{ Body: { provider?: string; id?: string; all?: boolean } }>(
    '/api/subscription/credentials/refresh',
    async (req, reply) => {
      const body = req.body ?? {};

      // 对齐参考项目 `POST /credentials/refresh`：`{all:true}` 返回 {ok, results}，
      // 单条返回 {ok, auth}。这里单条返回 {ok, account}，与本文件其余端点保持一致。
      if (body.all === true) {
        if (body.provider !== undefined && !isSubscriptionProvider(body.provider)) {
          return reply.code(400).send({ error: `unknown provider: ${body.provider}` });
        }
        const providers: SubscriptionProvider[] =
          body.provider === undefined ? [...SUBSCRIPTION_PROVIDERS] : [body.provider];
        const results: Array<Record<string, unknown>> = [];
        for (const provider of providers) {
          const pool = await getCredentialRuntime().getPool(provider);
          for (const account of pool.accounts) {
            const line = await refreshAccount(provider, account.id);
            results.push({
              provider: line.provider,
              id: line.id,
              ok: line.ok,
              ...(line.fields ?? {}),
              ...(line.error ? { error: line.error } : {}),
            });
          }
        }
        return reply.send({ ok: true, results });
      }

      if (!isSubscriptionProvider(body.provider)) {
        return reply.code(400).send({ error: `unknown provider: ${body.provider ?? ''}` });
      }
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) {
        return reply.code(400).send({ error: 'id or all=true is required' });
      }

      const line = await refreshAccount(body.provider, id);
      if (!line.ok) {
        return reply.code(line.status).send({ error: line.error ?? 'refresh failed' });
      }
      return reply.send({
        ok: true,
        account: { provider: line.provider, id: line.id, ...(line.fields ?? {}) },
      });
    },
  );
}
