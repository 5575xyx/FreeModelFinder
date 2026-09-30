import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  anthropicToChatRequest,
  chatResponseToAnthropic,
  type AnthropicMessagesRequest,
} from '../protocols/anthropic.js';
import {
  chatResponseToOpenAI,
  openAIToChatRequest,
  streamChunkToOpenAI,
  type OpenAIChatCompletionRequest,
} from '../protocols/openai.js';
import {
  chatResponseToGemini,
  geminiToChatRequest,
  type GeminiHttpRequest,
} from '../protocols/gemini.js';
import { ChatRequestSchema, type ChatResponse, type StreamChunk } from '../types.js';

describe('tools typing', () => {
  it('parses a request carrying tools and raw', () => {
    const parsed = ChatRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } },
        },
      ],
      raw: { some: 'upstream-specific-field' },
    });
    assert.equal(parsed.tools?.[0]?.function.name, 'get_weather');
    assert.deepEqual(parsed.raw, { some: 'upstream-specific-field' });
  });

  it('keeps request parseable when tools and raw are absent', () => {
    const parsed = ChatRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(parsed.tools, undefined);
    assert.equal(parsed.raw, undefined);
  });
});

describe('openai inbound tools', () => {
  it('keeps tools and captures the raw body', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      seed: 7,
    } as unknown as OpenAIChatCompletionRequest;
    const out = openAIToChatRequest(body);
    assert.equal(out.tools?.[0]?.function.name, 'search');
    assert.deepEqual(out.raw, body);
    assert.equal(out.rawProtocol, 'openai');
  });

  it('captures raw and rawProtocol even without tools', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      seed: 3,
    } as unknown as OpenAIChatCompletionRequest;
    const out = openAIToChatRequest(body);
    assert.equal(out.tools, undefined);
    assert.deepEqual(out.raw, body);
    assert.equal(out.rawProtocol, 'openai');
  });

  it('keeps assistant tool_calls on the message', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_1');
  });

  it('maps reasoning_content with precedence and reasoning fallback', () => {
    const withContent = openAIToChatRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: 'x', reasoning_content: 'rc', reasoning: 'r' },
        { role: 'assistant', content: 'y', reasoning: 'only-r' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(withContent.messages[0]?.reasoning, 'rc');
    assert.equal(withContent.messages[1]?.reasoning, 'only-r');
  });
});

describe('openai inbound tool id pairing', () => {
  it('derives a stable id for calls without id and pairs a matching tool result', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', content: 'r' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[1]?.tool_call_id, 'call_0');
  });

  it('numbers multiple derived ids in order', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { type: 'function', function: { name: 'f', arguments: '{}' } },
            { type: 'function', function: { name: 'g', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'r0' },
        { role: 'tool', content: 'r1' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[0]?.tool_calls?.[1]?.id, 'call_1');
    assert.equal(out.messages[1]?.tool_call_id, 'call_0');
    assert.equal(out.messages[2]?.tool_call_id, 'call_1');
  });

  it('adopts the tool result id when the assistant call omitted its id', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', content: 'r', tool_call_id: 'upstream_1' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'upstream_1');
    assert.equal(out.messages[1]?.tool_call_id, 'upstream_1');
  });

  it('treats an empty assistant id as missing without overwriting explicit ids', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: '', type: 'function', function: { name: 'f', arguments: '{}' } },
            { id: 'kept', type: 'function', function: { name: 'g', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'r0', tool_call_id: 'call_0' },
        { role: 'tool', content: 'r1', tool_call_id: 'kept' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[0]?.tool_calls?.[1]?.id, 'kept');
    assert.equal(out.messages[1]?.tool_call_id, 'call_0');
    assert.equal(out.messages[2]?.tool_call_id, 'kept');
  });

  it('leaves non-tool requests free of tool fields', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'hi' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages.length, 2);
    assert.equal(out.messages[0]?.tool_calls, undefined);
    assert.equal(out.messages[1]?.tool_call_id, undefined);
    assert.equal(out.messages[1]?.content, 'hi');
  });

  it('resets pairing per round so a dangling call cannot capture the next result', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'g', arguments: '{}' } }],
        },
        { role: 'tool', content: 'r' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[1]?.tool_calls?.[0]?.id, 'call_1');
    assert.equal(out.messages[2]?.tool_call_id, 'call_1');
  });

  it('pairs each result with its own round across two assistant/tool pairs', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', content: 'r0' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'g', arguments: '{}' } }],
        },
        { role: 'tool', content: 'r1' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[1]?.tool_call_id, 'call_0');
    assert.equal(out.messages[2]?.tool_calls?.[0]?.id, 'call_1');
    assert.equal(out.messages[3]?.tool_call_id, 'call_1');
  });

  it('skips a synthetic id that collides with an explicit id', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_0', type: 'function', function: { name: 'f', arguments: '{}' } },
            { type: 'function', function: { name: 'g', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'r0' },
        { role: 'tool', content: 'r1' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[0]?.tool_calls?.[1]?.id, 'call_1');
    assert.equal(out.messages[1]?.tool_call_id, 'call_0');
    assert.equal(out.messages[2]?.tool_call_id, 'call_1');
  });

  it('falls back to the queued assistant id when a tool result omits its id', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'up', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', content: 'r' },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[1]?.tool_call_id, 'up');
  });

  it('leaves tool_call_id undefined when no call is awaiting', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [{ role: 'tool', content: 'r' }],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_call_id, undefined);
  });
});

