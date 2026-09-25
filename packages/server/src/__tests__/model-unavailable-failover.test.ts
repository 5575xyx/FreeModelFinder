import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  resetAutoPoolCursor,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type ProviderId,
  type StreamChunk,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  resetAutoPoolCursor();
});

const UNAVAILABLE_400 =
  'custom stream failed 400: {"error":{"message":"Model id : deepseek-v3.1-dead , has no provider supported","request_id":"req-unavailable"}}';

async function appWithPool(opts: {
  models: string[];
  failures?: Record<string, string>;
  failAfterChunk?: string[];
}): Promise<{ app: FastifyInstance; seenModels: () => string[] }> {
  const { models, failures = {}, failAfterChunk = [] } = opts;
  const pool: ModelInfo[] = models.map((id) => ({
    id,
    provider: 'custom' as const,
    displayName: id,
    free: true,
  }));
  const config: AppConfig = {
    version: 2,
    port: 11435,
    providers: {
      custom: {
        enabled: true,
        credentials: {
          apiKey: '',
          extra: {
            sources: [
              {
                id: 'fixture',
                label: 'Fixture',
                baseUrl: 'https://fixture.invalid/v1',
                apiKey: 'source-key',
                models: [{ id: 'alive-mini' }],
              },
            ],
          },
        },
      },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: true, strategy: 'capability' },
  };
  const registry = new ProviderRegistry(config);
  const seen: string[] = [];
  const provider = {
    id: 'custom',
    async chat(request: ChatRequest): Promise<ChatResponse> {
      seen.push(request.model);
      const failure = failures[request.model];
      if (failure) throw new Error(failure);
      return {
        id: 'ok',
        model: request.model,
        created: 1,
        content: 'healthy reply',
        finish_reason: 'stop',
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      };
    },
    async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      seen.push(request.model);
      if (failAfterChunk.includes(request.model)) {
        yield {
          id: 's',
          model: request.model,
          created: 1,
          delta: 'partial reply',
          finish_reason: 'stop' as const,
        };
      }
      const failure = failures[request.model];
      if (failure) throw new Error(failure);
      yield {
        id: 's',
        model: request.model,
        created: 1,
        delta: 'healthy reply',
        finish_reason: 'stop' as const,
      };
    },
  };
  const internals = registry as unknown as {
    instances: Map<ProviderId, unknown>;
    modelsCache: unknown;
    cacheAt: number;
  };
  internals.instances.set('custom', provider);
  internals.modelsCache = {
    models: pool,
    succeededProviders: ['custom'],
    failedProviders: [],
  };
  internals.cacheAt = Date.now();
  registry.listAllModels = async () => ({
    models: pool,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });

  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return { app, seenModels: () => seen };
}

describe('model-unavailable auto failover', () => {
  it('stream fails over from an unavailable model to a healthy one', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /healthy reply/);
    assert.doesNotMatch(res.body, /no provider supported/);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'alive-mini']);
    assert.match(res.body, /fmf_route_notice/, 'failover must emit a switch notice');
    assert.match(res.body, /"cause":"unavailable"/);
  });

  it('non-stream fails over from an unavailable model to a healthy one', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: false },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]!.message.content, 'healthy reply');
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'alive-mini']);
  });

  it('permanently removes the unavailable model so the next request skips it', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'first' }], stream: false },
    });
    assert.equal(first.statusCode, 200);
    const afterFirst = seenModels().length;
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'second' }], stream: false },
    });
    assert.equal(second.statusCode, 200);
    const calls = seenModels();
    assert.equal(
      calls.filter((m) => m === 'deepseek-v3.1-dead').length,
      1,
      'dead model must be attempted only once across requests',
    );
    assert.ok(calls.length > afterFirst, 'second request still reaches a healthy model');
  });

  it('exhausts every candidate then answers 503 with a failure summary', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'deepseek-v3.2-dead'],
      failures: {
        'deepseek-v3.1-dead': UNAVAILABLE_400,
        'deepseek-v3.2-dead': UNAVAILABLE_400,
      },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: false },
    });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { error: { message: string; type: string } };
    assert.match(
      body.error.message,
      /tried 2 models: 2 unavailable, 0 rate-limited, 0 upstream errors/,
    );
    assert.equal(body.error.type, 'model_unavailable');
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'deepseek-v3.2-dead']);
  });

  it('propagates the error on stream when every candidate is unavailable', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'deepseek-v3.2-dead'],
      failures: {
        'deepseek-v3.1-dead': UNAVAILABLE_400,
        'deepseek-v3.2-dead': UNAVAILABLE_400,
      },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /tried 2 models: 2 unavailable, 0 rate-limited, 0 upstream errors/);
    assert.doesNotMatch(res.body, /healthy reply/);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'deepseek-v3.2-dead']);
  });
});

