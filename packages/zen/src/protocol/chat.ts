import type { ZenChatMessage, ZenRequest } from './types.js';

function encodeContent(message: ZenChatMessage): unknown {
  const hasImage = message.contentParts?.some((part) => part.type === 'image_url') ?? false;
  if (!hasImage || !message.contentParts) return message.content;
  return message.contentParts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text ?? '' }
      : { type: 'image_url', image_url: { url: part.image_url?.url ?? '' } },
  );
}

function encodeMessage(message: ZenChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: encodeContent(message) };
  if (message.name) out['name'] = message.name;
  if (message.tool_call_id) out['tool_call_id'] = message.tool_call_id;
  if (message.tool_calls && message.tool_calls.length > 0) out['tool_calls'] = message.tool_calls;
  if (message.role === 'assistant' && message.reasoning) {
    out['reasoning_content'] = message.reasoning;
  }
  return out;
}

export function toChatBody(request: ZenRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(encodeMessage),
  };
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.top_p !== undefined) body['top_p'] = request.top_p;
  if (request.max_tokens !== undefined) body['max_tokens'] = request.max_tokens;
  if (request.stop !== undefined) body['stop'] = request.stop;
  if (request.stream !== undefined) body['stream'] = request.stream;
  if (request.stream === true) body['stream_options'] = { include_usage: true };
  if (request.tools && request.tools.length > 0) body['tools'] = request.tools;
  return body;
}
