import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig, type ModelSnapshot } from '@freemodelfinder/core';
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
                  { id: 'llava-mini', displayName: 'LLaVA Mini' },
                  { id: '', displayName: 'Empty' },
                  { id: '   ', displayName: 'Whitespace' },
                ],
              },
              {
                id: 'dup',
                label: 'Dup',
                baseUrl: 'https://dup.invalid/v1',
                apiKey: 'k',
                models: [{ id: 'x', displayName: 'Dup A' }],
              },
              {
                id: 'mirror',
                label: 'Mirror',
                baseUrl: 'https://mirror.invalid/v1',
                apiKey: 'k',
                models: [{ id: 'custom:dup:x', displayName: 'Dup B' }],
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

function configWithForcedVision(): AppConfig {
  const cfg = configWithCustomModels();
  cfg.autoRoute = {
    enabled: false,
    strategy: 'capability',
    visionModel: ['custom:fixture:plain-chat'],
  };
  return cfg;
}

function configWithCatalogVision(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {},
    gateway: { requireAuth: false },
    autoRoute: {
      enabled: false,
      strategy: 'capability',
      visionModel: ['openrouter:gpt-4o-mini'],
    },
  };
}

function catalogVisionSnapshot(): Promise<ModelSnapshot> {
  return Promise.resolve({
    version: 1,
    updatedAt: 1,
    models: [{ id: 'gpt-4o-mini', provider: 'openrouter', displayName: 'GPT-4o Mini', free: true }],
    added: [],
    removed: [],
  });
}

async function withApp(
  fn: (app: FastifyInstance, registry: ProviderRegistry) => Promise<void>,
  makeConfig: () => AppConfig = configWithCustomModels,
  loadModelSnapshot?: () => Promise<ModelSnapshot>,
): Promise<void> {
  const registry = new ProviderRegistry(makeConfig(), loadModelSnapshot);
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

  it('omits empty and whitespace-only ids from config sources', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
        headers: localUiHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { models: Array<{ id: string }> };
      const ids = body.models.map((m) => m.id);
      assert.ok(!ids.includes(''), ids.join(','));
      assert.ok(!ids.includes('   '), ids.join(','));
      assert.ok(!ids.includes('custom:fixture:'), ids.join(','));
      assert.ok(ids.every((id) => id.trim().length > 0));
      assert.ok(ids.includes('custom:fixture:plain-chat'), ids.join(','));
    });
  });

  it('dedupes duplicate composed ids across config sources', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
        headers: localUiHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { models: Array<{ id: string }> };
      const ids = body.models.map((m) => m.id);
      assert.equal(new Set(ids).size, ids.length, ids.join(','));
      assert.equal(
        ids.filter((id) => id === 'custom:dup:x').length,
        1,
        `expected one custom:dup:x, got: ${ids.join(',')}`,
      );
      assert.ok(ids.includes('custom:fixture:plain-chat'), ids.join(','));
      assert.ok(ids.includes('custom:fixture:sora-image'), ids.join(','));
      assert.ok(ids.includes('custom:dup:x'), ids.join(','));
    });
  });
});

describe('GET /api/auto-route/model-options vision tags', () => {
  it('tags heuristic vision ids true and plain ids false', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
        headers: localUiHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { models: Array<{ id: string; vision?: boolean }> };
      const vision = body.models.find((m) => m.id === 'custom:fixture:llava-mini');
      const plain = body.models.find((m) => m.id === 'custom:fixture:plain-chat');
      assert.equal(vision?.vision, true, 'llava-mini should be vision-tagged');
      assert.equal(plain?.vision, false, 'plain-chat should not be vision-tagged');
    });
  });

  it('forced visionModel pool marks listed ids vision even without heuristic match', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
        headers: localUiHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { models: Array<{ id: string; vision?: boolean }> };
      const plain = body.models.find((m) => m.id === 'custom:fixture:plain-chat');
      assert.equal(plain?.vision, true, 'forced-pool member must be vision-tagged');
    }, configWithForcedVision);
  });

  it('local catalog loop tags vision using composed id against forced pool', async () => {
    await withApp(
      async (app) => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/auto-route/model-options',
          headers: localUiHeaders,
        });
        assert.equal(res.statusCode, 200);
        const body = res.json() as { models: Array<{ id: string; vision?: boolean }> };
        const entry = body.models.find((m) => m.id === 'openrouter:gpt-4o-mini');
        assert.ok(
          entry,
          `expected local catalog entry openrouter:gpt-4o-mini, got: ${body.models.map((m) => m.id).join(',')}`,
        );
        assert.equal(
          entry.vision,
          true,
          'local catalog entry must match forced vision pool by composed id',
        );
      },
      configWithCatalogVision,
      catalogVisionSnapshot,
    );
  });
});
