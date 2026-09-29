import type { ChatMessage, ChatRequest } from '../types.js';

export interface OpenAIMessageOut {
  role: string;
  content: string | unknown[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatMessage['tool_calls'];
}

export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessageOut[] {
  return messages.map((m) => {
    const extras: Partial<OpenAIMessageOut> = {};
    if (m.name) extras.name = m.name;
    if (m.tool_call_id) extras.tool_call_id = m.tool_call_id;
    if (m.tool_calls && m.tool_calls.length > 0) extras.tool_calls = m.tool_calls;

    const hasImage = m.contentParts?.some((p) => p.type === 'image_url') ?? false;
    if (hasImage && m.contentParts) {
      return {
        role: m.role,
        content: m.contentParts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: p.image_url.url } },
        ),
        ...extras,
      };
    }
    return { role: m.role, content: m.content, ...extras };
  });
}

export function toUpstreamChatFields(req: ChatRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...req };
  delete fields.raw;
  delete fields.rawProtocol;
  return fields;
}
