import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatRequest, ModelInfo, ProviderId, StreamChunk } from '../../types.js';
import type { BaseProvider, ProviderContext } from '../base.js';
import { CohereProvider } from '../cohere.js';
import { CustomProvider } from '../custom.js';
import { GeminiProvider } from '../gemini.js';
import { GitHubModelsProvider } from '../github.js';
import { HuggingFaceProvider } from '../huggingface.js';
import { ModelScopeProvider } from '../modelscope.js';
import { NvidiaProvider } from '../nvidia.js';
import { OpenAICompatibleProvider } from '../openai-compatible.js';
import { OpenRouterProvider } from '../openrouter.js';
import { QianfanProvider } from '../qianfan.js';
import { SenseNovaProvider } from '../sensenova.js';
import { SiliconFlowProvider } from '../siliconflow.js';
import { ZhipuProvider } from '../zhipu.js';
import { KiloProvider } from '../kilo.js';
import { AgnesProvider } from '../agnes.js';

type ProviderConstructor = new (context: ProviderContext) => BaseProvider;

const openAiCompatibleProviders: Array<[string, ProviderConstructor]> = [
  ['openrouter', OpenRouterProvider],
  ['zhipu', ZhipuProvider],
  ['siliconflow', SiliconFlowProvider],
  ['modelscope', ModelScopeProvider],
  ['nvidia', NvidiaProvider],
  ['github', GitHubModelsProvider],
  ['cohere', CohereProvider],
  ['huggingface', HuggingFaceProvider],
  ['sensenova', SenseNovaProvider],
  ['qianfan', QianfanProvider],
  ['kilo', KiloProvider],
  ['agnes', AgnesProvider],
];

const chatRequest: ChatRequest = {
  model: 'fixture-model',
  messages: [{ role: 'user', content: 'hello' }],
  stream: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function openAiChatFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
    if (body.stream) {
      return new Response(
        [
          'data: {"id":"stream-1","model":"fixture-model","created":1,"choices":[{"index":0,"delta":{"content":"hello "},"finish_reason":null}]}',
          'data: {"id":"stream-1","model":"fixture-model","created":1,"choices":[{"index":0,"delta":{"content":"world"},"finish_reason":"stop"}]}',
          'data: [DONE]',
          '',
        ].join('\n\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return jsonResponse({
      id: 'chat-1',
      model: 'fixture-model',
      created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  }) as typeof fetch;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('built-in provider chat contracts', () => {
  for (const [id, Provider] of openAiCompatibleProviders) {
    it(`${id} supports non-streaming, streaming and 429 errors`, async () => {
      const provider = new Provider({
        credentials: { apiKey: 'test-key' },
        fetchImpl: openAiChatFetch(),
      });
      const response = await provider.chat(chatRequest);
      assert.equal(response.content, 'hello world');
      assert.equal(response.usage?.total_tokens, 3);

      const chunks = await collect(provider.stream({ ...chatRequest, stream: true }));
      assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'hello world');

      const limited = new Provider({
        credentials: { apiKey: 'test-key' },
        fetchImpl: (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
      });
      await assert.rejects(limited.chat(chatRequest), new RegExp(`${id} chat failed 429`));
      await assert.rejects(
        async () => collect(limited.stream({ ...chatRequest, stream: true })),
        new RegExp(`${id} stream failed 429`),
      );
    });
  }

  it('Gemini supports non-streaming, streaming and 429 errors', async () => {
    const provider = new GeminiProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).includes(':streamGenerateContent')) {
          return new Response(
            [
              'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello "}]}}]}',
              'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"world"}]},"finishReason":"STOP"}]}',
              '',
            ].join('\n\n'),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return jsonResponse({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'hello ' }, { text: 'world' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        });
      }) as typeof fetch,
    });
    const response = await provider.chat(chatRequest);
    assert.equal(response.content, 'hello world');
    assert.equal(response.usage?.total_tokens, 3);
    const chunks = await collect(provider.stream({ ...chatRequest, stream: true }));
    assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'hello world');

    const limited = new GeminiProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
    });
    await assert.rejects(limited.chat(chatRequest), /gemini chat failed 429/);
    await assert.rejects(
      async () => collect(limited.stream({ ...chatRequest, stream: true })),
      /gemini stream failed 429/,
    );
  });

  it('Custom Source supports catalog, chat, stream, 429 and empty configuration', async () => {
    const credentials = {
      apiKey: '',
      extra: {
        sources: [
          {
            id: 'fixture',
            label: 'Fixture',
            baseUrl: 'https://fixture.invalid/v1',
            apiKey: 'custom-key',
            models: [{ id: 'fixture-model', displayName: 'Fixture Model' }],
          },
        ],
      },
    };
    const provider = new CustomProvider({ credentials, fetchImpl: openAiChatFetch() });
    const models = await provider.listModels();
    assert.deepEqual(
      models.map((model) => model.id),
      ['fixture:fixture-model'],
    );
    const customRequest = { ...chatRequest, model: 'fixture:fixture-model' };
    const aliasFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const res = await openAiChatFetch()(input, init);
      const text = await res.text();
      const rewritten = text
        .replace(/"model":\s*"fixture-model"/g, '"model":"upstream-alias"')
        .replace(/"model":"fixture-model"/g, '"model":"upstream-alias"');
      return new Response(rewritten, {
        status: res.status,
        headers: {
          'content-type': String(init?.body ?? '').includes('"stream":true')
            ? 'text/event-stream'
            : 'application/json',
        },
      });
    }) as typeof fetch;
    const echoProvider = new CustomProvider({ credentials, fetchImpl: aliasFetch });
    const chatResponse = await echoProvider.chat(customRequest);
    assert.equal(chatResponse.content, 'hello world');
    // upstream echoes a different model alias; response must still carry the
    // gateway-level composed id so clients reusing response.model stay routable
    assert.equal(chatResponse.model, 'fixture:fixture-model');
    const echoChunks = await collect(echoProvider.stream({ ...customRequest, stream: true }));
    assert.equal(echoChunks.map((chunk) => chunk.delta).join(''), 'hello world');
    assert.equal(echoChunks[0]?.model, 'fixture:fixture-model');

    const limited = new CustomProvider({
      credentials,
      fetchImpl: (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
    });
    await assert.rejects(limited.chat(customRequest), /custom chat failed 429/);
    await assert.rejects(
      async () => collect(limited.stream({ ...customRequest, stream: true })),
      /custom stream failed 429/,
    );
    assert.deepEqual(await new CustomProvider({ credentials: { apiKey: '' } }).listModels(), []);
  });
});

