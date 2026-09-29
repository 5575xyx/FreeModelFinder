import type {
  ZenChatResponse,
  ZenStreamChunk,
  ZenToolCall,
  ZenToolCallDelta,
  ZenUsage,
} from './types.js';

export interface SseEvent {
  event?: string;
  data: string;
}

interface SseBoundary {
  index: number;
  width: number;
}

function nextSseBoundary(buffer: string): SseBoundary {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) {
    if (crlf < 0) return { index: -1, width: 0 };
    return { index: crlf, width: 4 };
  }
  if (crlf >= 0 && crlf < lf) return { index: crlf, width: 4 };
  return { index: lf, width: 2 };
}

function parseSseFrame(frame: string): SseEvent | undefined {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  if (dataLines.length === 0) return undefined;
  const event: SseEvent = { data: dataLines.join('\n') };
  if (eventName !== undefined) event.event = eventName;
  return event;
}

export class SseParser {
  private buffer = '';

  push(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    for (;;) {
      const boundary = nextSseBoundary(this.buffer);
      if (boundary.index < 0) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.width);
      const event = parseSseFrame(frame);
      if (event) events.push(event);
    }
    return events;
  }
}

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

function firstString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function firstNonZero(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (value !== undefined && value !== 0) return value;
  }
  return undefined;
}

function parseOpenAiUsage(value: unknown): ZenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const out: ZenUsage = {};
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

function parseResponsesUsage(value: unknown): ZenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = firstNonZero(num(usage['prompt_tokens']), num(usage['input_tokens'])) ?? 0;
  const output = firstNonZero(num(usage['completion_tokens']), num(usage['output_tokens'])) ?? 0;
  const total = num(usage['total_tokens']) || input + output;
  const out: ZenUsage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
  };
  const cached = firstNonZero(
    num(asRecord(usage['prompt_tokens_details'])?.['cached_tokens']),
    num(asRecord(usage['input_tokens_details'])?.['cached_tokens']),
  );
  if (cached !== undefined) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}

function emptyChunk(payload: Record<string, unknown>): ZenStreamChunk {
  return {
    id: str(payload['id']) ?? `zen-${Date.now()}`,
    model: str(payload['model']) ?? '',
    created: num(payload['created']) ?? Math.floor(Date.now() / 1000),
    delta: '',
  };
}

const CHAT_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter']);

function mapChatFinishReason(value: unknown): ZenStreamChunk['finish_reason'] {
  const raw = str(value);
  if (raw === 'function_call') return 'tool_calls';
  return raw !== undefined && CHAT_FINISH_REASONS.has(raw)
    ? (raw as ZenStreamChunk['finish_reason'])
    : null;
}

function mapAnthropicFinishReason(value: unknown): ZenStreamChunk['finish_reason'] {
  switch (str(value)) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}

