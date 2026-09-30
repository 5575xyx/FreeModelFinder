import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
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

beforeEach(() => {
  resetAutoPoolCursor();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  resetAutoPoolCursor();
  resetModalityCursors();
});

type PoolModel = { id: string; contextWindow?: number; provider?: ProviderId };

async function appWithPool(opts: {
  models: PoolModel[];
  failures?: Record<string, string>;
  autoRoute?: AppConfig['autoRoute'];
}): Promise<{ app: FastifyInstance; seenModels: () => string[] }> {
  const { models, failures = {}, autoRoute = { enabled: true, strategy: 'capability' } } = opts;
  const pool: ModelInfo[] = models.map((m) => ({
    id: m.id,
    provider: m.provider ?? ('custom' as const),
    displayName: m.id,
    free: true,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
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

describe('auto sticky routing and preflight', () => {
  it('returns the same model for the same opening user message', async () => {
    const { app, seenModels } = await appWithPool({
      models: [
        { id: 'big-70b', contextWindow: 200_000 },
        { id: 'tiny-3b', contextWindow: 32_000 },
      ],
    });
    const body = { model: 'auto', messages: [{ role: 'user', content: 'hello sticky world' }] };
    const first = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const calls = seenModels();
    assert.equal(calls[0], calls[1]);
    const parsed = second.json() as { fmf_auto_route?: { sticky?: boolean } };
    assert.equal(parsed.fmf_auto_route?.sticky, true);
  });

  it('reports a pool and sticky flag on auto picks', async () => {
    const { app } = await appWithPool({ models: [{ id: 'big-70b', contextWindow: 200_000 }] });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    const parsed = res.json() as {
      fmf_auto_route?: { picked?: string; pool?: string[]; sticky?: boolean };
    };
    assert.ok(parsed.fmf_auto_route?.pool?.length);
    assert.equal(typeof parsed.fmf_auto_route?.sticky, 'boolean');
  });

  it('skips a model whose window cannot hold the prompt', async () => {
    const { app, seenModels } = await appWithPool({
      models: [
        { id: 'gpt-5-flagship', contextWindow: 8192 },
        { id: 'huge-1m', contextWindow: 1_000_000 },
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(40_000) }] },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(!seenModels().includes('gpt-5-flagship'));
    assert.equal(seenModels().at(-1), 'huge-1m');
  });

  it('still fails over on context_length_exceeded when the precheck cannot see it', async () => {
    const { app, seenModels } = await appWithPool({
      models: [{ id: 'gpt-5-blind' }, { id: 'healthy', contextWindow: 200_000 }],
      failures: {
        'gpt-5-blind':
          'custom stream failed 400: {"error":{"message":"input exceeds the context limit; set truncation to auto to permit history truncation","type":"invalid_request_error","param":"","code":"context_length_exceeded"}}',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seenModels(), ['gpt-5-blind', 'healthy']);
  });
});