const RATE_LIMIT_429 = 'custom stream failed 429: rate limit exceeded, retry later';
const UPSTREAM_500 = 'custom stream failed 500: internal server error';
const PARAM_400 =
  'custom stream failed 400: {"error":{"message":"temperature must be between 0 and 2","type":"invalid_request_error"}}';

describe('full-pool failover semantics', () => {
  it('walks past the whole Top-3 down to a lower-ranked healthy model', async () => {
    const dead = [
      'deepseek-v3.0-dead',
      'deepseek-v3.1-dead',
      'deepseek-v3.2-dead',
      'deepseek-v3.3-dead',
    ];
    const failures = Object.fromEntries(dead.map((id) => [id, UNAVAILABLE_400]));
    const { app, seenModels } = await appWithPool({
      models: [...dead, 'alive-mini'],
      failures,
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seenModels(), [...dead, 'alive-mini']);
  });

  it('marks but does not switch for an explicitly requested model', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const explicit = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'custom:deepseek-v3.1-dead',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    });
    assert.equal(explicit.statusCode, 400);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead'], 'explicit failures must not fail over');
    const auto = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(auto.statusCode, 200);
    assert.deepEqual(
      seenModels(),
      ['deepseek-v3.1-dead', 'alive-mini'],
      'the explicitly failed model is now removed from auto scoring',
    );
  });

  it('cools rate-limited models down and keeps walking to the next candidate', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.0-dead', 'deepseek-v3.1-dead', 'alive-mini'],
      failures: {
        'deepseek-v3.0-dead': RATE_LIMIT_429,
        'deepseek-v3.1-dead': RATE_LIMIT_429,
      },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seenModels(), ['deepseek-v3.0-dead', 'deepseek-v3.1-dead', 'alive-mini']);
    const body = res.json() as { fmf_route_notices?: unknown[] };
    assert.equal(body.fmf_route_notices?.length, 2, 'each switch emits a notice');
    const notices =
      (body as { fmf_route_notices?: Array<{ cause?: string }> }).fmf_route_notices ?? [];
    assert.equal(notices[0]?.cause, 'rate-limit');
  });

  it('switches on upstream 5xx without permanently removing the model', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UPSTREAM_500 },
    });
    resetAutoPoolCursor();
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'auto', messages: [{ role: 'user', content: `hi-${i}` }], stream: false },
      });
      assert.equal(res.statusCode, 200);
    }
    const deadCalls = seenModels().filter((m) => m === 'deepseek-v3.1-dead').length;
    assert.ok(deadCalls >= 2, `5xx models stay eligible (seen ${deadCalls} times)`);
  });

  it('fails fast on request-shape 4xx without switching', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': PARAM_400 },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead'], 'param errors must not walk the pool');
  });

  it('cools the rate-limited model under its own id so the next request skips it', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.0-dead', 'alive-mini'],
      failures: { 'deepseek-v3.0-dead': RATE_LIMIT_429 },
    });
    resetAutoPoolCursor();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'first' }], stream: false },
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(seenModels(), ['deepseek-v3.0-dead', 'alive-mini']);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'second' }], stream: false },
    });
    assert.equal(second.statusCode, 200);
    const calls = seenModels();
    assert.equal(
      calls.filter((m) => m === 'deepseek-v3.0-dead').length,
      1,
      'rate-limited model must be cooled under its own id and skipped next request',
    );
  });
});
