import { loadConfig } from './config/store.js';
import { loadSnapshot, type ModelSnapshot } from './config/snapshot.js';
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
  SenseNovaProvider,
  SiliconFlowProvider,
  ZhipuProvider,
  KiloProvider,
  AgnesProvider,
  AgnesIntlProvider,
} from './providers/index.js';
import type { ProviderContext } from './providers/base.js';
import { QuotaTracker } from './quota.js';
import { emitUsageCapture } from './call-logger.js';
import { AutoRouter, parseRateLimitError, scoreModel } from './router/auto-router.js';
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
  kilo: KiloProvider,
  agnes: AgnesProvider,
  'agnes-intl': AgnesIntlProvider,
  custom: CustomProvider,
};

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

let autoPoolCursor = 0;

export function resetAutoPoolCursor(): void {
  autoPoolCursor = 0;
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
  private autoRouter: AutoRouter;
  private quotaTracker = new QuotaTracker();
  private noticeBuffer: SwitchNotice[] = [];

  constructor(
    private config: AppConfig,
    private readonly loadModelSnapshot: () => Promise<ModelSnapshot> = loadSnapshot,
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
    return new ProviderRegistry(config);
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getAutoRouter(): AutoRouter {
    return this.autoRouter;
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
      this.instances.clear();
      this.modelsCache = null;
    }
  }

  getProvider(id: ProviderId): BaseProvider {
    const cached = this.instances.get(id);
    if (cached) return cached;

    const settings = this.config.providers[id];
    if (!settings?.enabled) {
      throw new Error(`provider ${id} is not enabled`);
    }
    if (
      id !== 'custom' &&
      !settings.credentials?.apiKey &&
      !settings.credentials?.apiKeys?.length
    ) {
      throw new Error(`provider ${id} is missing api key`);
    }
    if (id === 'ollama') {
      throw new Error('ollama provider not yet implemented');
    }
    const Ctor = PROVIDER_CTORS[id];
    const credentials = settings.credentials ?? { apiKey: '' };
    const instance = new Ctor({
      credentials,
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
      return !!settings.credentials?.apiKey;
    });
  }

  async listAllModels(force = false): Promise<ListAllModelsResult> {
    if (!force && this.modelsCache && Date.now() - this.cacheAt < MODELS_CACHE_TTL_MS) {
      return this.modelsCache;
    }
    const enabled = this.listEnabledProviders();
    const results = await Promise.allSettled(
      enabled.map(async (id) => this.getProvider(id).listModels()),
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
    const deduped = new Map<string, ModelInfo>();
    for (const model of models) {
      deduped.set(`${model.provider}:${model.id}`.toLowerCase(), model);
    }
    const result: ListAllModelsResult = {
      models: [...deduped.values()],
      succeededProviders,
      failedProviders,
    };
    this.modelsCache = result;
    this.cacheAt = Date.now();
    return result;
  }

  /**
   * Local-only model catalog for UI pickers.
   * Uses in-memory cache when fresh; otherwise reads snapshot from disk.
   * Never calls provider listModels().
   */
  async peekLocalModels(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.cacheAt < MODELS_CACHE_TTL_MS) {
      return [...this.modelsCache.models];
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

  resolveModel(modelId: string): { provider: BaseProvider; modelId: string } {
    if (modelId === 'auto' || modelId === 'default') {
      if (modelId === 'default') {
        const preferred = this.config.defaultModel;
        if (preferred && preferred !== 'auto' && preferred !== 'default') {
          return this.resolveModel(preferred);
        }
      }
      const enabled = this.listEnabledProviders();
      if (enabled.length === 0) {
        throw new Error('no provider is configured; add an API key in Settings first');
      }
      if (modelId === 'auto') {
        const picked = this.pickFromScoredPool();
        if (picked) return picked;
      }
      const cached = this.modelsCache?.models;
      if (cached && cached.length > 0) {
        const first = cached[0]!;
        return { provider: this.getProvider(first.provider), modelId: first.id };
      }
      throw new Error(
        'no default model available; set a default model or wait for /v1/models to load',
      );
    }
    const sep = modelId.indexOf(':');
    if (sep > 0) {
      const providerId = modelId.slice(0, sep) as ProviderId;
      const real = modelId.slice(sep + 1);
      if (PROVIDER_CTORS[providerId as Exclude<ProviderId, 'ollama'>]) {
        return { provider: this.getProvider(providerId), modelId: real };
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
    // default to openrouter
    return { provider: this.getProvider('openrouter'), modelId };
  }

  /**
   * auto 文本兜底：按策略给可用模型打分，取 Top-3 池，池内轮询，
   * 冷却成员实时过滤（filter 版，非循环跳过）。池全冷却/无缓存 → 返回 null（调用方兜底）。
   */
  private pickFromScoredPool(): { provider: BaseProvider; modelId: string } | null {
    const cached = this.modelsCache?.models;
    if (!cached || cached.length === 0) return null;
    const strategy = this.autoRouter.getStrategy();
    const candidates = cached.filter((m) => {
      if (this.autoRouter.isProviderRateLimited(m.provider)) return false;
      if (
        this.autoRouter.isRateLimited(m.id) ||
        this.autoRouter.isRateLimited(`${m.provider}:${m.id}`)
      ) {
        return false;
      }
      return true;
    });
    if (candidates.length === 0) return null;
    const scored = candidates
      .map((m) => ({ m, s: scoreModel(m, strategy, this.autoRouter.getProfile(m.id)) }))
      .sort((a, b) => b.s - a.s || a.m.id.localeCompare(b.m.id));
    const pool = scored.slice(0, 3);
    const pick = pool[autoPoolCursor % pool.length]!;
    autoPoolCursor = (autoPoolCursor + 1) % pool.length;
    return { provider: this.getProvider(pick.m.provider), modelId: pick.m.id };
  }

  async generateImage(
    req: ImageGenerationRequest,
  ): Promise<{ provider: BaseProvider; response: ImageGenerationResponse }> {
    const { provider, modelId } = this.resolveModel(req.model);
    if (!provider.generateImage) {
      throw new Error(`Provider ${provider.id} does not support image generation`);
    }
    const response = await provider.generateImage({ ...req, model: modelId });
    return { provider, response };
  }

  async generateVideo(
    req: VideoGenerationRequest,
  ): Promise<{ provider: BaseProvider; response: VideoGenerationResponse }> {
    const { provider, modelId } = this.resolveModel(req.model);
    if (!provider.generateVideo) {
      throw new Error(`Provider ${provider.id} does not support video generation`);
    }
    const response = await provider.generateVideo({ ...req, model: modelId });
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
