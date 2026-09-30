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
import { resetModalityCursors } from '../routes/openai.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  resetAutoPoolCursor();
  resetModalityCursors();
});

const CONTEXT_OVERFLOW_400 =
  'custom stream failed 400: {"error":{"message":"input exceeds the context limit; set truncation to auto to permit history truncation","type":"invalid_request_error","param":"","code":"context_length_exceeded"}}';

async function appWithPool(opts: {
  models: string[];
  failures?: Record<string, string>;
  autoRoute?: AppConfig['autoRoute'];
}): Promise<{ app: FastifyInstance; seenModels: () => string[] }> {
  const { models, failures = {}, autoRoute = { enabled: true, strategy: 'capability' } } = opts;
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
    autoRoute,
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

describe('context overflow auto failover', () => {
  it('stream fails over from a context-exceeded model to a healthy one', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['gpt-5.5-overflow', 'alive-mini'],
      failures: { 'gpt-5.5-overflow': CONTEXT_OVERFLOW_400 },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /healthy reply/);
    assert.doesNotMatch(res.body, /context_length_exceeded/);
    assert.deepEqual(seenModels(), ['gpt-5.5-overflow', 'alive-mini']);
    assert.match(res.body, /fmf_route_notice/, 'failover must emit a switch notice');
    assert.match(res.body, /"cause":"context"/);
  });

  it('non-stream fails over from a context-exceeded model to a healthy one', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['gpt-5.5-overflow', 'alive-mini'],
      failures: { 'gpt-5.5-overflow': CONTEXT_OVERFLOW_400 },
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
    assert.deepEqual(seenModels(), ['gpt-5.5-overflow', 'alive-mini']);
  });

  it('cools the overflowed model down so the next auto request skips it', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['gpt-5.5-overflow', 'alive-mini'],
      failures: { 'gpt-5.5-overflow': CONTEXT_OVERFLOW_400 },
    });
    resetAutoPoolCursor();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'first' }], stream: false },
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(seenModels(), ['gpt-5.5-overflow', 'alive-mini']);

    // Force the pool cursor back to the same slot: without a cooldown the
    // overflowed model would be picked again from that exact position.
    resetAutoPoolCursor();
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'second' }], stream: false },
    });
    assert.equal(second.statusCode, 200);
    const calls = seenModels();
    assert.equal(
      calls.filter((m) => m === 'gpt-5.5-overflow').length,
      1,
      'overflowed model must be cooled down, not re-picked by the next auto request',
    );
    assert.equal(calls.at(-1), 'alive-mini');
  });
});