describe('openai outbound tool_calls', () => {
  it('serializes tool_calls and tool_calls finish reason', () => {
    const res: ChatResponse = {
      id: 'x',
      model: 'm',
      created: 1,
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } },
      ],
    };
    const payload = chatResponseToOpenAI(res) as {
      choices: Array<{ message: Record<string, unknown>; finish_reason: string }>;
    };
    assert.equal(payload.choices[0]?.finish_reason, 'tool_calls');
    assert.deepEqual(payload.choices[0]?.message.tool_calls, res.tool_calls);
  });
});

describe('openai stream tool deltas', () => {
  it('emits tool_calls deltas on the chunk', () => {
    const chunk: StreamChunk = {
      id: 'x',
      model: 'm',
      created: 1,
      delta: '',
      finish_reason: 'tool_calls',
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '' } }],
    };
    const payload = streamChunkToOpenAI(chunk) as {
      choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
    };
    assert.equal(payload.choices[0]?.finish_reason, 'tool_calls');
    assert.deepEqual(payload.choices[0]?.delta.tool_calls, chunk.tool_calls);
  });

  it('does not add tool_calls key when absent', () => {
    const payload = streamChunkToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      delta: 'hi',
      finish_reason: 'stop',
    }) as { choices: Array<{ delta: Record<string, unknown> }> };
    assert.equal('tool_calls' in (payload.choices[0]?.delta ?? {}), false);
  });

  it('carries reasoning on the chunk alongside content delta', () => {
    const payload = streamChunkToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      delta: '',
      reasoning: 'thinking…',
    }) as { choices: Array<{ delta: Record<string, unknown> }> };
    assert.equal(payload.choices[0]?.delta.reasoning, 'thinking…');
  });
});

describe('toOpenAIMessages tool fields', () => {
  it('keeps tool_call_id, name and assistant tool_calls', async () => {
    const { toOpenAIMessages } = await import('../providers/openai-messages.js');
    const out = toOpenAIMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'call_1', name: 'f' },
    ]);
    assert.deepEqual(out[0], {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    });
    assert.equal((out[1] as { tool_call_id?: string }).tool_call_id, 'call_1');
    assert.equal((out[1] as { name?: string }).name, 'f');
  });

  it('omits an empty or undefined tool_call_id', async () => {
    const { toOpenAIMessages } = await import('../providers/openai-messages.js');
    const out = toOpenAIMessages([
      { role: 'tool', content: 'a', tool_call_id: '' },
      { role: 'tool', content: 'b' },
    ]);
    assert.equal('tool_call_id' in (out[0] ?? {}), false);
    assert.equal('tool_call_id' in (out[1] ?? {}), false);
  });
});

