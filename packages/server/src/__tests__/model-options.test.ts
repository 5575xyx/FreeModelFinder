import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

function configWithCustomModels(): AppConfig {
  return {
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
                apiKey: 'k',
                models: [
                  { id: 'plain-chat', displayName: 'Plain' },
                  { id: 'sora-image', displayName: 'Img' },
                ],
              },
            ],
          },
        },
      },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

async function withApp(
  fn: (app: FastifyInstance, registry: ProviderRegistry) => Promise<void>,
): Promise<void> {
  const registry = new ProviderRegistry(configWithCustomModels());
  let listAllCalls = 0;
  const original = registry.listAllModels.bind(registry);
  registry.listAllModels = async (force?: boolean) => {
    listAllCalls += 1;
    if (force) listAllCalls += 1000;
    return original(force);
  };
  const { app } = await createServer({
    registry,
    watchIntervalMs: 60 * 60 * 1000,
  });
  // ModelWatcher.start() fires an immediate background tick that may call
  // listAllModels; let it settle and reset so we only count endpoint-triggered calls.
  await new Promise((r) => setTimeout(r, 50));
  listAllCalls = 0;
  try {
    await fn(app, registry);
    assert.equal(listAllCalls, 0, 'model-options must not call listAllModels');
  } finally {
    await app.close();
  }
}

const localUiHeaders = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

describe('GET /api/auto-route/model-options', () => {
  it('returns merged local catalog without calling providers', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
        headers: localUiHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        models: Array<{ id: string; provider: string; displayName?: string }>;
      };
      const ids = body.models.map((m) => m.id);
      assert.ok(ids.includes('custom:fixture:plain-chat'), ids.join(','));
      assert.ok(ids.includes('custom:fixture:sora-image'), ids.join(','));
      const plain = body.models.find((m) => m.id === 'custom:fixture:plain-chat');
      assert.equal(plain?.provider, 'custom');
    });
  });

  it('dedupes and omits empty ids', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
        headers: localUiHeaders,
      });
      const body = res.json() as { models: Array<{ id: string }> };
      const ids = body.models.map((m) => m.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.every((id) => id.length > 0));
    });
  });
});
