import type {
  ChatRequest,
  ChatResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelInfo,
  ProviderId,
  ProviderCredentials,
  QuotaWindow,
  StreamChunk,
  VideoGenerationRequest,
  VideoGenerationResponse,
} from '../types.js';

export interface ProviderContext {
  credentials: ProviderCredentials;
  fetchImpl?: typeof fetch;
  onResponse?: (event: {
    provider: ProviderId;
    model: string;
    status: number;
    headers: Headers;
  }) => void;
  onUsage?: (event: { provider: ProviderId; model: string; usage?: ChatResponse['usage'] }) => void;
  onQuotaWindows?: (event: { provider: ProviderId; windows: QuotaWindow[] }) => void;
}

export abstract class BaseProvider {
  abstract readonly id: ProviderId;
  abstract readonly displayName: string;

  private keyCursor = 0;

  constructor(protected ctx: ProviderContext) {}

  /**
   * Round-robin over `credentials.apiKeys` (falling back to the legacy single
   * `apiKey`). Each call advances the cursor so consecutive requests spread
   * across the pool.
   */
  protected nextKey(): string {
    const key = this.optionalKey();
    if (!key) {
      throw new Error(`${this.id} API key not configured`);
    }
    this.keyCursor = (this.keyCursor + 1) % Math.max(this.keyPool().length, 1);
    return key;
  }

  private keyPool(): string[] {
    const cred = this.ctx.credentials;
    const pool = (cred?.apiKeys?.filter((k) => !!k?.trim()) ?? []).slice();
    if (pool.length === 0 && cred?.apiKey?.trim()) pool.push(cred.apiKey.trim());
    return pool;
  }

  /** First usable key without advancing the round-robin cursor. */
  protected optionalKey(): string | undefined {
    const pool = this.keyPool();
    if (pool.length === 0) return undefined;
    const key = pool[this.keyCursor % pool.length];
    return key?.trim() || pool[0];
  }

  protected get fetch(): typeof fetch {
    return this.ctx.fetchImpl ?? globalThis.fetch;
  }

  protected observeResponse(model: string, response: Response): Response {
    this.ctx.onResponse?.({
      provider: this.id,
      model,
      status: response.status,
      headers: response.headers,
    });
    return response;
  }

  protected observeUsage(model: string, usage?: ChatResponse['usage']): void {
    this.ctx.onUsage?.({ provider: this.id, model, usage });
  }

  protected observeProviderQuota(windows: QuotaWindow[]): void {
    this.ctx.onQuotaWindows?.({ provider: this.id, windows });
  }

  abstract listModels(): Promise<ModelInfo[]>;
  abstract chat(req: ChatRequest): Promise<ChatResponse>;
  abstract stream(req: ChatRequest): AsyncIterable<StreamChunk>;

  generateImage?(req: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  generateVideo?(req: VideoGenerationRequest): Promise<VideoGenerationResponse>;
  queryVideoStatus?(videoId: string): Promise<VideoGenerationResponse>;
}

export function requireKey(cred: ProviderCredentials | undefined, provider: string): string {
  const pool = cred?.apiKeys?.filter((k) => !!k?.trim()) ?? [];
  if (pool.length > 0) return pool[0]!.trim();
  if (!cred?.apiKey) {
    throw new Error(`${provider} API key not configured`);
  }
  return cred.apiKey;
}
