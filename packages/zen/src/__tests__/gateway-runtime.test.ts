import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function failingFetch(): typeof fetch {
  const impl = async (): Promise<Response> => {
    throw new Error('offline');
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

class HangingClient implements ZenHttpClient {
  send(request: ZenHttpRequest): Promise<ZenHttpResponse> {
    return new Promise<ZenHttpResponse>((_resolve, reject) => {
      const signal = request.signal;
      if (!signal) return;
      const keepAlive = setTimeout(() => undefined, 5_000);
      const abort = (): void => {
        clearTimeout(keepAlive);
        const error = new Error('upstream request aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    });
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
      'loadCache',
      'monitor',
    ] as const) {
      assert.equal(typeof gateway[name], 'function');
    }
    assert.ok(gateway.monitor() instanceof ZenAttemptMonitor);

    const loaded = await gateway.loadCache();
    assert.deepEqual(loaded, { catalog: false, pricing: false });

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
    assert.equal(client.requests[0]!.connectTimeoutMs, 15000);
  });

  it('applies the configured per-attempt timeout to upstream requests', async () => {
    const base = normalizeZenConfig({ anonymous: true });
    const config: ZenConfig = {
      ...base,
      performance: { ...base.performance, attemptTimeoutSeconds: 2 },
    };
    const client = new FakeClient(() => inboundJson(200, CHAT_BODY));
    const gateway = createZenGateway({
      config,
      proxies: PROXIES,
      httpClient: client,
      fetchImpl: fixedFetch(),
      logger: {},
    });
    await gateway.refresh();

    await gateway.chat({ model: 'free-model', messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(client.requests[0]!.attemptTimeoutMs, 2000);
    assert.equal(client.requests[0]!.connectTimeoutMs, 15000);
    gateway.stop();
  });

  it('collapses an anonymous SSE body without exposing the raw event array', async () => {
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
    assert.equal(response.raw, undefined);
    assert.equal(response.rawProtocol, undefined);
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

  it('loads the disk catalog cache during start before the first refresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-cache-'));
    const catalogPath = join(dir, 'catalog.json');
    const cache = {
      schema_version: 3,
      updated_at: '2026-09-01T00:00:00.000Z',
      zen: ['cached-model'],
      go: [],
      native_protocols: {},
      unsupported: {},
      metadata: {},
    };
    await writeFile(catalogPath, JSON.stringify(cache), 'utf8');
    const config: ZenConfig = normalizeZenConfig({ anonymous: true });
    const gateway = createZenGateway({
      config,
      proxies: PROXIES,
      httpClient: new FakeClient(() => inboundJson(200, CHAT_BODY)),
      fetchImpl: failingFetch(),
      cachePaths: { catalog: catalogPath },
      logger: {},
    });
    try {
      await gateway.start();
      const snapshot = gateway.snapshot();
      assert.equal(snapshot.models.cacheSource, 'disk');
      assert.equal(snapshot.models.stale, true);
      assert.ok(snapshot.models.total >= 1);
    } finally {
      gateway.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects chat when the caller signal is already aborted', async () => {
    const gateway = makeGateway(new FakeClient(() => inboundJson(200, CHAT_BODY)));
    await gateway.refresh();

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      gateway.chat({
        model: 'free-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
      /abort/i,
    );
  });

  it('rejects chat when the total request timeout elapses', async () => {
    const base = normalizeZenConfig({ anonymous: true });
    const config: ZenConfig = { ...base, retry: { ...base.retry, timeoutSeconds: 0.05 } };
    const gateway = createZenGateway({
      config,
      proxies: PROXIES,
      httpClient: new HangingClient(),
      fetchImpl: fixedFetch(),
      logger: {},
    });
    await gateway.refresh();

    await assert.rejects(
      gateway.chat({
        model: 'free-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      /abort/i,
    );
    gateway.stop();
  });

  it('restores a proxy marked unhealthy by a transport failure through verifyProxy', async () => {
    const client = new FakeClient((request) => {
      if (request.method === 'GET') return inboundJson(200, { ok: true });
      const error = new Error('connection refused');
      (error as Error & { code?: string }).code = 'ECONNREFUSED';
      throw error;
    });
    const gateway = makeGateway(client);
    await gateway.refresh();
    assert.equal(gateway.snapshot().proxies.healthy, 1);

    await assert.rejects(
      gateway.chat({ model: 'free-model', messages: [{ role: 'user', content: 'hi' }] }),
    );
    await waitFor(() => gateway.snapshot().proxies.healthy === 1);
    gateway.stop();
  });

  it('unrefs the background timers so a started gateway cannot hold the loop open', async () => {
    const handles: Array<{ hasRef(): boolean }> = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((...args: Parameters<typeof realSetInterval>) => {
      const handle = realSetInterval(...args);
      handles.push(handle as unknown as { hasRef(): boolean });
      return handle;
    }) as typeof realSetInterval;

    const dir = await mkdtemp(join(tmpdir(), 'zen-unref-'));
    const gateway = createZenGateway({
      config: normalizeZenConfig({ anonymous: true }),
      proxies: PROXIES,
      httpClient: new FakeClient(() => inboundJson(200, CHAT_BODY)),
      fetchImpl: failingFetch(),
      cachePaths: { catalog: join(dir, 'catalog.json'), pricing: join(dir, 'pricing.json') },
      logger: {},
    });
    try {
      await gateway.start();
      assert.ok(handles.length >= 2, 'start() must schedule the refresher and health timers');
      for (const handle of handles) {
        assert.equal(handle.hasRef(), false, 'background timers must not keep the process alive');
      }
    } finally {
      gateway.stop();
      globalThis.setInterval = realSetInterval;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lets a concurrent refresh join the in-flight one instead of returning a stale result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-single-flight-'));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const slowFetch = (async (input: RequestInfo | URL) => {
      fetches += 1;
      if (fetches === 1) await gate;
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('models.opencode.ai')) return webJson(CAPABILITIES);
      if (url.includes('models.dev')) return webJson(MODELS_DEV);
      if (url.endsWith('/go/v1/models')) return webJson(GO_MODELS);
      if (url.endsWith('/v1/models')) return webJson(ZEN_MODELS);
      if (url.includes('.mdx')) return new Response('', { status: 404 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const gateway = createZenGateway({
      config: normalizeZenConfig({ anonymous: true }),
      proxies: PROXIES,
      httpClient: new FakeClient(() => inboundJson(200, CHAT_BODY)),
      fetchImpl: slowFetch,
      cachePaths: { catalog: join(dir, 'catalog.json'), pricing: join(dir, 'pricing.json') },
      logger: {},
    });

    try {
      const first = gateway.refresh();
      const second = gateway.refresh();
      release();
      const [a, b] = await Promise.all([first, second]);

      assert.equal(a, b, 'a concurrent refresh must share the in-flight result');
      assert.ok(a.total >= 1, 'the joined refresh must report the refreshed catalog');
      assert.equal(gateway.snapshot().models.total >= 1, true);
    } finally {
      gateway.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
