import type { ChatMessage, ChatRequest, ChatResponse, StreamChunk } from '../types.js';

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | OpenAIContentPart[];
    name?: string;
    tool_call_id?: string;
  }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
}

function normalizeContent(c: OpenAIChatCompletionRequest['messages'][number]['content']): string {
  if (typeof c === 'string') return c;
  return c
    .filter((part) => part.type === 'text' || part.type === 'input_text')
    .map((part) => part.text ?? '')
    .join('');
}

function extractContentParts(
  content: OpenAIChatCompletionRequest['messages'][number]['content'],
):
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  let sawImage = false;
  for (const p of content) {
    if (p.type === 'image_url' && p.image_url?.url) {
      parts.push({ type: 'image_url', image_url: { url: p.image_url.url } });
      sawImage = true;
    } else if ((p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string') {
      parts.push({ type: 'text', text: p.text });
    }
  }
  return sawImage ? parts : undefined;
}

export function openAIToChatRequest(req: OpenAIChatCompletionRequest): ChatRequest {
  const messages: ChatMessage[] = req.messages.map((m) => {
    const contentParts = extractContentParts(m.content);
    return {
      role: m.role,
      content: normalizeContent(m.content),
      contentParts,
      name: m.name,
      tool_call_id: m.tool_call_id,
    };
  });
  return {
    model: req.model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
    stop: req.stop,
  };
}

export function chatResponseToOpenAI(res: ChatResponse) {
  return {
    id: res.id,
    object: 'chat.completion',
    created: res.created,
    model: res.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: res.content },
        finish_reason: res.finish_reason ?? 'stop',
      },
    ],
    usage: res.usage,
  };
}

export function streamChunkToOpenAI(chunk: StreamChunk) {
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: chunk.created,
    model: chunk.model,
    choices: [
      {
        index: 0,
        delta: chunk.delta ? { role: 'assistant', content: chunk.delta } : {},
        finish_reason: chunk.finish_reason ?? null,
      },
    ],
  };
}