function parseToolCallDeltas(value: unknown): ZenToolCallDelta[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ZenToolCallDelta[] = [];
  for (const raw of value) {
    const call = asRecord(raw);
    if (!call) continue;
    const fn = asRecord(call['function']);
    const delta: ZenToolCallDelta = { index: num(call['index']) ?? 0, type: 'function' };
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

export function parseChatChunk(payload: unknown): ZenStreamChunk {
  const value = asRecord(payload) ?? {};
  if (value['error'] !== undefined && value['error'] !== null) {
    throw new Error(streamErrorMessage(value, 'upstream Chat stream error'));
  }
  const chunk = emptyChunk(value);
  const choices = Array.isArray(value['choices']) ? value['choices'] : [];
  const choice = asRecord(choices[0]);
  if (choice) {
    const delta = asRecord(choice['delta']) ?? {};
    const reasoning = firstString(str(delta['reasoning_content']), str(delta['reasoning']));
    if (reasoning !== undefined) chunk.reasoning = reasoning;
    const content = str(delta['content']);
    if (content !== undefined && content !== '') chunk.delta = content;
    const toolCalls = parseToolCallDeltas(delta['tool_calls']);
    if (toolCalls) chunk.tool_calls = toolCalls;
    const finish = mapChatFinishReason(choice['finish_reason']);
    if (finish !== null) chunk.finish_reason = finish;
  }
  const usage = parseOpenAiUsage(value['usage']);
  if (usage) chunk.usage = usage;
  return chunk;
}

export function parseAnthropicChunk(payload: unknown): ZenStreamChunk {
  const value = asRecord(payload) ?? {};
  if (str(value['type']) === 'error') {
    throw new Error(streamErrorMessage(value, 'upstream Anthropic stream error'));
  }
  const chunk = emptyChunk(value);
  switch (str(value['type'])) {
    case 'message_start': {
      const message = asRecord(value['message']) ?? {};
      const id = str(message['id']);
      if (id !== undefined) chunk.id = id;
      const model = str(message['model']);
      if (model !== undefined) chunk.model = model;
      const usage = parseAnthropicUsage(message['usage']);
      if (usage) chunk.usage = usage;
      break;
    }
    case 'content_block_delta': {
      const delta = asRecord(value['delta']) ?? {};
      const index = num(value['index']) ?? 0;
      switch (str(delta['type'])) {
        case 'thinking_delta': {
          const text = str(delta['thinking']);
          if (text !== undefined) chunk.reasoning = text;
          break;
        }
        case 'text_delta': {
          const text = str(delta['text']);
          if (text !== undefined && text !== '') chunk.delta = text;
          break;
        }
        case 'input_json_delta': {
          chunk.tool_calls = [
            {
              index,
              type: 'function',
              function: { arguments: str(delta['partial_json']) ?? '' },
            },
          ];
          break;
        }
      }
      break;
    }
    case 'message_delta': {
      const usage = parseAnthropicUsage(value['usage']);
      if (usage) chunk.usage = usage;
      const stop = asRecord(value['delta'])?.['stop_reason'];
      if (str(stop) !== undefined) chunk.finish_reason = mapAnthropicFinishReason(stop);
      break;
    }
  }
  return chunk;
}

function responsesCompletedFinish(
  type: string,
  response: Record<string, unknown>,
): ZenStreamChunk['finish_reason'] {
  if (type === 'response.incomplete') {
    return str(asRecord(response['incomplete_details'])?.['reason']) === 'content_filter'
      ? 'content_filter'
      : 'length';
  }
  if (type === 'response.failed' || str(response['status']) === 'failed') return null;
  const output = Array.isArray(response['output']) ? response['output'] : [];
  for (const raw of output) {
    if (str(asRecord(raw)?.['type']) === 'function_call') return 'tool_calls';
  }
  return 'stop';
}

function streamErrorMessage(value: Record<string, unknown>, fallback: string): string {
  const error = value['error'];
  const record = asRecord(error);
  const message = firstString(str(record?.['message']), str(value['message']));
  if (message !== undefined) return message;
  if (typeof error === 'string' && error !== '') return error;
  if (error !== undefined && error !== null) return JSON.stringify(error);
  return fallback;
}

function mergeUsage(target: ZenUsage, source: ZenUsage): void {
  if (source.prompt_tokens !== undefined && source.prompt_tokens !== 0) {
    target.prompt_tokens = source.prompt_tokens;
  }
  if (source.completion_tokens !== undefined && source.completion_tokens !== 0) {
    target.completion_tokens = source.completion_tokens;
  }
  if (source.total_tokens !== undefined && source.total_tokens !== 0) {
    target.total_tokens = Math.max(target.total_tokens ?? 0, source.total_tokens);
  }
  const cached = source.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined && cached !== 0) {
    target.prompt_tokens_details = { cached_tokens: cached };
  }
  const derived = (target.prompt_tokens ?? 0) + (target.completion_tokens ?? 0);
  target.total_tokens = Math.max(target.total_tokens ?? 0, derived);
}

export function collapseChunks(chunks: ZenStreamChunk[]): ZenChatResponse {
  let id: string | undefined;
  let model: string | undefined;
  let created: number | undefined;
  let content = '';
  let reasoning = '';
  let finish_reason: ZenChatResponse['finish_reason'] = null;
  let usage: ZenUsage | undefined;
  const toolCalls: ZenToolCall[] = [];
  const toolByIndex = new Map<number, ZenToolCall>();

  for (const chunk of chunks) {
    if (id === undefined && chunk.id !== '') id = chunk.id;
    if (model === undefined && chunk.model !== '') model = chunk.model;
    if (created === undefined && chunk.created !== 0) created = chunk.created;
    content += chunk.delta;
    if (chunk.reasoning !== undefined && chunk.reasoning !== '') reasoning += chunk.reasoning;
    for (const delta of chunk.tool_calls ?? []) {
      let target = toolByIndex.get(delta.index);
      if (target === undefined) {
        target = { type: 'function', function: { name: '' } };
        toolByIndex.set(delta.index, target);
        toolCalls.push(target);
      }
      if (target.id === undefined && delta.id !== undefined && delta.id !== '')
        target.id = delta.id;
      const name = delta.function?.name;
      if (target.function.name === '' && name !== undefined && name !== '') {
        target.function.name = name;
      }
      const args = delta.function?.arguments;
      if (args !== undefined) {
        target.function.arguments = (target.function.arguments ?? '') + args;
      }
    }
    if (chunk.finish_reason !== undefined && chunk.finish_reason !== null) {
      finish_reason = chunk.finish_reason;
    }
    if (chunk.usage !== undefined) {
      usage = usage ?? {};
      mergeUsage(usage, chunk.usage);
    }
  }

  const response: ZenChatResponse = {
    id: id ?? `zen-${Date.now()}`,
    model: model ?? '',
    created: created ?? Math.floor(Date.now() / 1000),
    content,
    finish_reason,
  };
  if (reasoning !== '') response.reasoning = reasoning;
  if (toolCalls.length > 0) response.tool_calls = toolCalls;
  if (usage !== undefined) response.usage = usage;
  return response;
}

export function parseResponsesChunk(payload: unknown): ZenStreamChunk {
  const value = asRecord(payload) ?? {};
  const type = str(value['type']) ?? '';
  if (type === 'error') {
    throw new Error(streamErrorMessage(value, 'upstream Responses stream error'));
  }
  const responseRecord = asRecord(value['response']);
  if (responseRecord && responseRecord['error'] !== undefined && responseRecord['error'] !== null) {
    throw new Error(streamErrorMessage(responseRecord, 'upstream Responses request failed'));
  }
  const chunk = emptyChunk(value);
  switch (type) {
    case 'response.created': {
      const response = asRecord(value['response']) ?? {};
      const id = str(response['id']);
      if (id !== undefined) chunk.id = id;
      const model = str(response['model']);
      if (model !== undefined) chunk.model = model;
      const created = num(response['created_at']);
      if (created !== undefined) chunk.created = created;
      break;
    }
    case 'response.output_text.delta': {
      const delta = str(value['delta']);
      if (delta !== undefined && delta !== '') chunk.delta = delta;
      break;
    }
    case 'response.reasoning_summary_text.delta': {
      const delta = str(value['delta']);
      if (delta !== undefined && delta !== '') chunk.reasoning = delta;
      break;
    }
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const item = asRecord(value['item']);
      if (str(item?.['type']) === 'function_call') {
        const delta: ZenToolCallDelta = {
          index: num(value['output_index']) ?? 0,
          type: 'function',
          function: { name: str(item?.['name']) ?? '' },
        };
        const id = firstString(str(item?.['call_id']), str(item?.['id']));
        if (id !== undefined) delta.id = id;
        chunk.tool_calls = [delta];
      }
      break;
    }
    case 'response.function_call_arguments.delta': {
      chunk.tool_calls = [
        {
          index: num(value['output_index']) ?? 0,
          type: 'function',
          function: { arguments: str(value['delta']) ?? '' },
        },
      ];
      break;
    }
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
    case 'response.done': {
      const response = asRecord(value['response']) ?? {};
      const usage = parseResponsesUsage(response['usage']);
      if (usage) chunk.usage = usage;
      const finish = responsesCompletedFinish(type, response);
      if (finish !== null) chunk.finish_reason = finish;
      break;
    }
  }
  return chunk;
}
