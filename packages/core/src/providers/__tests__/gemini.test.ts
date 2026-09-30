import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GeminiProvider } from '../gemini.js';
import { geminiToChatRequest } from '../../protocols/gemini.js';
import type { ChatRequest, StreamChunk, ToolDefinition } from '../../types.js';

interface Capture {
  body?: Record<string, unknown>;
}

function hasContentKey(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'content' in (value as Record<string, unknown>)
  );
}

function jsonProvider(response: unknown, capture: Capture): GeminiProvider {
  return new GeminiProvider({
    credentials: { apiKey: 'test-key' },
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      capture.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
}

function sseProvider(frames: unknown[], capture: Capture): GeminiProvider {
  return new GeminiProvider({
    credentials: { apiKey: 'test-key' },
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      capture.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
      return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  });
}

function textResponse(text: string): unknown {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
  };
}

function baseReq(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'gemini-3.5-flash',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

const weatherTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

describe('gemini tools shaping', () => {
  it('omits the tools key entirely when the request has no tools', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(baseReq());
    assert.equal('tools' in (capture.body ?? {}), false);
  });

  it('maps OpenAI tool definitions into Gemini functionDeclarations', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(baseReq({ tools: [weatherTool] }));
    assert.deepEqual(capture.body?.tools, [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
    ]);
  });

  it('drops empty description and parameters instead of sending nulls', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(baseReq({ tools: [{ type: 'function', function: { name: 'noop' } }] }));
    assert.deepEqual(capture.body?.tools, [{ functionDeclarations: [{ name: 'noop' }] }]);
  });
});

describe('gemini functionCall response parsing', () => {
  it('maps a functionCall part into tool_calls and finish_reason tool_calls', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }],
            },
            finishReason: 'STOP',
          },
        ],
      },
      capture,
    );
    const res = await provider.chat(baseReq());
    assert.equal(res.content, '');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.length, 1);
    assert.equal(res.tool_calls?.[0]?.id, 'call_0');
    assert.equal(res.tool_calls?.[0]?.type, 'function');
    assert.equal(res.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(res.tool_calls?.[0]?.function.arguments, '{"city":"SF"}');
  });

  it('parses multiple functionCalls, assigns call_<index> ids and coerces missing args', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: 'a', args: { x: 1 } } },
                { functionCall: { name: 'b' } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
      capture,
    );
    const res = await provider.chat(baseReq());
    assert.equal(res.tool_calls?.length, 2);
    assert.equal(res.tool_calls?.[0]?.id, 'call_0');
    assert.equal(res.tool_calls?.[0]?.function.name, 'a');
    assert.equal(res.tool_calls?.[0]?.function.arguments, '{"x":1}');
    assert.equal(res.tool_calls?.[1]?.id, 'call_1');
    assert.equal(res.tool_calls?.[1]?.function.name, 'b');
    assert.equal(res.tool_calls?.[1]?.function.arguments, '{}');
  });

  it('keeps an upstream functionCall id when one is present', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'upstream-1', name: 'a', args: {} } }],
            },
            finishReason: 'STOP',
          },
        ],
      },
      capture,
    );
    const res = await provider.chat(baseReq());
    assert.equal(res.tool_calls?.[0]?.id, 'upstream-1');
  });

  it('keeps plain text responses unchanged without functionCall', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('hello'), capture);
    const res = await provider.chat(baseReq());
    assert.equal(res.content, 'hello');
    assert.equal(res.finish_reason, 'stop');
    assert.equal(res.tool_calls, undefined);
  });

  it('maps MAX_TOKENS to length when no functionCall is present', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(
      {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' },
        ],
      },
      capture,
    );
    const res = await provider.chat(baseReq());
    assert.equal(res.finish_reason, 'length');
  });

  it('keeps length when MAX_TOKENS arrives alongside a functionCall', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      },
      capture,
    );
    const res = await provider.chat(baseReq());
    assert.equal(res.finish_reason, 'length');
    assert.equal(res.tool_calls?.[0]?.function.name, 'a');
  });

  it('keeps both text content and tool_calls when a response mixes them', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'calling a tool' }, { functionCall: { name: 'a', args: { x: 1 } } }],
            },
            finishReason: 'STOP',
          },
        ],
      },
      capture,
    );
    const res = await provider.chat(baseReq());
    assert.equal(res.content, 'calling a tool');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.id, 'call_0');
    assert.equal(res.tool_calls?.[0]?.function.name, 'a');
  });
});