describe('provider empty-catalog contracts', () => {
  it('distinguishes empty upstream data from audited static fallbacks', async () => {
    const cases: Array<[string, BaseProvider, 'empty' | 'fallback' | 'error']> = [
      [
        'openrouter',
        new OpenRouterProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ data: [] }),
        }),
        'empty',
      ],
      [
        'gemini',
        new GeminiProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ models: [] }),
        }),
        'error',
      ],
      ['zhipu', new ZhipuProvider({ credentials: { apiKey: 'key' } }), 'fallback'],
      [
        'siliconflow',
        new SiliconFlowProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ data: [] }),
        }),
        'error',
      ],
      [
        'modelscope',
        new ModelScopeProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ data: [] }),
        }),
        'fallback',
      ],
      [
        'nvidia',
        new NvidiaProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ data: [] }),
        }),
        'empty',
      ],
      [
        'github',
        new GitHubModelsProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse([]),
        }),
        'empty',
      ],
      [
        'cohere',
        new CohereProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ models: [] }),
        }),
        'error',
      ],
      [
        'huggingface',
        new HuggingFaceProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ data: [] }),
        }),
        'error',
      ],
      [
        'sensenova',
        new SenseNovaProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ data: [] }),
        }),
        'fallback',
      ],
      [
        'qianfan',
        new QianfanProvider({
          credentials: { apiKey: 'key' },
          fetchImpl: async () => jsonResponse({ data: [] }),
        }),
        'empty',
      ],
    ];

    for (const [id, provider, expected] of cases) {
      if (expected === 'error') {
        await assert.rejects(provider.listModels(), /empty|no chat models/);
        continue;
      }
      const models = await provider.listModels();
      assert.equal(models.length > 0 ? 'fallback' : 'empty', expected, id);
    }
  });
});

class ReasoningProbeProvider extends OpenAICompatibleProvider {
  readonly id: ProviderId = 'ollama';
  readonly displayName = 'Probe';
  protected baseUrl(): string {
    return 'https://upstream.example/v1';
  }
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}

const REASONING_SSE = [
  'data: {"id":"c1","model":"m","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"step one"},"finish_reason":null}]}',
  '',
  'data: {"id":"c1","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

describe('openai-compatible reasoning field', () => {
  it('surfaces reasoning on the chunk without dropping it', async () => {
    const provider = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: (async () =>
        new Response(REASONING_SSE, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch,
    });
    const seen: Array<{ delta: string; reasoning?: string }> = [];
    for await (const chunk of provider.stream({ model: 'm', messages: [], stream: true })) {
      seen.push({ delta: chunk.delta, ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}) });
    }
    assert.equal(seen[0]?.reasoning, 'step one');
    assert.equal(seen[0]?.delta, 'step one');
    assert.equal(seen[1]?.delta, 'answer');
  });

  it('does not send raw or rawProtocol upstream', async () => {
    let captured = '';
    const provider = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        captured = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            id: 'x',
            model: 'm',
            created: 1,
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    await provider.chat({
      model: 'm',
      messages: [],
      stream: false,
      tools: [{ type: 'function', function: { name: 'f' } }],
      raw: { secret: 1 },
      rawProtocol: 'openai',
    });
    const body = JSON.parse(captured) as Record<string, unknown>;
    assert.equal('raw' in body, false);
    assert.equal('rawProtocol' in body, false);
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'f' } }]);
  });
});

