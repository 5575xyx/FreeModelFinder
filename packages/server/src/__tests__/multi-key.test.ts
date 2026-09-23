import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ProviderRegistry, type AppConfig } from '@freemodelfinder/core';
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
      openrouter: {
        enabled: true,
        credentials: {
          apiKey: 'sk-first-aaaa',
          apiKeys: ['sk-first-aaaa', 'sk-second-bbbb'],
        },
      },
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
                apiKey: ['src-one-1111', 'src-two-2222'],
                models: [{ id: 'fixture-model' }],
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

function fakeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry(testConfig());
  registry.listAllModels = async () => ({
    models: [
      {
        id: 'fixture-model',
        provider: 'custom' as const,
        displayName: 'Fixture Model',
        free: true,
      },
    ],
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  registry.resolveModel = () => {
    throw new Error('unused');
  };
  return registry;
}

describe('multi-key management', () => {
  let app: FastifyInstance;
  let uiDir: string;

  before(async () => {
    uiDir = await mkdtemp(join(tmpdir(), 'freemodelfinder-ui-'));
    await mkdir(join(uiDir, '_next', 'static'), { recursive: true });
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>FreeModelFinder</title>');
    await writeFile(join(uiDir, '_next', 'static', 'app.js'), 'globalThis.__fmf = true;');
    ({ app } = await createServer({
      registry: fakeRegistry(),
      uiDir,
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app?.close();
    await rm(uiDir, { recursive: true, force: true });
  });

  it('returns keyMeta hints without plaintext', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const meta = body.providers.openrouter.keyMeta;
    assert.equal(meta.length, 2);
    assert.equal(meta[0].id, 'k0');
    assert.equal(meta[0].hint, '…aaaa');
    assert.equal(meta[1].hint, '…bbbb');
    assert.ok(!res.body.includes('sk-first-aaaa'));
    assert.ok(!res.body.includes('sk-second-bbbb'));
    const srcMeta = body.custom.sources[0].keyMeta;
    assert.equal(srcMeta.length, 2);
    assert.equal(srcMeta[0].hint, '…1111');
    assert.ok(!res.body.includes('src-one-1111'));
  });
});