describe('gemini functionCall / functionResponse outbound', () => {
  it('encodes assistant tool_calls as model functionCall parts', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(
      baseReq({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(capture.body?.contents, [
      { role: 'user', parts: [{ text: 'weather?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }] },
    ]);
  });

  it('encodes tool results as user functionResponse parts resolved by tool_call_id', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(
      baseReq({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
          { role: 'tool', content: '{"temp":25}', tool_call_id: 'call_1' },
        ],
      }),
    );
    assert.deepEqual(capture.body?.contents, [
      { role: 'user', parts: [{ text: 'weather?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { temp: 25 } } }],
      },
    ]);
  });

  it('wraps non-object tool content in a content key and groups consecutive results', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(
      baseReq({
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
            ],
          },
          { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
          { role: 'tool', content: '[1,2]', tool_call_id: 'call_2' },
        ],
      }),
    );
    assert.deepEqual(capture.body?.contents, [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'a', args: {} } },
          { functionCall: { name: 'b', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'a', response: { content: 'sunny' } } },
          { functionResponse: { name: 'b', response: { content: [1, 2] } } },
        ],
      },
    ]);
  });

  it('falls back to the tool message name when the id is unknown', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(
      baseReq({
        messages: [
          { role: 'assistant', content: '', tool_calls: [] },
          { role: 'tool', name: 'get_weather', content: '{"temp":25}', tool_call_id: 'missing' },
        ],
      }),
    );
    assert.deepEqual(capture.body?.contents, [
      { role: 'model', parts: [{ text: '' }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { temp: 25 } } }],
      },
    ]);
  });

  it('round-trips a Gemini functionResponse without nesting a content wrapper', async () => {
    const inbound = geminiToChatRequest('gemini-3.5-flash', {
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'get_weather', response: { temp: 25 } } }],
        },
      ],
    });
    const toolMessage = inbound.messages.find((m) => m.role === 'tool');
    assert.equal(toolMessage?.content, '{"temp":25}');
    assert.equal(toolMessage?.name, 'get_weather');

    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(baseReq({ messages: inbound.messages }));
    const contents = capture.body?.contents as Array<{
      role: string;
      parts: Array<{ functionResponse?: { name?: string; response?: unknown } }>;
    }>;
    const responsePart = contents[contents.length - 1]?.parts[0]?.functionResponse;
    assert.equal(responsePart?.name, 'get_weather');
    assert.deepEqual(responsePart?.response, { temp: 25 });
    assert.equal(hasContentKey(responsePart?.response), false);
  });

  it('resolves the function name for every tool result across multiple rounds', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(
      baseReq({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'alpha', arguments: '{}' } },
            ],
          },
          { role: 'tool', content: '{"n":1}', tool_call_id: 'call_1' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_2', type: 'function', function: { name: 'beta', arguments: '{}' } },
            ],
          },
          { role: 'tool', content: '{"n":2}', tool_call_id: 'call_2' },
        ],
      }),
    );
    assert.deepEqual(capture.body?.contents, [
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [{ functionCall: { name: 'alpha', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'alpha', response: { n: 1 } } }] },
      { role: 'model', parts: [{ functionCall: { name: 'beta', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'beta', response: { n: 2 } } }] },
    ]);
  });

  it('skips a tool message whose function name cannot be resolved', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(
      baseReq({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'tool', content: '{"n":1}', tool_call_id: 'unknown-id' },
        ],
      }),
    );
    const contents = capture.body?.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    assert.equal(
      contents.some((c) => c.parts.some((p) => 'functionResponse' in p)),
      false,
    );
  });

  it('does not attach an id to outbound functionCall parts', async () => {
    const capture: Capture = {};
    const provider = jsonProvider(textResponse('ok'), capture);
    await provider.chat(
      baseReq({
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
            ],
          },
        ],
      }),
    );
    const contents = capture.body?.contents as Array<{
      parts: Array<{ functionCall?: Record<string, unknown> }>;
    }>;
    const fnCall = contents[0]?.parts[0]?.functionCall;
    assert.deepEqual(fnCall, { name: 'a', args: {} });
    assert.equal('id' in (fnCall ?? {}), false);
  });
});

