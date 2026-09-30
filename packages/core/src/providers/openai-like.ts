import type { ChatResponse, ToolCall, ToolCallDelta } from '../types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function decodeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = asRecord(part);
        return record && record['type'] === 'text' ? (str(record['text']) ?? '') : '';
      })
      .join('');
  }
  return '';
}

export function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ToolCall[] = [];
  for (const raw of value) {
    const call = asRecord(raw);
    if (!call) continue;
    const fn = asRecord(call['function']);
    const id = str(call['id']);
    const args = str(fn?.['arguments']);
    calls.push({
      ...(id !== undefined && id !== '' ? { id } : {}),
      type: 'function',
      function: {
        name: str(fn?.['name']) ?? '',
        ...(args !== undefined ? { arguments: args } : {}),
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

export function parseToolCallDeltas(value: unknown): ToolCallDelta[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ToolCallDelta[] = [];
  for (const raw of value) {
    const call = asRecord(raw);
    if (!call) continue;
    const fn = asRecord(call['function']);
    const delta: ToolCallDelta = { index: nonNegativeInt(call['index']) ?? 0, type: 'function' };
    const id = str(call['id']);
    if (id !== undefined) delta.id = id;
    const name = str(fn?.['name']);
    const args = str(fn?.['arguments']);
    if (name !== undefined || args !== undefined) {
      delta.function = {};
      if (name !== undefined) delta.function.name = name;
      if (args !== undefined) delta.function.arguments = args;
    }
    calls.push(delta);
  }
  return calls.length > 0 ? calls : undefined;
}

export function mergeToolCallDeltas(deltas: ToolCallDelta[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byIndex = new Map<number, ToolCall>();
  for (const delta of deltas) {
    let target = byIndex.get(delta.index);
    if (target === undefined) {
      target = { type: 'function', function: { name: '' } };
      byIndex.set(delta.index, target);
      calls.push(target);
    }
    if (target.id === undefined && delta.id !== undefined && delta.id !== '') {
      target.id = delta.id;
    }
    const name = delta.function?.name;
    if (target.function.name === '' && name !== undefined && name !== '') {
      target.function.name = name;
    }
    const args = delta.function?.arguments;
    if (args !== undefined) {
      target.function.arguments = (target.function.arguments ?? '') + args;
    }
  }
  return calls;
}

export function parseOpenAIMessage(message: unknown): {
  content: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
} {
  const record = asRecord(message) ?? {};
  const content = decodeContent(record['content']);
  const reasoning = firstString(str(record['reasoning_content']), str(record['reasoning']));
  const tool_calls = parseToolCalls(record['tool_calls']);
  return {
    content,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(tool_calls ? { tool_calls } : {}),
  };
}

export function parseOpenAIDelta(delta: unknown): {
  content?: string;
  reasoning?: string;
  tool_calls?: ToolCallDelta[];
} {
  const record = asRecord(delta) ?? {};
  const out: { content?: string; reasoning?: string; tool_calls?: ToolCallDelta[] } = {};
  const content = str(record['content']);
  if (content !== undefined && content !== '') out.content = content;
  const reasoning = firstString(str(record['reasoning_content']), str(record['reasoning']));
  if (reasoning !== undefined) out.reasoning = reasoning;
  const tool_calls = parseToolCallDeltas(record['tool_calls']);
  if (tool_calls) out.tool_calls = tool_calls;
  return out;
}

const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter']);

export function mapFinishReason(value: unknown): ChatResponse['finish_reason'] {
  const raw = str(value);
  if (raw === 'function_call') return 'tool_calls';
  return raw !== undefined && FINISH_REASONS.has(raw)
    ? (raw as ChatResponse['finish_reason'])
    : null;
}

export function parseUsage(value: unknown): ChatResponse['usage'] | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const out: NonNullable<ChatResponse['usage']> = {};
  const prompt = num(usage['prompt_tokens']);
  const completion = num(usage['completion_tokens']);
  const total = num(usage['total_tokens']);
  if (prompt !== undefined) out.prompt_tokens = prompt;
  if (completion !== undefined) out.completion_tokens = completion;
  if (total !== undefined) out.total_tokens = total;
  const cached = num(asRecord(usage['prompt_tokens_details'])?.['cached_tokens']);
  if (cached !== undefined) out.prompt_tokens_details = { cached_tokens: cached };
  return Object.keys(out).length > 0 ? out : undefined;
}
