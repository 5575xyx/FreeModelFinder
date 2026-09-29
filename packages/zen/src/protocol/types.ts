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
}

export type ZenRequest = ZenChatRequest;