describe('gemini streaming functionCall', () => {
  it('emits streamed functionCall parts as tool_call deltas with index and call ids', async () => {
    const capture: Capture = {};
    const provider = sseProvider(
      [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { functionCall: { name: 'a', args: { x: 1 } } },
                  { functionCall: { name: 'b', args: {} } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ],
      capture,
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(baseReq({ stream: true }))) chunks.push(chunk);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.delta, '');
    assert.equal(chunks[0]?.finish_reason, 'tool_calls');
    assert.equal(chunks[0]?.tool_calls?.[0]?.index, 0);
    assert.equal(chunks[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(chunks[0]?.tool_calls?.[0]?.function?.name, 'a');
    assert.equal(chunks[0]?.tool_calls?.[0]?.function?.arguments, '{"x":1}');
    assert.equal(chunks[0]?.tool_calls?.[1]?.index, 1);
    assert.equal(chunks[0]?.tool_calls?.[1]?.id, 'call_1');
    assert.equal(chunks[0]?.tool_calls?.[1]?.function?.name, 'b');
    assert.equal(chunks[0]?.tool_calls?.[1]?.function?.arguments, '{}');
  });

  it('keeps index and call id increasing across streamed frames', async () => {
    const capture: Capture = {};
    const provider = sseProvider(
      [
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }] },
              finishReason: null,
            },
          ],
        },
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ functionCall: { name: 'b', args: {} } }] },
              finishReason: 'STOP',
            },
          ],
        },
      ],
      capture,
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(baseReq({ stream: true }))) chunks.push(chunk);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.tool_calls?.[0]?.index, 0);
    assert.equal(chunks[0]?.tool_calls?.[0]?.id, 'call_0');
    assert.equal(chunks[1]?.tool_calls?.[0]?.index, 1);
    assert.equal(chunks[1]?.tool_calls?.[0]?.id, 'call_1');
    assert.equal(chunks[1]?.finish_reason, 'tool_calls');
  });

  it('does not mark a non-final functionCall frame as tool_calls', async () => {
    const capture: Capture = {};
    const provider = sseProvider(
      [
        {
          candidates: [
            {
              content: { role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }] },
              finishReason: null,
            },
          ],
        },
      ],
      capture,
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(baseReq({ stream: true }))) chunks.push(chunk);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.tool_calls?.[0]?.function?.name, 'a');
    assert.notEqual(chunks[0]?.finish_reason, 'tool_calls');
    assert.equal(chunks[0]?.finish_reason, null);
  });

  it('keeps streaming text deltas unchanged when no functionCall appears', async () => {
    const capture: Capture = {};
    const provider = sseProvider(
      [
        {
          candidates: [{ content: { role: 'model', parts: [{ text: 'he' }] }, finishReason: null }],
        },
        {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'llo' }] }, finishReason: 'STOP' },
          ],
        },
      ],
      capture,
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(baseReq({ stream: true }))) chunks.push(chunk);
    assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'hello');
    assert.equal(chunks[0]?.tool_calls, undefined);
    assert.equal(chunks[1]?.finish_reason, 'stop');
  });
});
