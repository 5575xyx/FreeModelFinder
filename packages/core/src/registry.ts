import { loadConfig } from './config/store.js';
import { loadSnapshot, type ModelSnapshot } from './config/snapshot.js';
import { getCredentialRuntime, type CredentialRuntime } from './credentials/runtime.js';
import { modelsDevContextStore } from './models-dev-context.js';
import {
  BaseProvider,
  CohereProvider,
  CustomProvider,
  GeminiProvider,
  GitHubModelsProvider,
  HuggingFaceProvider,
  ModelScopeProvider,
  NvidiaProvider,
  OpenRouterProvider,
  QianfanProvider,
  SenseNovaProvider,
  SiliconFlowProvider,
  ZhipuProvider,
  KiloProvider,
  AgnesProvider,
  AgnesIntlProvider,
  ClineProvider,
  ZenProvider,
} from './providers/index.js';
import type { ProviderContext } from './providers/base.js';
import { QuotaTracker } from './quota.js';
import { emitUsageCapture } from './call-logger.js';
import {
  AutoRouter,
  parseRateLimitError,
  resetStickyStore,
  scoreModel,
} from './router/auto-router.js';
import { retryOnQueueFull, type RetryOnQueueFullOptions } from './queue-retry.js';
import { composeModelId, bareModelId } from './model-id.js';
import { parseModelProfile } from './model-tier.js';
import type {
  AppConfig,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelInfo,
  ModelQuotaSnapshot,
  ProviderId,
  SwitchNotice,
  VideoGenerationRequest,
  VideoGenerationResponse,
} from './types.js';

const PROVIDER_CTORS: Record<
  Exclude<ProviderId, 'ollama'>,
  new (ctx: ProviderContext) => BaseProvider
> = {
  openrouter: OpenRouterProvider,
  gemini: GeminiProvider,
  zhipu: ZhipuProvider,
  siliconflow: SiliconFlowProvider,
  modelscope: ModelScopeProvider,
  nvidia: NvidiaProvider,
  github: GitHubModelsProvider,
  cohere: CohereProvider,
  huggingface: HuggingFaceProvider,
  sensenova: SenseNovaProvider,
  qianfan: QianfanProvider,
  kilo: KiloProvider,
  agnes: AgnesProvider,
  'agnes-intl': AgnesIntlProvider,
  custom: CustomProvider,
  cline: ClineProvider,
  opencode: ZenProvider,
};

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Per-provider ceiling for one catalog refresh.
 *
 * `listModels()` uses the raw `fetch`, which carries no application timeout, so
 * a single upstream that accepts the connection and then goes quiet (a
 * blackholed route — routine when a mainland host reaches overseas providers)
 * would pin the whole fan-out until undici's ~5 minute default. A model page
 * that hangs that long reads as "empty / loading forever". Past this window the
 * provider is reported failed and its last known models are served from the
 * snapshot instead.
 */
const PROVIDER_LIST_TIMEOUT_MS = 20_000;

/** Reject `promise` once `ms` elapse. `label` is surfaced in failedProviders. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Every provider id that may prefix a composed model id (ollama has no ctor). */
const PROVIDER_PREFIXES: ReadonlySet<string> = new Set<string>([
  ...(Object.keys(PROVIDER_CTORS) as string[]),
  'ollama',
]);

export function resetAutoPoolCursor(): void {
  resetStickyStore();
}

/**
 * Drop a leading "<provider>:" segment so composed and bare ids compare equal.
 *
 * Only a segment that is actually a known provider id is stripped. A custom
 * source model is a provider-native two-segment id ("<source>:<model>") whose
 * first segment is the source, NOT a provider; it must survive untouched or it
 * can never reconcile with the composed "custom:<source>:<model>" form the UI
 * alias picker emits.
 */
function stripProviderPrefix(id: string): string {
  const sep = id.indexOf(':');
  if (sep <= 0) return id;
  return PROVIDER_PREFIXES.has(id.slice(0, sep)) ? id.slice(sep + 1) : id;
}

/** Longest alias chain we will walk; backstop for a hand-edited config.json. */
const MAX_ALIAS_HOPS = 16;

