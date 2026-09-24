import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ProviderRegistry, updateConfig, type AppConfig } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const localUiHeaders = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

function baseConfig(autoRoute?: AppConfig['autoRoute']): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {},
    gateway: { requireAuth: false },
    autoRoute,
  };
}

function fakeRegistry(autoRoute?: AppConfig['autoRoute']): ProviderRegistry {
  const registry = new ProviderRegistry(baseConfig(autoRoute));
  registry.listAllModels = async () => ({
    models: [],
    succeededProviders: [],
    failedProviders: [],
  });
  registry.resolveModel = () => {
    throw new Error('unused');
  };
  return registry;
}

describe('auto-route merge API', () => {
  let app: FastifyInstance;

  before(async () => {
    await updateConfig(() =>
      baseConfig({
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:seeded'],
      }),
    );
    ({ app } = await createServer({
      registry: fakeRegistry({
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:seeded'],
      }),
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app?.close();
  });

  it('GET returns arrays even when registry config has a legacy string imageModel', async () => {
    const legacy = await createServer({
      registry: fakeRegistry({
        enabled: false,
        strategy: 'capability',
        imageModel: 'legacy:string' as unknown as string[],
      }),
      watchIntervalMs: 60 * 60 * 1000,
    });
    try {
      const res = await legacy.app.inject({
        method: 'GET',
        url: '/api/auto-route',
        headers: localUiHeaders,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.imageModel, ['legacy:string']);
      assert.ok(Array.isArray(body.videoModel));
      assert.ok(Array.isArray(body.textTiers.simple));
      assert.ok(Array.isArray(body.textTiers.medium));
      assert.ok(Array.isArray(body.textTiers.complex));
    } finally {
      await legacy.app.close();
    }
  });

  it('POST that omits imageModel keeps the previous value', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/auto-route',
      headers: localUiHeaders,
      payload: { enabled: true },
    });
    assert.equal(post.statusCode, 200);
    const get = await app.inject({
      method: 'GET',
      url: '/api/auto-route',
      headers: localUiHeaders,
    });
    const body = get.json();
    assert.equal(body.enabled, true);
    assert.deepEqual(body.imageModel, ['custom:seeded']);
  });

  it('POST imageModel: [] clears the previous pool', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/auto-route',
      headers: localUiHeaders,
      payload: { imageModel: [] },
    });
    assert.equal(post.statusCode, 200);
    const get = await app.inject({
      method: 'GET',
      url: '/api/auto-route',
      headers: localUiHeaders,
    });
    assert.deepEqual(get.json().imageModel, []);
  });

  it('POST imageModel as a legacy string stores it as a one-item array', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/auto-route',
      headers: localUiHeaders,
      payload: { imageModel: 'legacy:string' },
    });
    assert.equal(post.statusCode, 200);
    const get = await app.inject({
      method: 'GET',
      url: '/api/auto-route',
      headers: localUiHeaders,
    });
    assert.deepEqual(get.json().imageModel, ['legacy:string']);
  });
});

describe('visionModel auto-route API', () => {
  let app: FastifyInstance;

  before(async () => {
    await updateConfig(() =>
      baseConfig({
        enabled: false,
        strategy: 'capability',
        visionModel: ['custom:v1'],
      }),
    );
    ({ app } = await createServer({
      registry: fakeRegistry({
        enabled: false,
        strategy: 'capability',
        visionModel: ['custom:v1'],
      }),
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app?.close();
  });

  it('GET returns visionModel array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auto-route',
      headers: localUiHeaders,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().visionModel, ['custom:v1']);
  });

  it('POST merge keeps previous visionModel when omitted; assigns when provided', async () => {
    const assign = await app.inject({
      method: 'POST',
      url: '/api/auto-route',
      headers: localUiHeaders,
      payload: { visionModel: ['custom:v2'] },
    });
    assert.equal(assign.statusCode, 200);
    const afterAssign = await app.inject({
      method: 'GET',
      url: '/api/auto-route',
      headers: localUiHeaders,
    });
    assert.deepEqual(afterAssign.json().visionModel, ['custom:v2']);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/auto-route',
      headers: localUiHeaders,
      payload: {},
    });
    assert.equal(empty.statusCode, 200);
    const afterEmpty = await app.inject({
      method: 'GET',
      url: '/api/auto-route',
      headers: localUiHeaders,
    });
    assert.deepEqual(afterEmpty.json().visionModel, ['custom:v2']);
  });
});
