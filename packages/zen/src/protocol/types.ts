export type ZenProtocol = 'chat' | 'responses' | 'anthropic';
export type ZenClientProtocol = 'openai' | 'anthropic' | 'gemini';

export function isZenProtocol(value: string): value is ZenProtocol {
  return value === 'chat' || value === 'responses' || value === 'anthropic';
}

export interface ZenToolDefinition {
  type?: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ZenToolCall {
  id?: string;
  type?: 'function';
  function: { name: string; arguments?: string };
}

export interface ZenContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface ZenChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  contentParts?: ZenContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ZenToolCall[];
  reasoning?: string;
}

export interface ZenChatRequest {
  model: string;
  messages: ZenChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: ZenToolDefinition[];
  raw?: unknown;
  rawProtocol?: ZenClientProtocol;
  signal?: AbortSignal;
}

export type ZenRequest = ZenChatRequest;

export interface ZenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ZenToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ZenChatResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  tool_calls?: ZenToolCall[];
  reasoning?: string;
  usage?: ZenUsage;
  raw?: unknown;
  rawProtocol?: ZenClientProtocol;
}

export interface ZenStreamChunk {
  id: string;
  model: string;
  created: number;
  delta: string;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  tool_calls?: ZenToolCallDelta[];
  reasoning?: string;
  usage?: ZenUsage;
  raw?: unknown;
  rawProtocol?: ZenClientProtocol;
}