/**
 * Own-property alias lookup.
 *
 * config.json is hand-editable and bypasses validateModelAliases, so a plain
 * `table[key]` would resolve inherited Object.prototype members ("toString"
 * returns a function) and a non-string value would flow straight into string
 * methods. Both surface as a TypeError deep inside resolveModel — a 500 for a
 * request that should have been routed or rejected with 400.
 */
function lookupAlias(
  aliases: Record<string, string> | undefined,
  alias: string,
): string | undefined {
  if (!aliases || alias in Object.prototype) return undefined;
  const target = Object.hasOwn(aliases, alias) ? aliases[alias] : undefined;
  return typeof target === 'string' && target.length > 0 ? target : undefined;
}

export interface RegistryOptions {
  config?: AppConfig;
}

export interface ListAllModelsResult {
  models: ModelInfo[];
  succeededProviders: ProviderId[];
  failedProviders: { id: ProviderId; error: string }[];
}

export class ProviderRegistry {
  private instances = new Map<ProviderId, BaseProvider>();
  private modelsCache: ListAllModelsResult | null = null;
  private cacheAt = 0;
  /** Shared in-flight refresh so concurrent callers fan out to providers once. */
  private modelsInflight: Promise<ListAllModelsResult> | null = null;
  /** Bumped by updateConfig so a refresh started under the old config cannot backfill the new cache. */
  private refreshGeneration = 0;
  private autoRouter: AutoRouter;
  private quotaTracker = new QuotaTracker();
  private noticeBuffer: SwitchNotice[] = [];
  private warmPromise: Promise<void> | null = null;

  constructor(
    private config: AppConfig,
    private readonly loadModelSnapshot: () => Promise<ModelSnapshot> = loadSnapshot,
    private readonly queueRetry: RetryOnQueueFullOptions = {},
    private readonly credentialRuntime?: CredentialRuntime,
    private readonly providerListTimeoutMs: number = PROVIDER_LIST_TIMEOUT_MS,
  ) {
    this.autoRouter = new AutoRouter({
      getSettings: () => this.config.autoRoute,
      listAllModels: async () => (await this.listAllModels()).models,
      onNotice: (n) => {
        this.noticeBuffer.push(n);
        if (this.noticeBuffer.length > 50) this.noticeBuffer.shift();
      },
    });
  }

  static async load(): Promise<ProviderRegistry> {
    const config = await loadConfig();
    const registry = new ProviderRegistry(config);
    await registry.warmCredentials().catch(() => undefined);
    return registry;
  }

