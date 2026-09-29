import type {
  ZenChatResponse,
  ZenClientProtocol,
  ZenProtocol,
  ZenToolCall,
  ZenUsage,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function decodeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = asRecord(part);
        return record && (record['type'] === 'text' || record['type'] === 'output_text')
          ? (str(record['text']) ?? '')
          : '';
      })
      .join('');
  }
  return '';
}

function parseUsage(value: unknown): ZenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const out: ZenUsage = {};
  const prompt = num(usage['prompt_tokens']);
  const completion = num(usage['completion_tokens']);
  const total = num(usage['total_tokens']);
  if (prompt !== undefined) out.prompt_tokens = prompt;
  if (completion !== undefined) out.completion_tokens = completion;
  if (total !== undefined) out.total_tokens = total;
  const details = asRecord(usage['prompt_tokens_details']);
  const cached = num(details?.['cached_tokens']);
  if (cached !== undefined) out.prompt_tokens_details = { cached_tokens: cached };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseToolCalls(value: unknown): ZenToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ZenToolCall[] = [];
  for (const raw of value) {
    const call = asRecord(raw);
    if (!call) continue;
    const fn = asRecord(call['function']);
    calls.push({
      ...(str(call['id']) ? { id: str(call['id']) } : {}),
      type: 'function',
      function: {
        name: str(fn?.['name']) ?? '',
        ...(str(fn?.['arguments']) !== undefined ? { arguments: str(fn?.['arguments']) } : {}),
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

const FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter']);

function finishReason(value: unknown): ZenChatResponse['finish_reason'] {
  const v = str(value);
  if (v === 'function_call') return 'tool_calls';
  return v && FINISH.has(v) ? (v as ZenChatResponse['finish_reason']) : null;
}

export function parseChatResponse(body: unknown): ZenChatResponse {
  const payload = asRecord(body) ?? {};
  const choices = Array.isArray(payload['choices']) ? (payload['choices'] as unknown[]) : [];
  if (choices.length === 0) {
    const error = asRecord(payload['error']);
    const message = error
      ? (str(error['message']) ?? 'upstream returned no choices')
      : 'upstream returned no choices';
    throw new Error(message);
  }
  const choice = asRecord(choices[0]) ?? {};
  const message = asRecord(choice['message']) ?? {};
  const primary = decodeContent(message['content']);
  const reasoning = str(message['reasoning_content']) ?? str(message['reasoning']) ?? '';
  const tool_calls = parseToolCalls(message['tool_calls']);
  const usage = parseUsage(payload['usage']);
  return {
    id: str(payload['id']) ?? `zen-${Date.now()}`,
    model: str(payload['model']) ?? '',
    created: num(payload['created']) ?? Math.floor(Date.now() / 1000),
    content: primary || reasoning,
    finish_reason: finishReason(choice['finish_reason']),
    ...(tool_calls ? { tool_calls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseAnthropicUsage(value: unknown): ZenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const cached = num(usage['cache_read_input_tokens']);
  const cacheCreation = num(usage['cache_creation_input_tokens']);
  const input = (num(usage['input_tokens']) ?? 0) + (cached ?? 0) + (cacheCreation ?? 0);
  const output = num(usage['output_tokens']) ?? 0;
  const out: ZenUsage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
  if (cached !== undefined) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}

function anthropicFinishReason(value: unknown): ZenChatResponse['finish_reason'] {
  switch (str(value)) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}

const ANTHROPIC_REDACTED_THINKING_PLACEHOLDER = '[redacted thinking]';

export function parseAnthropicResponse(body: unknown): ZenChatResponse {
  const payload = asRecord(body) ?? {};
  const error = asRecord(payload['error']);
  const errorMessage =
    str(error?.['message']) ??
    (str(payload['type']) === 'error' ? 'upstream Anthropic request failed' : undefined);
  if (errorMessage) throw new Error(errorMessage);

  const stop = str(payload['stop_reason']);
  if (stop === 'error' || stop === 'network_error' || stop === 'server_error') {
    throw new Error('upstream response failed');
  }

  const content = payload['content'];
  const blocks: unknown[] = Array.isArray(content)
    ? content
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : [];

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const tool_calls: ZenToolCall[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (!block) throw new Error('Anthropic content block must be an object');
    switch (str(block['type'])) {
      case 'text':
        textParts.push(str(block['text']) ?? '');
        break;
      case 'thinking':
        reasoningParts.push(str(block['thinking']) ?? '');
        break;
      case 'redacted_thinking':
        reasoningParts.push(ANTHROPIC_REDACTED_THINKING_PLACEHOLDER);
        break;
      case 'tool_use': {
        const input = asRecord(block['input']);
        tool_calls.push({
          ...(str(block['id']) ? { id: str(block['id']) } : {}),
          type: 'function',
          function: {
            name: str(block['name']) ?? '',
            arguments: input ? JSON.stringify(input) : '{}',
          },
        });
        break;
      }
      default:
        throw new Error(
          `Anthropic response contains unsupported ${str(block['type'])} content block`,
        );
    }
  }

  const usage = parseAnthropicUsage(payload['usage']);
  const reasoning = reasoningParts.join('');
  return {
    id: str(payload['id']) ?? `zen-${Date.now()}`,
    model: str(payload['model']) ?? '',
    created:
      num(payload['created']) ?? num(payload['created_at']) ?? Math.floor(Date.now() / 1000),
    content: textParts.join(''),
    finish_reason: anthropicFinishReason(stop),
    ...(tool_calls.length > 0 ? { tool_calls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
  };
}

const CLIENT_TO_PROTOCOL: Partial<Record<ZenClientProtocol, ZenProtocol>> = {
  openai: 'chat',
  anthropic: 'anthropic',
};

function parseByProtocol(body: unknown, upstream: ZenProtocol): ZenChatResponse {
  switch (upstream) {
    case 'anthropic':
      return parseAnthropicResponse(body);
    case 'responses':
      throw new Error('unsupported upstream protocol: responses');
    default:
      return parseChatResponse(body);
  }
}

function emptyResponse(): ZenChatResponse {
  return {
    id: `zen-${Date.now()}`,
    model: '',
    created: Math.floor(Date.now() / 1000),
    content: '',
    finish_reason: null,
  };
}

export function convertResponse(
  body: unknown,
  upstream: ZenProtocol,
  client: ZenClientProtocol,
): ZenChatResponse {
  if (CLIENT_TO_PROTOCOL[client] === upstream) {
    let parsed: ZenChatResponse;
    try {
      parsed = parseByProtocol(body, upstream);
    } catch {
      parsed = emptyResponse();
    }
    return { ...parsed, raw: body, rawProtocol: client };
  }
  return parseByProtocol(body, upstream);
}
