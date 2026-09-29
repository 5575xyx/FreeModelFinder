import type { ZenChatMessage, ZenContentPart, ZenRequest, ZenToolDefinition } from './types.js';

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

type AnthropicBlock = Record<string, unknown>;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

function imageBlock(url: string): AnthropicBlock {
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (match && match[1] !== undefined) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] ?? '' },
      };
    }
  }
  return { type: 'image', source: { type: 'url', url } };
}

function contentPartsToBlocks(parts: ZenContentPart[]): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text ?? '' });
    } else if (part.type === 'image_url') {
      blocks.push(imageBlock(part.image_url?.url ?? ''));
    }
  }
  return blocks;
}

function parseToolInput(argumentsJson: string | undefined): unknown {
  if (!argumentsJson) return {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function messageToBlocks(message: ZenChatMessage): AnthropicBlock[] {
  if (message.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: message.content,
      },
    ];
  }
  const blocks: AnthropicBlock[] = [];
  if (message.reasoning) {
    blocks.push({ type: 'thinking', thinking: message.reasoning });
  }
  if (message.contentParts && message.contentParts.length > 0) {
    blocks.push(...contentPartsToBlocks(message.contentParts));
  } else if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }
  if (message.tool_calls) {
    message.tool_calls.forEach((call, index) => {
      blocks.push({
        type: 'tool_use',
        id: call.id ?? `call_${index}`,
        name: call.function.name,
        input: parseToolInput(call.function.arguments),
      });
    });
  }
  return blocks;
}

function encodeTools(tools: ZenToolDefinition[]): AnthropicBlock[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
  }));
}

export function toAnthropicBody(request: ZenRequest): Record<string, unknown> {
  const system: AnthropicBlock[] = [];
  const messages: AnthropicMessage[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content) system.push({ type: 'text', text: message.content });
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = messageToBlocks(message);
    if (blocks.length === 0) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      continue;
    }
    messages.push({ role, content: blocks });
  }

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages,
  };
  if (system.length > 0) body['system'] = system;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.top_p !== undefined) body['top_p'] = request.top_p;
  if (request.stop !== undefined) {
    body['stop_sequences'] = Array.isArray(request.stop) ? request.stop : [request.stop];
  }
  if (request.stream !== undefined) body['stream'] = request.stream;
  if (request.tools && request.tools.length > 0) body['tools'] = encodeTools(request.tools);
  return body;
}
