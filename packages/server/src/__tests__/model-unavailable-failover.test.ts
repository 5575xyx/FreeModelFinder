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

function makePool(deadIds: string[], includeAlive = true): ModelInfo[] {
  return [
    ...deadIds.map((id): ModelInfo => ({
      id,
      provider: 'custom',
      displayName: id,
      free: true,
    })),
    ...(includeAlive
      ? [{ id: 'alive-mini', provider: 'custom' as const, displayName: 'Alive Mini', free: true }]
      : []),
  ];
}

async function appWithUnavailableModels(
  deadIds: string[],
  includeAlive = true,
): Promise<{
  app: FastifyInstance;
  seenModels: () => string[];
}> {
  const pool = makePool(deadIds, includeAlive);
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
      if (deadIds.includes(request.model)) throw new Error(UNAVAILABLE_400);
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
      if (deadIds.includes(request.model)) throw new Error(UNAVAILABLE_400);
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
    const { app, seenModels } = await appWithUnavailableModels(['deepseek-v3.1-dead']);
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: '你好' }],
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /healthy reply/);
    assert.doesNotMatch(res.body, /no provider supported/);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'alive-mini']);
    assert.match(res.body, /fmf_route_notice/, 'failover must emit a switch notice');
  });

  it('non-stream fails over from an unavailable model to a healthy one', async () => {
    const { app, seenModels } = await appWithUnavailableModels(['deepseek-v3.1-dead']);
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      choices: Array<{ message: { content: string } }>;
      fmf_auto_route?: { picked: string };
    };
    assert.equal(body.choices[0]!.message.content, 'healthy reply');
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'alive-mini']);
  });

  it('cools the unavailable model down so the next request skips it', async () => {
    const { app, seenModels } = await appWithUnavailableModels(['deepseek-v3.1-dead']);
    resetAutoPoolCursor();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'first' }],
        stream: false,
      },
    });
    assert.equal(first.statusCode, 200);
    const afterFirst = seenModels().length;
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'second' }],
        stream: false,
      },
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

  it('propagates the error when every candidate is unavailable (no infinite loop)', async () => {
    const { app, seenModels } = await appWithUnavailableModels(
      ['deepseek-v3.1-dead', 'deepseek-v3.2-dead'],
      false,
    );
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: { message: string } };
    assert.match(body.error.message, /no provider supported/);
    assert.ok(seenModels().length <= 4, `bounded retries, saw ${seenModels().length}`);
  });

  it('propagates the error on stream when every candidate is unavailable', async () => {
    const { app, seenModels } = await appWithUnavailableModels(
      ['deepseek-v3.1-dead', 'deepseek-v3.2-dead'],
      false,
    );
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: '你好' }],
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /no provider supported/);
    assert.doesNotMatch(res.body, /healthy reply/);
    assert.ok(seenModels().length <= 4, `bounded retries, saw ${seenModels().length}`);
  });
});
