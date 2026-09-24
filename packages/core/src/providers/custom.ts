import type {
  ChatRequest,
  ChatResponse,
  CustomModelEntry,
  CustomSource,
  ModelInfo,
  ProviderId,
  StreamChunk,
} from '../types.js';
import { BaseProvider } from './base.js';
import { toOpenAIMessages } from './openai-messages.js';

interface OpenAILikeChoice {
  index: number;
  message?: {
    role: string;
    content: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
  };
  delta?: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
  };
  finish_reason?: string | null;
}

interface OpenAILikeResponse {
  id: string;
  model: string;
  created: number;
  choices: OpenAILikeChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class CustomProvider extends BaseProvider {
  readonly id: ProviderId = 'custom';
  readonly displayName = 'Custom (自定义)';

  private sourceCursors = new Map<string, number>();

  private loadSources(): CustomSource[] {
    const extra = (this.ctx.credentials.extra ?? {}) as {
      sources?: unknown;
      models?: unknown;
    };
    const raw = extra.sources;
    if (Array.isArray(raw)) {
      return raw
        .map((s) => normalizeSource(s as Partial<CustomSource> | undefined))
        .filter((s): s is CustomSource => !!s);
    }
    // legacy single-source shape: baseUrl + apiKey on top level, models in extra.models
    const legacyBaseUrl = this.ctx.credentials.baseUrl?.trim();
    const legacyKey = this.ctx.credentials.apiKey?.trim();
    if (!legacyBaseUrl) return [];
    const legacyModels = Array.isArray(extra.models)
      ? ((extra.models as unknown[]).filter(
          (m): m is CustomModelEntry => !!m && typeof (m as CustomModelEntry).id === 'string',
        ) as CustomModelEntry[])
      : [];
    return [
      {
        id: 'default',
        label: 'Custom',
        baseUrl: /\/v1\/?$/.test(legacyBaseUrl)
          ? legacyBaseUrl.replace(/\/$/, '')
          : `${legacyBaseUrl.replace(/\/$/, '')}/v1`,
        apiKey: legacyKey || undefined,
        models: legacyModels,
      },
    ];
  }

  private findSource(sourceId: string): CustomSource {
    const sources = this.loadSources();
    const found = sources.find((s) => s.id === sourceId);
    if (!found) {
      throw new Error(`custom source "${sourceId}" not found`);
    }
    return found;
  }

  private splitModel(modelId: string): { sourceId: string; realModel: string } {
    const sep = modelId.indexOf(':');
    if (sep <= 0) {
      const sources = this.loadSources();
      if (sources.length === 1) {
        return { sourceId: sources[0]!.id, realModel: modelId };
      }
      throw new Error(`custom model id "${modelId}" must be in the form "<sourceId>:<model>"`);
    }
    return { sourceId: modelId.slice(0, sep), realModel: modelId.slice(sep + 1) };
  }

  private sourceKeyPool(source: CustomSource): string[] {
    const raw = source.apiKey;
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [];
    return list
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter((k) => !!k && k !== 'sk-none');
  }

  private nextSourceKey(source: CustomSource): string | undefined {
    const pool = this.sourceKeyPool(source);
    if (pool.length === 0) return undefined;
    const cursor = this.sourceCursors.get(source.id) ?? 0;
    const key = pool[cursor % pool.length];
    this.sourceCursors.set(source.id, (cursor + 1) % pool.length);
    return key;
  }

  private buildHeaders(source: CustomSource): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = this.nextSourceKey(source);
    if (key) {
      headers['authorization'] = `Bearer ${key}`;
    }
    return headers;
  }

  async listModels(): Promise<ModelInfo[]> {
    const sources = this.loadSources();
    const out: ModelInfo[] = [];
    for (const src of sources) {
      for (const m of src.models) {
        if (!m || typeof m.id !== 'string' || !m.id.trim()) continue;
        const composedId = `${src.id}:${m.id}`;
        const label = src.label?.trim() || src.id;
        out.push({
          id: composedId,
          provider: this.id,
          displayName: m.displayName?.trim()
            ? `[${label}] ${m.displayName.trim()}`
            : `[${label}] ${m.id}`,
          contextWindow: m.contextWindow,
          free: true,
          description: `Custom OpenAI-compatible endpoint (source: ${label}).`,
        });
      }
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { sourceId, realModel } = this.splitModel(req.model);
    const source = this.findSource(sourceId);
    const baseUrl = source.baseUrl.replace(/\/$/, '');
    const res = this.observeResponse(
      req.model,
      await this.fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(source),
        body: JSON.stringify({
          ...req,
          model: realModel,
          messages: toOpenAIMessages(req.messages),
          stream: false,
        }),
      }),
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`custom chat failed ${res.status}: ${text}`);
    }
    const data = (await res.json()) as OpenAILikeResponse;
    this.observeUsage(req.model, data.usage);
    const choice = data.choices[0];
    const msg = choice?.message;
    const primary = typeof msg?.content === 'string' ? msg.content : '';
    const reasoning =
      (typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '') ||
      (typeof msg?.reasoning === 'string' ? msg.reasoning : '');
    const content = primary || reasoning;
    return {
      id: data.id,
      model: req.model,
      created: data.created,
      content,
      finish_reason: (choice?.finish_reason ?? 'stop') as ChatResponse['finish_reason'],
      usage: data.usage,
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const { sourceId, realModel } = this.splitModel(req.model);
    const source = this.findSource(sourceId);
    const baseUrl = source.baseUrl.replace(/\/$/, '');
    const res = this.observeResponse(
      req.model,
      await this.fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(source),
        body: JSON.stringify({
          ...req,
          model: realModel,
          messages: toOpenAIMessages(req.messages),
          stream: true,
        }),
      }),
    );
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new Error(`custom stream failed ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as OpenAILikeResponse;
          if (json.usage) this.observeUsage(req.model, json.usage);
          const choice = json.choices[0];
          const primaryDelta = choice?.delta?.content ?? '';
          const reasoningDelta =
            (choice?.delta?.reasoning_content ?? '') || (choice?.delta?.reasoning ?? '');
          const delta = primaryDelta || reasoningDelta;
          yield {
            id: json.id,
            model: req.model,
            created: json.created,
            delta,
            finish_reason: (choice?.finish_reason ?? null) as StreamChunk['finish_reason'],
          };
        } catch {
          // ignore malformed line
        }
      }
    }
  }
}

function normalizeSource(input: Partial<CustomSource> | undefined): CustomSource | null {
  if (!input) return null;
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  if (!id || !baseUrl) return null;
  const rawModels = Array.isArray(input.models) ? input.models : [];
  const models = rawModels
    .map((m) => ({
      id: typeof m?.id === 'string' ? m.id.trim() : '',
      displayName:
        typeof m?.displayName === 'string' && m.displayName.trim()
          ? m.displayName.trim()
          : undefined,
      contextWindow:
        typeof m?.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : undefined,
    }))
    .filter((m) => m.id);
  const rawKey = input.apiKey;
  let apiKey: string | string[] | undefined;
  if (Array.isArray(rawKey)) {
    const keys = rawKey.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => !!k);
    if (keys.length) apiKey = keys.length === 1 ? keys[0] : keys;
  } else if (typeof rawKey === 'string' && rawKey.trim()) {
    apiKey = rawKey.trim();
  }
  return {
    id,
    label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : undefined,
    baseUrl: /\/v1\/?$/.test(baseUrl)
      ? baseUrl.replace(/\/$/, '')
      : `${baseUrl.replace(/\/$/, '')}/v1`,
    apiKey,
    models,
  };
}