describe('anthropic inbound tools', () => {
  it('maps tools, tool_use blocks and raw', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SH' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }],
        },
      ],
      tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object' } }],
      max_tokens: 64,
      metadata: { user_id: 'u1' },
    } as unknown as AnthropicMessagesRequest;

    const out = anthropicToChatRequest(body);
    assert.equal(out.tools?.[0]?.function.name, 'get_weather');
    assert.deepEqual(out.raw, body);
    assert.equal(out.rawProtocol, 'anthropic');
    const assistant = out.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant?.tool_calls?.[0]?.id, 'toolu_1');
    assert.equal(assistant?.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(assistant?.tool_calls?.[0]?.function.arguments, '{"city":"SH"}');
    const toolMsg = out.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg?.tool_call_id, 'toolu_1');
    assert.equal(toolMsg?.content, 'sunny');
  });

  it('captures raw and rawProtocol without tools', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest;
    const out = anthropicToChatRequest(body);
    assert.equal(out.tools, undefined);
    assert.deepEqual(out.raw, body);
    assert.equal(out.rawProtocol, 'anthropic');
  });

  it('keeps sibling text when a tool_result turn also carries text', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' },
            { type: 'text', text: 'now summarize' },
          ],
        },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    const toolMsg = out.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg?.content, 'sunny');
    const summary = out.messages.find((m) => m.role === 'user' && m.content === 'now summarize');
    assert.ok(summary, 'sibling text must not be dropped');
  });

  it('normalizes null tool_use input to {}', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'f', input: null }],
        },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.function.arguments, '{}');
  });
});

describe('anthropic inbound tool id pairing', () => {
  it('derives matching ids for tool_use without id and its tool_result', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', name: 'f', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    const assistant = out.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant?.tool_calls?.[0]?.id, 'call_0');
    const toolMsg = out.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg?.tool_call_id, 'call_0');
  });

  it('numbers multiple derived ids in order across messages', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'f', input: {} },
            { type: 'tool_use', name: 'g', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'r0' },
            { type: 'tool_result', content: 'r1' },
          ],
        },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    const assistant = out.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(assistant?.tool_calls?.[1]?.id, 'call_1');
    const toolMsgs = out.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs[0]?.tool_call_id, 'call_0');
    assert.equal(toolMsgs[1]?.tool_call_id, 'call_1');
  });

  it('adopts an explicit tool_result id when tool_use omitted its id', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }] },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    const assistant = out.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant?.tool_calls?.[0]?.id, 'toolu_9');
    const toolMsg = out.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg?.tool_call_id, 'toolu_9');
  });

  it('keeps explicit tool_use ids untouched', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_a', name: 'f', input: {} }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    const assistant = out.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant?.tool_calls?.[0]?.id, 'toolu_a');
    const toolMsg = out.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg?.tool_call_id, 'toolu_a');
  });

  it('resets pairing per round so a dangling tool_use cannot capture the next result', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', name: 'f', input: {} }] },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'g', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'r' }] },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[1]?.tool_calls?.[0]?.id, 'call_1');
    assert.equal(out.messages[2]?.tool_call_id, 'call_1');
  });

  it('pairs each result with its own round across two assistant/tool pairs', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'r0' }] },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'g', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'r1' }] },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[1]?.tool_call_id, 'call_0');
    assert.equal(out.messages[2]?.tool_calls?.[0]?.id, 'call_1');
    assert.equal(out.messages[3]?.tool_call_id, 'call_1');
  });

  it('skips a synthetic id that collides with an explicit tool_use id', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_0', name: 'f', input: {} },
            { type: 'tool_use', name: 'g', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'r0' },
            { type: 'tool_result', content: 'r1' },
          ],
        },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(out.messages[0]?.tool_calls?.[1]?.id, 'call_1');
    const toolMsgs = out.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs[0]?.tool_call_id, 'call_0');
    assert.equal(toolMsgs[1]?.tool_call_id, 'call_1');
  });

  it('leaves tool_call_id undefined when no tool_use is awaiting', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'r' }] }],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    assert.equal(out.messages[0]?.tool_call_id, undefined);
  });
});