  async warmCredentials(): Promise<void> {
    if (!this.config.providers.cline?.enabled) return;
    if (!this.warmPromise) {
      const runtime = this.credentialRuntimeFor('cline');
      if (!runtime) return;
      const promise = runtime.getPool('cline').then(() => undefined);
      this.warmPromise = promise;
      void promise.catch(() => {
        if (this.warmPromise === promise) this.warmPromise = null;
      });
    }
    return this.warmPromise;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getAutoRouter(): AutoRouter {
    return this.autoRouter;
  }

  /**
   * Forward alias lookup: external name -> real model id. Returns the input
   * untouched when no alias matches. Route handlers call this BEFORE preflight
   * so cooldown tables stay keyed by the real model id.
   */
  resolveAlias(modelId: string): string {
    return lookupAlias(this.config.modelAliases, modelId) ?? modelId;
  }

  /**
   * Reverse lookup used for the client-facing name in /v1/models and in
   * response payloads. Matching is done on the provider-stripped id because
   * the catalog stores bare ids for OpenAI-compatible providers but composed
   * ids for OpenCode/Cline, while response payloads are always composed.
   */
  toClientFacingModel(realId: string): string {
    const aliases = this.config.modelAliases;
    if (!aliases) return realId;
    const bare = stripProviderPrefix(realId);
    let fallback: string | undefined;
    for (const [alias, target] of Object.entries(aliases)) {
      // Hand-edited configs may hold non-string values; skip them instead of
      // letting them reach string methods below.
      if (typeof target !== 'string') continue;
      // An exact hit is unambiguous; a bare match can collide across providers,
      // so it is only a fallback.
      if (target === realId) return alias;
      if (fallback === undefined && stripProviderPrefix(target) === bare) fallback = alias;
    }
    return fallback ?? realId;
  }

  drainNotices(): SwitchNotice[] {
    const out = this.noticeBuffer;
    this.noticeBuffer = [];
    return out;
  }

  peekNotices(): SwitchNotice[] {
    return [...this.noticeBuffer];
  }

  updateConfig(next: AppConfig, options: { preserveModels?: boolean } = {}): void {
    this.config = next;
    if (!options.preserveModels) {
      for (const instance of this.instances.values()) {
        // Dropping the instance must also stop whatever it scheduled: a
        // provider with background timers would otherwise keep them running for
        // the rest of the process lifetime.
        try {
          instance.dispose?.();
        } catch {
          // A failing teardown must not prevent the new config from taking over.
        }
      }
      this.instances.clear();
      this.modelsCache = null;
      // Abandon any refresh started under the previous config: its provider
      // instances are being torn down above, and its result must not repopulate
      // the cache we just invalidated.
      this.modelsInflight = null;
      this.refreshGeneration += 1;
    }
  }

  getProvider(id: ProviderId): BaseProvider {
    const cached = this.instances.get(id);
    if (cached) return cached;

    const settings = this.config.providers[id];
    if (!settings?.enabled) {
      throw new Error(`provider ${id} is not enabled`);
    }
    if (id === 'ollama') {
      if (!settings.credentials?.apiKey && !settings.credentials?.apiKeys?.length) {
        throw new Error(`provider ${id} is missing api key`);
      }
      throw new Error('ollama provider not yet implemented');
    }
    const instance = this.instantiate(id);
    if (instance.hasCredentials) {
      if (!instance.hasCredentials()) {
        throw new Error(`provider ${id} has no available credentials`);
      }
      return instance;
    }
    if (
      id !== 'custom' &&
      !settings.credentials?.apiKey &&
      !settings.credentials?.apiKeys?.length
    ) {
      throw new Error(`provider ${id} is missing api key`);
    }
    return instance;
  }

  private instantiate(id: ProviderId): BaseProvider {
    const cached = this.instances.get(id);
    if (cached) return cached;
    const settings = this.config.providers[id];
    const Ctor = PROVIDER_CTORS[id as Exclude<ProviderId, 'ollama'>];
    const instance = new Ctor({
      credentials: settings?.credentials ?? { apiKey: '' },
      credentialRuntime: this.credentialRuntimeFor(id),
      dynamicModels: settings?.dynamicModels,
      onResponse: (event) => this.quotaTracker.recordResponse(event),
      onUsage: (event) => {
        this.quotaTracker.recordUsage(event);
        emitUsageCapture(event.usage);
      },
      onQuotaWindows: (event) =>
        this.quotaTracker.recordProviderWindows(event.provider, event.windows),
    });
    this.instances.set(id, instance);
    return instance;
  }

  private credentialRuntimeFor(id: ProviderId): CredentialRuntime | undefined {
    if (this.credentialRuntime) return this.credentialRuntime;
    if (id === 'cline') return getCredentialRuntime();
    return undefined;
  }

  listEnabledProviders(): ProviderId[] {
    return (Object.keys(PROVIDER_CTORS) as Array<Exclude<ProviderId, 'ollama'>>).filter((id) => {
      const settings = this.config.providers[id];
      if (!settings?.enabled) return false;
      if (id === 'custom') {
        const extra = (settings.credentials?.extra ?? {}) as {
          sources?: unknown;
          models?: unknown;
        };
        const hasSources = Array.isArray(extra.sources) && extra.sources.length > 0;
        const hasLegacy = !!settings.credentials?.baseUrl;
        return hasSources || hasLegacy;
      }
      const ctor = PROVIDER_CTORS[id];
      if (typeof ctor.prototype.hasCredentials === 'function') {
        try {
          return this.instantiate(id).hasCredentials?.() ?? false;
        } catch {
          return false;
        }
      }
      return !!settings.credentials?.apiKey;
    });
  }

  async listAllModels(
    force = false,
    opts: { revalidate?: boolean } = {},
  ): Promise<ListAllModelsResult> {
    if (!force && this.hasFreshModelsCache()) {
      return this.modelsCache!;
    }
    // Stale-while-revalidate: with any catalog in hand, answer immediately and
    // refresh in the background. A stalled upstream must not leave the model
    // page blank while the refresh is still in flight. Callers that must not
    // act on an older catalog (the snapshot watcher) pass `revalidate` to await
    // the refresh instead of being handed stale data.
    if (!force && this.modelsCache && !opts.revalidate) {
      void this.refreshModelsOnce().catch(() => undefined);
      return this.modelsCache;
    }
    return this.refreshModelsOnce();
  }

  private hasFreshModelsCache(): boolean {
    return this.modelsCache !== null && Date.now() - this.cacheAt < MODELS_CACHE_TTL_MS;
  }

  /** Run (or join) the single in-flight provider fan-out. */
  private refreshModelsOnce(): Promise<ListAllModelsResult> {
    if (this.modelsInflight) return this.modelsInflight;
    const run = this.refreshModels().finally(() => {
      if (this.modelsInflight === run) this.modelsInflight = null;
    });
    this.modelsInflight = run;
    return run;
  }

  private async refreshModels(): Promise<ListAllModelsResult> {
    const generation = this.refreshGeneration;
    await this.warmCredentials().catch(() => undefined);
    const enabled = this.listEnabledProviders();
    const timeoutMs = this.providerListTimeoutMs;
    // Warm the models.dev context table alongside the provider fan-out: the
    // disk read then costs the listing nothing, and the lookup below stays a
    // synchronous memory hit. models.dev itself refreshes in the background —
    // a model listing must never wait on it.
    const contextStore = modelsDevContextStore();
    const contextWarm = contextStore.ensureFresh();
    const results = await Promise.allSettled(
      enabled.map((id) =>
        withTimeout(
          Promise.resolve().then(() => this.getProvider(id).listModels()),
          timeoutMs,
          `${id} listModels`,
        ),
      ),
    );
    const models: ModelInfo[] = [];
    const succeededProviders: ProviderId[] = [];
    const failedProviders: { id: ProviderId; error: string }[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const id = enabled[i]!;
      if (r.status === 'fulfilled') {
        succeededProviders.push(id);
        models.push(
          ...r.value.filter(
            (model) =>
              model.free === true && typeof model.id === 'string' && model.id.trim().length > 0,
          ),
        );
      } else {
        const err = r.reason;
        failedProviders.push({
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (failedProviders.length > 0) {
      const failed = new Set(failedProviders.map((provider) => provider.id));
      const snapshot = await this.loadModelSnapshot();
      for (const model of snapshot.models) {
        if (failed.has(model.provider)) models.push(model);
      }
    }
    await contextWarm;
    // Backfill only what the provider left undefined: an upstream that published
    // context_length is authoritative, models.dev is a fallback for the ones
    // that publish nothing (Cline's list carries no context_length at all).
    for (const model of models) {
      if (model.contextWindow !== undefined) continue;
      const ctx = contextStore.lookup(model);
      if (ctx !== undefined) model.contextWindow = ctx;
    }
    const deduped = new Map<string, ModelInfo>();
    for (const model of models) {
      deduped.set(composeModelId(model.provider, model.id).toLowerCase(), model);
    }
    const result: ListAllModelsResult = {
      models: [...deduped.values()],
      succeededProviders,
      failedProviders,
    };
    if (generation === this.refreshGeneration) {
      this.modelsCache = result;
      this.cacheAt = Date.now();
    }
    return result;
  }

  /**
   * Local-only model catalog for UI pickers.
   * Uses in-memory cache when fresh; otherwise reads snapshot from disk.
   * Never calls provider listModels().
   */
  async peekLocalModels(): Promise<ModelInfo[]> {
    if (this.hasFreshModelsCache()) {
      return [...this.modelsCache!.models];
    }
    const snapshot = await this.loadModelSnapshot();
    return snapshot.models.map((m) => ({
      id: m.id,
      provider: m.provider,
      displayName: m.displayName,
      free: m.free,
    }));
  }

  getModelQuota(provider: ProviderId, model: string): ModelQuotaSnapshot {
    return this.quotaTracker.snapshot(provider, model);
  }

  listModelQuotas(models: ModelInfo[]): ModelQuotaSnapshot[] {
    return models.map((model) => this.getModelQuota(model.provider, model.id));
  }

  async probeModel(model: string): Promise<ModelQuotaSnapshot> {
    const resolved = this.resolveModel(model);
    const startedAt = Date.now();
    try {
      await resolved.provider.chat({
        model: resolved.modelId,
        messages: [{ role: 'user', content: 'Reply with only: OK' }],
        max_tokens: 8,
        stream: false,
      });
      this.quotaTracker.recordTest(resolved.provider.id, resolved.modelId, {
        ok: true,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const parsed = parseRateLimitError(error);
      this.quotaTracker.recordTest(resolved.provider.id, resolved.modelId, {
        ok: false,
        limited: parsed.isRateLimit,
        latencyMs: Date.now() - startedAt,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
    return this.getModelQuota(resolved.provider.id, resolved.modelId);
  }

  resolveModel(
    modelId: string,
    opts?: {
      inputTokens?: number;
      sessionKey?: string;
      onPick?: (info: { sticky: boolean; pool: string[] }) => void;
      /**
       * Restricted composed model ids for the caller (a gateway key's
       * allowlist), or null/undefined for an unrestricted caller. `auto` only
       * ever picks from this set, so a restricted key can never be served a
       * model outside its list.
       */
      allowed?: Set<string> | null;
    },
  ): { provider: BaseProvider; modelId: string; sticky?: boolean } {
    return this.resolveModelWithAlias(modelId, opts, 0);
  }

  private resolveModelWithAlias(
    modelId: string,
    opts:
      | {
          inputTokens?: number;
          sessionKey?: string;
          onPick?: (info: { sticky: boolean; pool: string[] }) => void;
          allowed?: Set<string> | null;
        }
      | undefined,
    aliasHops: number,
  ): { provider: BaseProvider; modelId: string; sticky?: boolean } {
    if (modelId === 'auto' || modelId === 'default') {
      if (modelId === 'default') {
        const preferred = this.config.defaultModel;
        if (preferred && preferred !== 'auto' && preferred !== 'default') {
          return this.resolveModelWithAlias(preferred, opts, aliasHops + 1);
        }
      }
      const enabled = this.listEnabledProviders();
      if (enabled.length === 0) {
        throw new Error('no provider is configured; add an API key in Settings first');
      }
      if (modelId === 'auto') {
        const picked = this.pickAutoModel(opts);
        if (picked) return picked;
        // A restricted caller must NOT fall through to the first catalog model:
        // pickAutoModel returns null when the allowlist admits nothing, and the
        // unconstrained fallback below would bypass the list with a 200.
        if (opts?.allowed) {
          throw new Error(
            `no model in this API key's allowed list is available ` +
              `(allowed: ${[...opts.allowed].join(', ') || 'empty'})`,
          );
        }
      }
      const cached = this.modelsCache?.models;
      if (cached && cached.length > 0) {
        const first = cached[0]!;
        return {
          provider: this.getProvider(first.provider),
          modelId: bareModelId(first.provider, first.id),
        };
      }
      throw new Error(
        'no model available for `auto`; wait for /v1/models to load or set a default model',
      );
    }
    const aliased = lookupAlias(this.config.modelAliases, modelId);
    if (aliased !== undefined && aliased !== modelId) {
      if (aliasHops >= MAX_ALIAS_HOPS) {
        throw new Error(`alias "${modelId}" is part of an alias cycle or an over-long chain`);
      }
      return this.resolveModelWithAlias(aliased, opts, aliasHops + 1);
    }
    const sep = modelId.indexOf(':');
    if (sep > 0) {
      const providerId = modelId.slice(0, sep) as ProviderId;
      const real = modelId.slice(sep + 1);
      if (PROVIDER_CTORS[providerId as Exclude<ProviderId, 'ollama'>]) {
        return { provider: this.getProvider(providerId), modelId: bareModelId(providerId, real) };
      }
    }
    // Bare custom source id ("cpa:Qwen3.8-27B"): if the first segment is a
    // known custom source id, route to the custom provider verbatim.
    if (sep > 0) {
      const sourceId = modelId.slice(0, sep);
      const extra = this.config.providers.custom?.credentials?.extra as
        { sources?: Array<{ id?: unknown }> } | undefined;
      if (Array.isArray(extra?.sources) && extra!.sources!.some((s) => s?.id === sourceId)) {
        try {
          return { provider: this.getProvider('custom'), modelId };
        } catch {
          // custom provider not enabled/usable; fallthrough
        }
      }
    }
    // heuristic
    if (
      modelId.startsWith('cline-free/') ||
      modelId.startsWith('cline/') ||
      modelId.startsWith('cline-pass/')
    ) {
      try {
        return { provider: this.getProvider('cline'), modelId };
      } catch {
        // fallthrough
      }
    }
    if (modelId.startsWith('gemini') || modelId.startsWith('models/gemini')) {
      return { provider: this.getProvider('gemini'), modelId: modelId.replace(/^models\//, '') };
    }
    if (
      modelId.startsWith('SenseChat') ||
      modelId.startsWith('sensenova') ||
      modelId === 'deepseek-v4-flash' ||
      modelId === 'glm-5.2'
    ) {
      try {
        return { provider: this.getProvider('sensenova'), modelId };
      } catch {
        // fallthrough
      }
    }
    if (modelId.startsWith('glm-')) {
      try {
        return { provider: this.getProvider('zhipu'), modelId };
      } catch {
        // fallthrough
      }
    }
    if (modelId.toLowerCase().startsWith('ernie')) {
      try {
        return { provider: this.getProvider('qianfan'), modelId };
      } catch {
        // fallthrough
      }
    }
    if (modelId.startsWith('qwen') || modelId.startsWith('Qwen/')) {
      try {
        return { provider: this.getProvider('siliconflow'), modelId };
      } catch {
        // fallthrough
      }
    }
    if (modelId.startsWith('deepseek') || modelId.startsWith('deepseek-ai/')) {
      try {
        return { provider: this.getProvider('sensenova'), modelId };
      } catch {
        try {
          return { provider: this.getProvider('modelscope'), modelId };
        } catch {
          // fallthrough
        }
      }
    }
    if (modelId.startsWith('kilo:')) {
      try {
        return { provider: this.getProvider('kilo'), modelId: modelId.slice(5) };
      } catch {
        // fallthrough
      }
    }
    if (modelId.startsWith('agnes:')) {
      try {
        return { provider: this.getProvider('agnes'), modelId: modelId.slice(6) };
      } catch {
        // fallthrough
      }
    }
    if (modelId.startsWith('command-') || modelId.startsWith('c4ai-')) {
      try {
        return { provider: this.getProvider('cohere'), modelId };
      } catch {
        // fallthrough
      }
    }
    // Catalog lookup: an id published by /v1/models must be requestable by
    // exactly that id. The heuristics above only cover well-known name prefixes,
    // so without this an id such as nvidia/nemotron-… reached the openrouter
    // fallthrough below, was re-composed as openrouter:nvidia/… and then failed
    // the caller's allowlist as "model not allowed" for a model that was on it.
    const catalog = this.modelsCache?.models;
    if (catalog) {
      const hit = catalog.find((m) => m.id === modelId);
      if (hit) {
        try {
          return {
            provider: this.getProvider(hit.provider),
            modelId: bareModelId(hit.provider, hit.id),
          };
        } catch {
          // that provider is not enabled; keep falling through
        }
      }
    }

    // default to openrouter
    return { provider: this.getProvider('openrouter'), modelId };
  }

  private buildFallbackChain(inputTokens?: number, allowed?: Set<string> | null): ModelInfo[] {
    const cached = this.modelsCache?.models;
    if (!cached || cached.length === 0) return [];
    const strategy = this.autoRouter.getStrategy();
    const cooling = (m: ModelInfo): boolean => {
      if (this.autoRouter.isProviderRateLimited(m.provider)) return true;
      if (
        this.autoRouter.isRateLimited(bareModelId(m.provider, m.id)) ||
        this.autoRouter.isRateLimited(composeModelId(m.provider, m.id))
      ) {
        return true;
      }
      return false;
    };
    // Allowlists hold composed ids while the catalog keeps provider-native ids,
    // so the composed form has to be built before the comparison.
    const admitted = allowed
      ? cached.filter((m) => allowed.has(composeModelId(m.provider, m.id).toLowerCase()))
      : cached;
    const alive = admitted.filter((m) => !cooling(m));
    const poolable = (m: ModelInfo): boolean => {
      if (inputTokens === undefined) return true;
      if (!m.contextWindow || m.contextWindow <= 0) return true;
      return inputTokens <= m.contextWindow * 0.95;
    };
    let eligible = alive.filter(poolable);
    const relaxed = eligible.length === 0 && alive.length > 0;
    if (relaxed) eligible = alive;
    if (eligible.length === 0) return [];
    const scored = eligible
      .map((m) => ({
        m,
        s: scoreModel(m, strategy, this.autoRouter.getProfile(m.id)),
        g: parseModelProfile(m.id).generation,
      }))
      .sort((a, b) => {
        if (relaxed) {
          const byWindow = (b.m.contextWindow ?? 0) - (a.m.contextWindow ?? 0);
          if (byWindow !== 0) return byWindow;
        }
        return (
          b.s - a.s ||
          (b.g ?? Number.NEGATIVE_INFINITY) - (a.g ?? Number.NEGATIVE_INFINITY) ||
          a.m.id.localeCompare(b.m.id)
        );
      });
    const seats = new Map<ProviderId, number>();
    const chain: ModelInfo[] = [];
    for (const row of scored) {
      const used = seats.get(row.m.provider) ?? 0;
      if (used >= 2) continue;
      seats.set(row.m.provider, used + 1);
      chain.push(row.m);
      if (chain.length >= 5) break;
    }
    return chain;
  }

  private pickAutoModel(opts?: {
    inputTokens?: number;
    sessionKey?: string;
    onPick?: (info: { sticky: boolean; pool: string[] }) => void;
    allowed?: Set<string> | null;
  }): { provider: BaseProvider; modelId: string; sticky?: boolean } | null {
    const chain = this.buildFallbackChain(opts?.inputTokens, opts?.allowed);
    if (chain.length === 0) return null;
    const pool = chain.map((m) => composeModelId(m.provider, m.id));
    const key = opts?.sessionKey;
    if (key) {
      const sticky = this.autoRouter.getSticky(key);
      if (sticky) {
        const hit = chain.find(
          (m) => m.provider === sticky.provider && bareModelId(m.provider, m.id) === sticky.modelId,
        );
        if (hit) {
          opts?.onPick?.({ sticky: true, pool });
          return {
            provider: this.getProvider(hit.provider),
            modelId: bareModelId(hit.provider, hit.id),
            sticky: true,
          };
        }
        this.autoRouter.clearSticky(key);
      }
    }
    const head = chain[0]!;
    const modelId = bareModelId(head.provider, head.id);
    opts?.onPick?.({ sticky: false, pool });
    if (key) {
      this.autoRouter.setSticky(key, head.provider, modelId);
      return { provider: this.getProvider(head.provider), modelId, sticky: false };
    }
    return { provider: this.getProvider(head.provider), modelId };
  }

  async generateImage(
    req: ImageGenerationRequest,
  ): Promise<{ provider: BaseProvider; response: ImageGenerationResponse }> {
    const { provider, modelId } = this.resolveModel(req.model);
    if (!provider.generateImage) {
      throw new Error(`Provider ${provider.id} does not support image generation`);
    }
    const generateImage = provider.generateImage.bind(provider);
    const response = await retryOnQueueFull(
      () => generateImage({ ...req, model: modelId }),
      this.queueRetry,
    );
    return { provider, response };
  }

  async generateVideo(
    req: VideoGenerationRequest,
  ): Promise<{ provider: BaseProvider; response: VideoGenerationResponse }> {
    const { provider, modelId } = this.resolveModel(req.model);
    if (!provider.generateVideo) {
      throw new Error(`Provider ${provider.id} does not support video generation`);
    }
    const generateVideo = provider.generateVideo.bind(provider);
    const response = await retryOnQueueFull(
      () => generateVideo({ ...req, model: modelId }),
      this.queueRetry,
    );
    return { provider, response };
  }

  async queryVideoStatus(
    videoId: string,
    providerId: string,
  ): Promise<{ provider: BaseProvider; response: VideoGenerationResponse }> {
    const provider = this.getProvider(providerId as ProviderId);
    if (!provider.queryVideoStatus) {
      throw new Error(`Provider ${providerId} does not support video status queries`);
    }
    const response = await provider.queryVideoStatus(videoId);
    return { provider, response };
  }
}