const TOOL_CHAT_RESPONSE = {
  id: 'tool-1',
  model: 'm',
  created: 1,
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"SH"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

const TOOL_SSE = [
  'data: {"id":"c1","model":"m","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
  '',
  'data: {"id":"c1","model":"m","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"SH\\"}"}}]},"finish_reason":"tool_calls"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

describe('openai-compatible tool_calls', () => {
  it('fills tool_calls and maps finish_reason on chat', async () => {
    const provider = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: (async () =>
        new Response(JSON.stringify(TOOL_CHAT_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    const res = await provider.chat({ model: 'm', messages: [], stream: false });
    assert.equal(res.content, '');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.deepEqual(res.tool_calls, [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"SH"}' },
      },
    ]);
    assert.equal(res.usage?.total_tokens, 3);
  });

  it('maps a legacy function_call finish reason to tool_calls', async () => {
    const provider = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 'c',
            model: 'm',
            created: 1,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'function_call',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    const res = await provider.chat({ model: 'm', messages: [], stream: false });
    assert.equal(res.finish_reason, 'tool_calls');
  });

  it('normalizes a non-standard finish_reason to stop or null', async () => {
    const provider = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 'c',
            model: 'm',
            created: 1,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'eos',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    const res = await provider.chat({ model: 'm', messages: [], stream: false });
    assert.equal(res.finish_reason, 'stop');

    const streamProvider = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: (async () =>
        new Response(
          [
            'data: {"id":"c","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"eos"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )) as typeof fetch,
    });
    const chunks = await collect(streamProvider.stream({ model: 'm', messages: [], stream: true }));
    assert.equal(chunks[0]?.finish_reason, null);
  });

  it('emits tool_call deltas including tool-only frames', async () => {
    const provider = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: (async () =>
        new Response(TOOL_SSE, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch,
    });
    const chunks = await collect(provider.stream({ model: 'm', messages: [], stream: true }));
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.delta, '');
    assert.deepEqual(chunks[0]?.tool_calls, [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '' },
      },
    ]);
    assert.equal(chunks[1]?.delta, '');
    assert.deepEqual(chunks[1]?.tool_calls, [
      { index: 0, type: 'function', function: { arguments: '{"city":"SH"}' } },
    ]);
    assert.equal(chunks[1]?.finish_reason, 'tool_calls');
  });
});

describe('custom provider tool_calls', () => {
  const credentials = {
    apiKey: '',
    extra: {
      sources: [
        {
          id: 'fx',
          label: 'Fx',
          baseUrl: 'https://fx.invalid/v1',
          apiKey: 'k',
          models: [{ id: 'm' }],
        },
      ],
    },
  };
  const toolFetch = (payload: unknown): typeof fetch =>
    (async (_input: string | URL | Request, init?: RequestInit) => {
      const stream = String(init?.body ?? '').includes('"stream":true');
      return new Response(stream ? TOOL_SSE : JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
      });
    }) as typeof fetch;

  it('fills tool_calls on chat and stream', async () => {
    const provider = new CustomProvider({ credentials, fetchImpl: toolFetch(TOOL_CHAT_RESPONSE) });
    const res = await provider.chat({ model: 'fx:m', messages: [], stream: false });
    assert.equal(res.content, '');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.deepEqual(res.tool_calls, [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"SH"}' },
      },
    ]);

    const chunks = await collect(provider.stream({ model: 'fx:m', messages: [], stream: true }));
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.delta, '');
    assert.deepEqual(chunks[0]?.tool_calls, [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '' },
      },
    ]);
    assert.equal(chunks[1]?.delta, '');
    assert.deepEqual(chunks[1]?.tool_calls, [
      { index: 0, type: 'function', function: { arguments: '{"city":"SH"}' } },
    ]);
    assert.equal(chunks[1]?.finish_reason, 'tool_calls');
  });
});

const REASONING_ONLY_RESPONSE = {
  id: 'r1',
  model: 'm',
  created: 1,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '', reasoning: 'think' },
      finish_reason: 'stop',
    },
  ],
};

function reasoningOnlyFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(REASONING_ONLY_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('custom provider reasoning parity', () => {
  it('does not surface reasoning on chat while the base class does', async () => {
    const base = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: reasoningOnlyFetch(),
    });
    const baseRes = await base.chat({ model: 'm', messages: [], stream: false });
    assert.equal(baseRes.content, 'think');
    assert.equal(baseRes.reasoning, 'think');

    const custom = new CustomProvider({
      credentials: {
        apiKey: '',
        extra: {
          sources: [
            {
              id: 'fx',
              label: 'Fx',
              baseUrl: 'https://fx.invalid/v1',
              apiKey: 'k',
              models: [{ id: 'm' }],
            },
          ],
        },
      },
      fetchImpl: reasoningOnlyFetch(),
    });
    const customRes = await custom.chat({ model: 'fx:m', messages: [], stream: false });
    assert.equal(customRes.content, 'think');
    assert.equal('reasoning' in customRes, false);
  });
});