describe('anthropic outbound tool_use', () => {
  it('emits a tool_use block and stop_reason tool_use', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_1',
      model: 'm',
      created: 1,
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } },
      ],
    }) as { content: Array<Record<string, unknown>>; stop_reason: string };
    assert.equal(payload.stop_reason, 'tool_use');
    const block = payload.content[0] as Record<string, unknown>;
    assert.equal(block.type, 'tool_use');
    assert.equal(block.id, 'call_1');
    assert.equal(block.name, 'f');
    assert.deepEqual(block.input, { q: 1 });
  });

  it('keeps text block when there are no tool calls', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_1',
      model: 'm',
      created: 1,
      content: 'hello',
      finish_reason: 'stop',
    }) as { content: Array<Record<string, unknown>>; stop_reason: string };
    assert.equal(payload.stop_reason, 'end_turn');
    assert.deepEqual(payload.content, [{ type: 'text', text: 'hello' }]);
  });

  it('falls back to an empty object for non-object tool arguments', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_2',
      model: 'm',
      created: 1,
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: 'null' } }],
    }) as { content: Array<Record<string, unknown>> };
    const block = payload.content[0] as Record<string, unknown>;
    assert.deepEqual(block.input, {});
  });

  it('normalizes array/scalar arguments to an object', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_3',
      model: 'm',
      created: 1,
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'f', arguments: '[1,2]' } },
        { id: 'c2', type: 'function', function: { name: 'g', arguments: '42' } },
      ],
    }) as { content: Array<Record<string, unknown>>; stop_reason: string };
    assert.deepEqual((payload.content[0] as Record<string, unknown>).input, {});
    assert.deepEqual((payload.content[1] as Record<string, unknown>).input, {});
    assert.equal(payload.stop_reason, 'tool_use');
  });

  it('keeps assistant text alongside tool_use blocks', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_4',
      model: 'm',
      created: 1,
      content: 'let me check',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    }) as { content: Array<Record<string, unknown>> };
    assert.deepEqual(payload.content[0], { type: 'text', text: 'let me check' });
    assert.equal((payload.content[1] as Record<string, unknown>).type, 'tool_use');
  });

  it('does not duplicate reasoning-only text as a second block', () => {
    const payload = chatResponseToAnthropic({
      id: 'm',
      model: 'm',
      created: 1,
      content: 'think',
      reasoning: 'think',
      finish_reason: 'stop',
    }) as { content: Array<Record<string, unknown>> };
    assert.deepEqual(payload.content, [{ type: 'text', text: 'think' }]);
  });
});

describe('gemini inbound tools', () => {
  it('maps functionDeclarations, functionCall and functionResponse', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'SH' } } }],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'get_weather', response: { r: 'sunny' } } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] }],
      generationConfig: { temperature: 0.2 },
    } as unknown as GeminiHttpRequest;

    const out = geminiToChatRequest('m', body);
    assert.equal(out.tools?.[0]?.function.name, 'get_weather');
    assert.deepEqual(out.raw, body);
    assert.equal(out.rawProtocol, 'gemini');

    const modelMsg = out.messages.find((m) => m.role === 'assistant');
    assert.equal(modelMsg?.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(modelMsg?.tool_calls?.[0]?.function.arguments, '{"city":"SH"}');

    const fnResp = out.messages.find((m) => m.role === 'tool');
    assert.equal(fnResp?.content, '{"r":"sunny"}');
    assert.equal(fnResp?.name, 'get_weather');
  });

  it('captures raw and rawProtocol without tools', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    } as unknown as GeminiHttpRequest;
    const out = geminiToChatRequest('m', body);
    assert.equal(out.tools, undefined);
    assert.deepEqual(out.raw, body);
    assert.equal(out.rawProtocol, 'gemini');
  });
});

