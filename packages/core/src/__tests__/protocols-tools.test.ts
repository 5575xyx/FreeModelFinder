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
