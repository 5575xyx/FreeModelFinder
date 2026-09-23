import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ProviderRegistry, updateConfig, type AppConfig } from '@freemodelfinder/core';
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
      zhipu: {
        enabled: true,
        credentials: {
          apiKey: 'sk-legacy-zzzz',
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
              {
                id: 'string-src',
                label: 'String Src',
                baseUrl: 'https://string.invalid/v1',
                apiKey: 'src-string-9999',
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
    await updateConfig(() => testConfig());
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

  it('returns keyMeta for legacy single-key provider and string source apiKey', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.providers.zhipu.keyMeta.length, 1);
    assert.equal(body.providers.zhipu.keyMeta[0].hint, '…zzzz');
    const strMeta = body.custom.sources[1].keyMeta;
    assert.equal(strMeta.length, 1);
    assert.equal(strMeta[0].hint, '…9999');
    assert.ok(!res.body.includes('sk-legacy-zzzz'));
    assert.ok(!res.body.includes('src-string-9999'));
  });

  it('handles short keys, filters whitespace, and removes the last key', async () => {
    const short = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'zhipu', apiKeys: ['abcd', 'abc', 'ab', 'a'] },
    });
    assert.equal(short.statusCode, 200);

    let cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.deepEqual(
      cfg.json().providers.zhipu.keyMeta.map((m: { hint: string }) => m.hint),
      ['…abcd', '…bc', '…ab', '…a'],
    );

    const wsReplace = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'zhipu', apiKeys: ['   ', ' sk-ws-abcd '] },
    });
    assert.equal(wsReplace.statusCode, 200);

    cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().providers.zhipu.keyMeta.length, 1);
    assert.equal(cfg.json().providers.zhipu.keyMeta[0].hint, '…abcd');
    assert.ok(!cfg.body.includes('sk-ws-abcd'));

    const wsAppend = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'zhipu', appendKeys: ['   '] },
    });
    assert.equal(wsAppend.statusCode, 400);

    const removeLast = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'zhipu', removeKeyIndex: 0 },
    });
    assert.equal(removeLast.statusCode, 200);

    cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().providers.zhipu.keyMeta.length, 0);
  });

  it('appends and removes provider keys', async () => {
    const append = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', appendKeys: ['sk-third-cccc'], enabled: true },
    });
    assert.equal(append.statusCode, 200);

    let cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().providers.openrouter.keyMeta.length, 3);
    assert.equal(cfg.json().providers.openrouter.keyMeta[2].hint, '…cccc');

    const empty = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', appendKeys: [] },
    });
    assert.equal(empty.statusCode, 400);

    const remove = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', removeKeyIndex: 0 },
    });
    assert.equal(remove.statusCode, 200);

    cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().providers.openrouter.keyMeta.length, 2);
    assert.equal(cfg.json().providers.openrouter.keyMeta[0].hint, '…bbbb');

    const oob = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', removeKeyIndex: 99 },
    });
    assert.equal(oob.statusCode, 400);
  });

  it('appends and removes custom source keys', async () => {
    const append = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: {
        provider: 'custom',
        appendSourceKeys: { sourceId: 'fixture', keys: ['src-three-3333'] },
      },
    });
    assert.equal(append.statusCode, 200);

    let cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().custom.sources[0].keyMeta.length, 3);

    const remove = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'custom', removeSourceKey: { sourceId: 'fixture', index: 0 } },
    });
    assert.equal(remove.statusCode, 200);

    cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().custom.sources[0].keyMeta.length, 2);
    assert.ok(!cfg.body.includes('src-one-1111'));
  });

  it('validates append/remove key operations', async () => {
    const neg = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', removeKeyIndex: -1 },
    });
    assert.equal(neg.statusCode, 400);

    const frac = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', removeKeyIndex: 1.5 },
    });
    assert.equal(frac.statusCode, 400);

    const wrongProvider = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: {
        provider: 'openrouter',
        appendSourceKeys: { sourceId: 'fixture', keys: ['k-1234'] },
      },
    });
    assert.equal(wrongProvider.statusCode, 400);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'custom', appendSourceKeys: { sourceId: 'nope', keys: ['k-1234'] } },
    });
    assert.equal(unknown.statusCode, 404);

    const wsSourceAppend = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'custom', appendSourceKeys: { sourceId: 'fixture', keys: ['  '] } },
    });
    assert.equal(wsSourceAppend.statusCode, 400);

    const oob = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'custom', removeSourceKey: { sourceId: 'fixture', index: 99 } },
    });
    assert.equal(oob.statusCode, 400);

    const badRemove = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'custom', removeSourceKey: { sourceId: 'fixture', index: -1 } },
    });
    assert.equal(badRemove.statusCode, 400);
  });

  it('rejects provider-level key ops for custom provider', async () => {
    const append = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'custom', appendKeys: ['sk-x'] },
    });
    assert.equal(append.statusCode, 400);

    const remove = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'custom', removeKeyIndex: 0 },
    });
    assert.equal(remove.statusCode, 400);
  });

  it('lets clearCredentials win over append and remove', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: {
        provider: 'openrouter',
        clearCredentials: true,
        appendKeys: ['sk-cleared-9999'],
        removeKeyIndex: 0,
      },
    });
    assert.equal(res.statusCode, 200);

    const cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().providers.openrouter.keyMeta.length, 0);
  });
});