describe('gemini outbound functionCall', () => {
  it('emits a functionCall part and maps finish reason to STOP', () => {
    const payload = chatResponseToGemini({
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } }],
    }) as {
      candidates: Array<{
        content: { parts: Array<Record<string, unknown>> };
        finishReason: string;
      }>;
    };
    assert.equal(payload.candidates[0]?.finishReason, 'STOP');
    const part = payload.candidates[0]?.content.parts[0] as Record<string, unknown>;
    assert.equal((part.functionCall as { name: string }).name, 'f');
    assert.deepEqual((part.functionCall as { args: unknown }).args, { q: 1 });
  });

  it('normalizes non-object arguments to an empty object', () => {
    const payload = chatResponseToGemini({
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '[1,2]' } }],
    }) as { candidates: Array<{ content: { parts: Array<Record<string, unknown>> } }> };
    const part = payload.candidates[0]?.content.parts[0] as {
      functionCall: { args: unknown };
    };
    assert.deepEqual(part.functionCall.args, {});
  });

  it('keeps text part when there are no tool calls', () => {
    const payload = chatResponseToGemini({
      content: 'hello',
      finish_reason: 'stop',
    }) as { candidates: Array<{ content: { parts: Array<Record<string, unknown>> } }> };
    assert.deepEqual(payload.candidates[0]?.content.parts, [{ text: 'hello' }]);
  });
});

describe('response raw carrier', () => {
  it('passes the raw OpenAI body through for an openai -> openai response', () => {
    const raw = { id: 'x', object: 'chat.completion', secretUpstreamField: 1 };
    const payload = chatResponseToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      content: 'hi',
      finish_reason: 'stop',
      raw,
      rawProtocol: 'openai',
    });
    assert.equal(payload, raw);
  });

  it('does not leak a cross-protocol raw body into the OpenAI wire payload', () => {
    const payload = chatResponseToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      content: 'hi',
      finish_reason: 'stop',
      raw: { secretUpstreamField: 1 },
      rawProtocol: 'anthropic',
    }) as Record<string, unknown>;
    assert.equal('raw' in payload, false);
    assert.equal(JSON.stringify(payload).includes('secretUpstreamField'), false);
  });

  it('serializes structurally when the OpenAI raw carrier is an event array', () => {
    const payload = chatResponseToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      content: 'hi',
      finish_reason: 'stop',
      raw: [{ data: '{"delta":"hi"}' }],
      rawProtocol: 'openai',
    }) as Record<string, unknown>;
    assert.equal(Array.isArray(payload), false);
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.model, 'm');
    assert.equal('raw' in payload, false);
    assert.equal(JSON.stringify(payload).includes('"data"'), false);
  });

  it('passes the raw Anthropic body through for an anthropic -> anthropic response', () => {
    const raw = { id: 'msg_1', type: 'message', secretUpstreamField: 1 };
    const payload = chatResponseToAnthropic({
      id: 'msg_1',
      model: 'm',
      created: 1,
      content: 'hi',
      finish_reason: 'stop',
      raw,
      rawProtocol: 'anthropic',
    });
    assert.equal(payload, raw);
  });

  it('does not leak a cross-protocol raw body into the Anthropic wire payload', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_1',
      model: 'm',
      created: 1,
      content: 'hi',
      finish_reason: 'stop',
      raw: { secretUpstreamField: 1 },
      rawProtocol: 'openai',
    }) as Record<string, unknown>;
    assert.equal('raw' in payload, false);
    assert.equal(JSON.stringify(payload).includes('secretUpstreamField'), false);
  });

  it('serializes structurally when the Anthropic raw carrier is an event array', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_1',
      model: 'm',
      created: 1,
      content: 'hi',
      finish_reason: 'stop',
      raw: [{ data: '{"delta":"hi"}' }],
      rawProtocol: 'anthropic',
    }) as Record<string, unknown>;
    assert.equal(Array.isArray(payload), false);
    assert.equal(payload.type, 'message');
    assert.equal(payload.model, 'm');
    assert.equal('raw' in payload, false);
    assert.equal(JSON.stringify(payload).includes('"data"'), false);
  });

  it('does not leak StreamChunk.raw into the OpenAI stream delta', () => {
    const payload = streamChunkToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      delta: 'hi',
      raw: { secretUpstreamField: 1 },
      rawProtocol: 'openai',
    }) as Record<string, unknown>;
    assert.equal(JSON.stringify(payload).includes('secretUpstreamField'), false);
  });
});
