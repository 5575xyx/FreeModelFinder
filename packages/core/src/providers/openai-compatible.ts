import type { ChatRequest, ChatResponse, ModelInfo, ProviderId, StreamChunk } from '../types.js';
import { BaseProvider } from './base.js';
import {
  mapFinishReason,
  parseOpenAIDelta,
  parseOpenAIMessage,
  parseUsage,
} from './openai-like.js';
import { toOpenAIMessages, toUpstreamChatFields } from './openai-messages.js';

interface OpenAILikeChoice {
  index: number;
  message?: {
    role: string;
    content: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: unknown;
  };
  delta?: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: unknown;
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

export abstract class OpenAICompatibleProvider extends BaseProvider {
  protected abstract baseUrl(): string;
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  private buildHeaders(): Record<string, string> {
    const key = this.nextKey().trim();
    if (!key) {
      throw new Error(`${this.id} API key not configured`);
    }
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...this.extraHeaders(),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = this.observeResponse(
      req.model,
      await this.fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          ...toUpstreamChatFields(req),
          messages: toOpenAIMessages(req.messages),
          stream: false,
        }),
      }),
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.id} chat failed ${res.status}: ${text}`);
    }
    const data = (await res.json()) as OpenAILikeResponse;
    this.observeUsage(req.model, data.usage);
    const choice = data.choices[0];
    const parsed = parseOpenAIMessage(choice?.message);
    const content = parsed.content || parsed.reasoning || '';
    return {
      id: data.id,
      model: data.model,
      created: data.created,
      content,
      finish_reason: mapFinishReason(choice?.finish_reason) ?? 'stop',
      ...(parsed.reasoning && !parsed.content ? { reasoning: parsed.reasoning } : {}),
      ...(parsed.tool_calls ? { tool_calls: parsed.tool_calls } : {}),
      usage: parseUsage(data.usage),
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    const res = this.observeResponse(
      req.model,
      await this.fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          ...toUpstreamChatFields(req),
          messages: toOpenAIMessages(req.messages),
          stream: true,
          stream_options: { include_usage: true },
        }),
      }),
    );
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new Error(`${this.id} stream failed ${res.status}: ${text}`);
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
          const parsed = parseOpenAIDelta(choice?.delta);
          yield {
            id: json.id,
            model: json.model,
            created: json.created,
            delta: parsed.content || parsed.reasoning || '',
            finish_reason: mapFinishReason(choice?.finish_reason),
            ...(parsed.reasoning && !parsed.content ? { reasoning: parsed.reasoning } : {}),
            ...(parsed.tool_calls ? { tool_calls: parsed.tool_calls } : {}),
          };
        } catch {
          // ignore malformed line
        }
      }
    }
  }

  abstract override listModels(): Promise<ModelInfo[]>;
  abstract override readonly id: ProviderId;
  abstract override readonly displayName: string;
}
