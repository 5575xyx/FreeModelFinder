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

const CLIENT_TO_PROTOCOL: Partial<Record<ZenClientProtocol, ZenProtocol>> = {
  openai: 'chat',
  anthropic: 'anthropic',
};

export function convertResponse(
  body: unknown,
  upstream: ZenProtocol,
  client: ZenClientProtocol,
): ZenChatResponse {
  if (upstream !== 'chat') {
    throw new Error(`unsupported upstream protocol: ${upstream}`);
  }
  const parsed = parseChatResponse(body);
  if (CLIENT_TO_PROTOCOL[client] === upstream) {
    return { ...parsed, raw: body, rawProtocol: client };
  }
  return parsed;
}
