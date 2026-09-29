import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { normalizeZenConfig, type ZenConfig } from '../config/index.js';
import { ZenAttemptMonitor } from '../gateway/monitor.js';
import { createZenGateway, type ZenGateway } from '../gateway/runtime.js';
import type { ZenHttpClient, ZenHttpRequest, ZenHttpResponse } from '../http.js';
import type { ProxySpec } from '../proxy/spec.js';
import type { ZenStreamChunk } from '../protocol/types.js';

const PROXIES: ProxySpec[] = [{ kind: 'direct', label: 'direct' }];

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

const SSE = [
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    model: 'free-model',
    created: 123,
    choices: [{ index: 0, delta: { content: 'he' }, finish_reason: null }],
  })}\n\n`,
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    model: 'free-model',
    created: 123,
    choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: 'stop' }],
  })}\n\n`,
  'data: [DONE]\n\n',
].join('');

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

function inbound(status: number, body: string, headers: IncomingHttpHeaders): ZenHttpResponse {
  return {
    status,
    headers,
    body: Readable.from([Buffer.from(body)]) as unknown as IncomingMessage,
  };
}

function inboundJson(status: number, body: unknown): ZenHttpResponse {
  return inbound(status, JSON.stringify(body), { 'content-type': 'application/json' });
}

function inboundSse(body: string): ZenHttpResponse {
  return inbound(200, body, { 'content-type': 'text/event-stream' });
}

class FakeClient implements ZenHttpClient {
  readonly requests: ZenHttpRequest[] = [];

  constructor(private readonly respond: (request: ZenHttpRequest) => ZenHttpResponse) {}

  async send(request: ZenHttpRequest): Promise<ZenHttpResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

function makeGateway(client: ZenHttpClient): ZenGateway {
  const config: ZenConfig = normalizeZenConfig({ anonymous: true });
  return createZenGateway({
    config,
    proxies: PROXIES,
    httpClient: client,
    fetchImpl: fixedFetch(),
    logger: {},
  });
}

describe('zen gateway runtime', () => {
  it('exposes the lifecycle API, monitor and merged snapshot', async () => {
    const gateway = makeGateway(new FakeClient(() => inboundJson(200, CHAT_BODY)));
    for (const name of [
      'listRoutes',
      'snapshot',
      'chat',
      'stream',
      'start',
      'stop',
      'refresh',
      'monitor',
    ] as const) {
      assert.equal(typeof gateway[name], 'function');
    }
    assert.ok(gateway.monitor() instanceof ZenAttemptMonitor);

    await gateway.refresh();
    const snapshot = gateway.snapshot();
    assert.ok(snapshot.models.total >= 1);
    assert.equal(snapshot.keys.anonymous, true);
    assert.equal(snapshot.pricing.ready, true);
    assert.ok(snapshot.proxies.total >= 1);
    gateway.stop();
  });

  it('lists anonymous-eligible models when only the anonymous lane is configured', async () => {
    const gateway = makeGateway(new FakeClient(() => inboundJson(200, CHAT_BODY)));
    await gateway.refresh();

    const routes = gateway.listRoutes(true, true, true);
    const free = routes.find((route) => route.id === 'free-model');
    assert.ok(free, 'the free model should be routable');
    assert.equal(free.anonymous, true);
    assert.equal(free.protocol, 'chat');

    const paid = routes.find((route) => route.id === 'paid-model');
    assert.ok(paid);
    assert.equal(paid.anonymous, false);
  });

  it('exposes catalog free-model eligibility through isFreeModel', async () => {
    const gateway = makeGateway(new FakeClient(() => inboundJson(200, CHAT_BODY)));
    await gateway.refresh();

    assert.equal(gateway.isFreeModel('free-model'), true);
    assert.equal(gateway.isFreeModel('paid-model'), false);
  });

  it('serves chat through the anonymous channel and backfills raw', async () => {
    const client = new FakeClient(() => inboundJson(200, CHAT_BODY));
    const gateway = makeGateway(client);
    await gateway.refresh();

    const response = await gateway.chat({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      rawProtocol: 'openai',
    });

    assert.equal(response.model, 'free-model');
    assert.equal(response.content, 'hello');
    assert.equal(response.rawProtocol, 'openai');
    assert.deepEqual(response.raw, CHAT_BODY);
    assert.ok(client.requests.length >= 1);
    const sent = JSON.parse(client.requests[0]!.body!) as Record<string, unknown>;
    assert.equal(sent['stream'], true);
  });

  it('collapses an anonymous SSE body for a non-streaming chat request', async () => {
    const client = new FakeClient(() => inboundSse(SSE));
    const gateway = makeGateway(client);
    await gateway.refresh();

    const response = await gateway.chat({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      rawProtocol: 'openai',
    });

    assert.equal(response.model, 'free-model');
    assert.equal(response.content, 'hello');
    assert.equal(response.finish_reason, 'stop');
    assert.equal(response.rawProtocol, 'openai');
    assert.ok(response.raw !== undefined);
  });

  it('streams parsed chunks with the raw SSE frame attached', async () => {
    const gateway = makeGateway(new FakeClient(() => inboundSse(SSE)));
    await gateway.refresh();

    const chunks: ZenStreamChunk[] = [];
    for await (const chunk of gateway.stream({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      rawProtocol: 'openai',
    })) {
      chunks.push(chunk);
    }

    assert.ok(chunks.length >= 2);
    assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'hello');
    assert.equal(chunks[0]!.rawProtocol, 'openai');
    assert.ok(chunks[0]!.raw !== undefined);
  });
});
