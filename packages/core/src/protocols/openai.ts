import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from '../types.js';

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | OpenAIContentPart[] | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
    reasoning?: string;
  }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: ToolDefinition[];
}

function normalizeContent(c: OpenAIChatCompletionRequest['messages'][number]['content']): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  return c
    .filter((part) => part.type === 'text' || part.type === 'input_text')
    .map((part) => part.text ?? '')
    .join('');
}

function normalizeOpenAIToolCall(t: OpenAIToolCall): ToolCall {
  return {
    ...(t.id ? { id: t.id } : {}),
    type: 'function',
    function: {
      name: t.function?.name ?? '',
      ...(t.function?.arguments !== undefined ? { arguments: t.function.arguments } : {}),
    },
  };
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
    const tool_calls = m.tool_calls?.map(normalizeOpenAIToolCall);
    const reasoning = m.reasoning_content ?? m.reasoning;
    return {
      role: m.role,
      content: normalizeContent(m.content),
      contentParts,
      name: m.name,
      tool_call_id: m.tool_call_id,
      ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
      ...(reasoning ? { reasoning } : {}),
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
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    raw: req,
    rawProtocol: 'openai',
  };
}

export function chatResponseToOpenAI(res: ChatResponse) {
  if (res.raw != null && res.rawProtocol === 'openai') {
    return res.raw;
  }
  const message: Record<string, unknown> = { role: 'assistant', content: res.content };
  if (res.tool_calls && res.tool_calls.length > 0) message.tool_calls = res.tool_calls;
  if (res.reasoning) message.reasoning = res.reasoning;
  return {
    id: res.id,
    object: 'chat.completion',
    created: res.created,
    model: res.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: res.finish_reason ?? 'stop',
      },
    ],
    usage: res.usage,
  };
}

export function streamChunkToOpenAI(chunk: StreamChunk) {
  const delta: Record<string, unknown> = {};
  if (chunk.delta) {
    delta.role = 'assistant';
    delta.content = chunk.delta;
  }
  if (chunk.tool_calls && chunk.tool_calls.length > 0) delta.tool_calls = chunk.tool_calls;
  if (chunk.reasoning) delta.reasoning = chunk.reasoning;
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: chunk.created,
    model: chunk.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: chunk.finish_reason ?? null,
      },
    ],
  };
}
