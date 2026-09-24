import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelInfo,
  ProviderId,
  StreamChunk,
} from '../types.js';
import { assertImageDataUrlWithinLimit } from '../vision.js';
import { BaseProvider } from './base.js';

interface GeminiContentPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiContentPart[];
}
interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function pushImageParts(parts: GeminiContentPart[], urls: string[]) {
  for (const url of urls) {
    assertImageDataUrlWithinLimit(url);
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const meta = url.slice(5, comma);
      const mime = meta.replace(/;base64$/, '') || 'image/png';
      const data = url.slice(comma + 1);
      parts.push({ inlineData: { mimeType: mime, data } });
    } else {
      parts.push({ fileData: { fileUri: url } });
    }
  }
}

function buildMessageParts(m: ChatMessage): GeminiContentPart[] {
  const msgParts: GeminiContentPart[] = [];
  const imageUrls: string[] = [];
  if (m.contentParts?.length) {
    for (const p of m.contentParts) {
      if (p.type === 'text') msgParts.push({ text: p.text });
      else if (p.type === 'image_url') imageUrls.push(p.image_url.url);
    }
    if (!msgParts.some((p) => typeof p.text === 'string' && p.text.length) && m.content) {
      msgParts.unshift({ text: m.content });
    }
    pushImageParts(msgParts, imageUrls);
  } else {
    msgParts.push({ text: m.content });
  }
  return msgParts;
}

function toGeminiContents(messages: ChatMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiContentPart[] };
} {
  const systemPieces: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemPieces.push(m.content);
    } else if (m.role === 'assistant') {
      contents.push({ role: 'model', parts: buildMessageParts(m) });
    } else {
      contents.push({ role: 'user', parts: buildMessageParts(m) });
    }
  }
  return {
    contents,
    systemInstruction: systemPieces.length
      ? { parts: [{ text: systemPieces.join('\n\n') }] }
      : undefined,
  };
}

const GEMINI_FREE_ALLOW_LIST = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
] as const;

const GEMINI_FREE_ALLOW_MAP: ReadonlyMap<string, string> = new Map(
  GEMINI_FREE_ALLOW_LIST.map((id) => [id.toLowerCase(), id]),
);

function mapFinish(reason?: string): ChatResponse['finish_reason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
      return 'content_filter';
    default:
      return reason ? 'stop' : null;
  }
}

export class GeminiProvider extends BaseProvider {
  readonly id: ProviderId = 'gemini';
  readonly displayName = 'Google Gemini';

  private baseUrl(): string {
    return this.ctx.credentials.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  private buildBody(req: ChatRequest) {
    const { contents, systemInstruction } = toGeminiContents(req.messages);
    return {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: req.temperature,
        topP: req.top_p,
        maxOutputTokens: req.max_tokens,
        stopSequences:
          typeof req.stop === 'string'
            ? [req.stop]
            : Array.isArray(req.stop)
              ? req.stop
              : undefined,
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const key = this.nextKey();
    const res = await this.fetch(`${this.baseUrl()}/models?key=${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error(`gemini list models failed: ${res.status}`);
    const data = (await res.json()) as {
      models: Array<{
        name: string;
        displayName?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    };
    const rawList = Array.isArray(data.models) ? data.models : [];
    if (rawList.length === 0) {
      throw new Error('gemini list models returned empty data');
    }

    const matched = new Map<string, ModelInfo>();
    for (const m of rawList) {
      if (!m?.name) continue;
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
      const rawId = m.name.replace(/^models\//, '');
      const canonical = GEMINI_FREE_ALLOW_MAP.get(rawId.toLowerCase());
      if (!canonical) continue;
      matched.set(canonical, {
        id: canonical,
        provider: this.id,
        displayName: m.displayName ?? canonical,
        contextWindow: m.inputTokenLimit,
        free: true,
      });
    }

    if (matched.size === 0) {
      throw new Error(
        `gemini list models returned ${rawList.length} entries but none matched the free whitelist`,
      );
    }

    return [...matched.values()];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = this.nextKey();
    const url = `${this.baseUrl()}/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = this.observeResponse(
      req.model,
      await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.buildBody(req)),
      }),
    );
    if (!res.ok) throw new Error(`gemini chat failed ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as GeminiResponse;
    const usage = data.usageMetadata
      ? {
          prompt_tokens: data.usageMetadata.promptTokenCount,
          completion_tokens: data.usageMetadata.candidatesTokenCount,
          total_tokens: data.usageMetadata.totalTokenCount,
        }
      : undefined;
    this.observeUsage(req.model, usage);
    const cand = data.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return {
      id: `gemini-${Date.now()}`,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: text,
      finish_reason: mapFinish(cand?.finishReason),
      usage,
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const key = this.nextKey();
    const url = `${this.baseUrl()}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    const res = this.observeResponse(
      req.model,
      await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.buildBody(req)),
      }),
    );
    if (!res.ok || !res.body) {
      throw new Error(`gemini stream failed ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const streamId = `gemini-${Date.now()}`;
    let latestUsage: ChatResponse['usage'];

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
        if (!payload) continue;
        try {
          const json = JSON.parse(payload) as GeminiResponse;
          if (json.usageMetadata) {
            latestUsage = {
              prompt_tokens: json.usageMetadata.promptTokenCount,
              completion_tokens: json.usageMetadata.candidatesTokenCount,
              total_tokens: json.usageMetadata.totalTokenCount,
            };
          }
          const cand = json.candidates?.[0];
          const delta = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
          yield {
            id: streamId,
            model: req.model,
            created: Math.floor(Date.now() / 1000),
            delta,
            finish_reason: mapFinish(cand?.finishReason) ?? null,
          };
        } catch {
          // ignore
        }
      }
    }
    this.observeUsage(req.model, latestUsage);
  }
}
