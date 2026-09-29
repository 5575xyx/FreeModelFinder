import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { ZenHttpClient, ZenHttpRequest, ZenHttpResponse } from '@freemodelfinder/zen';
import { ZenProvider } from '../zen.js';

const ZEN_MODELS = {
  object: 'list',
  data: [{ id: 'free-model' }, { id: 'paid-model' }],
};

const GO_MODELS = {
  object: 'list',
  data: [{ id: 'free-model' }],
};

const CAPABILITIES = {
  opencode: {
    api: 'https://opencode.ai/zen',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'free-model': { id: 'free-model', limit: { context: 128000, output: 4096 } },
      'paid-model': { id: 'paid-model' },
    },
  },
};

const MODELS_DEV = {
  opencode: {
    id: 'opencode',
    models: {
      'free-model': { id: 'free-model', cost: { input: 0, output: 0 } },
      'paid-model': { id: 'paid-model', cost: { input: 1, output: 2 } },
    },
  },
};

const CHAT_BODY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'free-model',
  created: 123,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

function webJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fixedFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('models.opencode.ai')) return webJson(CAPABILITIES);
    if (url.includes('models.dev')) return webJson(MODELS_DEV);
    if (url.endsWith('/go/v1/models')) return webJson(GO_MODELS);
    if (url.endsWith('/v1/models')) return webJson(ZEN_MODELS);
    if (url.includes('.mdx')) return new Response('', { status: 404 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  return impl as unknown as typeof fetch;
}

function inboundJson(status: number, body: unknown): ZenHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage,
  };
}

class FakeClient implements ZenHttpClient {
  readonly requests: ZenHttpRequest[] = [];

  constructor(private readonly respond: (request: ZenHttpRequest) => ZenHttpResponse) {}

  async send(request: ZenHttpRequest): Promise<ZenHttpResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

describe('zen (opencode) provider', () => {
  it('reports credentials from the anonymous flag and the key pools', () => {
    const anonymous = new ZenProvider({
      credentials: { apiKey: '', extra: { anonymous: true } },
    });
    assert.equal(anonymous.hasCredentials(), true);

    const goOnly = new ZenProvider({
      credentials: { apiKey: '', extra: { goKeys: ['go-key'] } },
    });
    assert.equal(goOnly.hasCredentials(), true);

    const zenOnly = new ZenProvider({ credentials: { apiKey: 'zen-key' } });
    assert.equal(zenOnly.hasCredentials(), true);

    const none = new ZenProvider({ credentials: { apiKey: '' } });
    assert.equal(none.hasCredentials(), false);
  });

  it('lists routes with the opencode provider id', async () => {
    const provider = new ZenProvider({
      credentials: { apiKey: 'zen-key' },
      fetchImpl: fixedFetch(),
    });
    const models = await provider.listModels();
    assert.ok(models.length >= 1);
    assert.equal(
      models.every((model) => model.provider === 'opencode'),
      true,
    );
    assert.equal(models.find((model) => model.id === 'opencode:free-model')?.free, true);
    assert.equal(models.find((model) => model.id === 'opencode:paid-model')?.free, false);
  });

  it('returns a ChatResponse from chat()', async () => {
    const client = new FakeClient(() => inboundJson(200, CHAT_BODY));
    const provider = new ZenProvider({
      credentials: { apiKey: '', extra: { anonymous: true, httpClient: client } },
      fetchImpl: fixedFetch(),
    });
    const response = await provider.chat({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      rawProtocol: 'openai',
    });
    assert.equal(response.model, 'free-model');
    assert.equal(response.content, 'hello');
    assert.equal(response.usage?.total_tokens, 3);
    assert.equal(response.rawProtocol, 'openai');
    assert.deepEqual(response.raw, CHAT_BODY);
    assert.ok(client.requests.length >= 1);
  });
});
