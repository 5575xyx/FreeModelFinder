import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const localUiHeaders = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

function testConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {
      opencode: { enabled: true, credentials: { apiKey: '', extra: { anonymous: true } } },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

describe('opencode hasKey seam', () => {
  let app: FastifyInstance;
  let registry: ProviderRegistry;

  before(async () => {
    registry = new ProviderRegistry(testConfig());
    ({ app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 }));
  });

  after(async () => {
    await app.close();
  });

  async function hasKey(): Promise<boolean> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    return response.json().providers.opencode.hasKey as boolean;
  }

  it('reports opencode as keyed when anonymous is enabled without a key', async () => {
    assert.equal(await hasKey(), true);
  });

  it('reports opencode as unkeyed without anonymous and without a key', async () => {
    const current = registry.getConfig();
    registry.updateConfig({
      ...current,
      providers: {
        ...current.providers,
        opencode: { enabled: true, credentials: { apiKey: '' } },
      },
    });
    assert.equal(await hasKey(), false);
  });

  it('reports opencode as keyed from a singular apiKey', async () => {
    const current = registry.getConfig();
    registry.updateConfig({
      ...current,
      providers: {
        ...current.providers,
        opencode: { enabled: true, credentials: { apiKey: 'sk-live-123' } },
      },
    });
    assert.equal(await hasKey(), true);
  });

  it('reports opencode as keyed from goKeys', async () => {
    const current = registry.getConfig();
    registry.updateConfig({
      ...current,
      providers: {
        ...current.providers,
        opencode: { enabled: true, credentials: { apiKey: '', extra: { goKeys: ['go-key'] } } },
      },
    });
    assert.equal(await hasKey(), true);
  });
});
