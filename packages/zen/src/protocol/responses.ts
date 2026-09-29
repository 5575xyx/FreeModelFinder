import type { ZenChatMessage, ZenRequest, ZenToolDefinition } from './types.js';

function encodeTools(tools: ZenToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description ?? '',
    parameters: tool.function.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }));
}

function encodeMessage(message: ZenChatMessage): Array<Record<string, unknown>> {
  if (message.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: message.content,
      },
    ];
  }

  const items: Array<Record<string, unknown>> = [];
  let content: Array<Record<string, unknown>> = [];
  const flush = () => {
    if (content.length === 0) return;
    items.push({ type: 'message', role: message.role, content });
    content = [];
  };
  const textKind = message.role === 'assistant' ? 'output_text' : 'input_text';

  if (message.contentParts && message.contentParts.length > 0) {
    for (const part of message.contentParts) {
      if (part.type === 'text') {
        content.push({ type: textKind, text: part.text ?? '' });
      } else {
        content.push({ type: 'input_image', image_url: part.image_url?.url ?? '' });
      }
    }
  } else if (message.content) {
    content.push({ type: textKind, text: message.content });
  }

  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      flush();
      items.push({
        type: 'function_call',
        call_id: call.id ?? '',
        name: call.function.name,
        arguments: call.function.arguments ?? '{}',
      });
    }
  }

  flush();
  return items;
}

export function toResponsesBody(request: ZenRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.model };
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.top_p !== undefined) body['top_p'] = request.top_p;
  if (request.max_tokens !== undefined) body['max_output_tokens'] = request.max_tokens;
  if (request.stop !== undefined) body['stop'] = request.stop;
  if (request.stream !== undefined) body['stream'] = request.stream;

  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content) instructions.push(message.content);
      continue;
    }
    input.push(...encodeMessage(message));
  }
  if (instructions.length > 0) body['instructions'] = instructions.join('');
  body['input'] = input;

  if (request.tools && request.tools.length > 0) body['tools'] = encodeTools(request.tools);
  return body;
}
