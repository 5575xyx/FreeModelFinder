import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ProviderRegistry,
  updateConfig,
  type AppConfig,
  type ProviderCredentials,
} from '@freemodelfinder/core';
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

function opencodeConfig(credentials: ProviderCredentials): AppConfig {
  return {
    ...testConfig(),
    providers: { opencode: { enabled: false, credentials } },
  };
}

// POST /api/providers rebuilds the registry from the persisted config, so a shared
// registry binding goes stale after the first POST. Seeding both the store and a
// fresh registry keeps the displayed rows and the persisted list in lockstep.
async function serverFor(cfg: AppConfig): Promise<FastifyInstance> {
  await updateConfig(() => cfg);
  const { app } = await createServer({
    registry: new ProviderRegistry(cfg),
    watchIntervalMs: 60 * 60 * 1000,
  });
  return app;
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

  it('exposes anonymous/prefer/goKeyCount and persists extra via POST', async () => {
    const current = registry.getConfig();
    registry.updateConfig({
      ...current,
      providers: {
        ...current.providers,
        opencode: { enabled: false, credentials: { apiKey: '' } },
      },
    });

    const post = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: {
        provider: 'opencode',
        enabled: true,
        extra: { anonymous: true, prefer: 'zen', goKeys: ['go-key'], proxies: ['http://h:1'] },
      },
    });
    assert.equal(post.statusCode, 200);

    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    const provider = response.json().providers.opencode;
    assert.equal(provider.enabled, true);
    assert.equal(provider.anonymous, true);
    assert.equal(provider.prefer, 'zen');
    assert.equal(provider.goKeyCount, 1);
    assert.equal(provider.proxyCount, 1);
    assert.equal(provider.hasKey, true);
  });

  it('ignores non-opencode keys in the extra payload', async () => {
    const current = registry.getConfig();
    registry.updateConfig({
      ...current,
      providers: {
        ...current.providers,
        opencode: { enabled: false, credentials: { apiKey: '' } },
      },
    });

    const post = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, extra: { anonymous: true, rogue: 'x' } },
    });
    assert.equal(post.statusCode, 200);

    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    const provider = response.json().providers.opencode;
    assert.equal(provider.anonymous, true);
  });

  it('exposes redacted proxyMeta without the plaintext password', async () => {
    const current = registry.getConfig();
    registry.updateConfig({
      ...current,
      providers: {
        ...current.providers,
        opencode: {
          enabled: false,
          credentials: { apiKey: '', extra: { proxies: [] } },
        },
      },
    });

    const post = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: {
        provider: 'opencode',
        enabled: true,
        extra: {
          anonymous: true,
          proxies: ['http://user:secret@host:8080', 'socks5://10.0.0.1:1080', 'direct'],
        },
      },
    });
    assert.equal(post.statusCode, 200);

    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    const provider = response.json().providers.opencode;

    assert.equal(provider.proxyCount, 3);
    assert.deepEqual(
      provider.proxyMeta.map((row: { id: string; hint: string }) => row.id),
      ['p0', 'p1', 'p2'],
    );
    assert.doesNotMatch(JSON.stringify(provider.proxyMeta), /secret/);
    assert.match(provider.proxyMeta[0].hint, /\*\*\*/);
  });

  it('removes a single proxy via removeProxyIndex', async () => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['direct', 'http://a:1', 'http://b:2'] } }),
    );

    const post = await scoped.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, removeProxyIndex: 1 },
    });
    assert.equal(post.statusCode, 200);

    const response = await scoped.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    const provider = response.json().providers.opencode;

    assert.equal(provider.proxyCount, 2);
    assert.deepEqual(
      provider.proxyMeta.map((row: { hint: string }) => row.hint),
      ['direct', 'http://b:2/'],
    );
    await scoped.close();
  });

  it('rejects an out-of-range removeProxyIndex', async () => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['http://a:1'] } }),
    );

    const post = await scoped.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, removeProxyIndex: 9 },
    });
    assert.equal(post.statusCode, 400);
    await scoped.close();
  });

  it('rejects a negative removeProxyIndex', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, removeProxyIndex: -1 },
    });
    assert.equal(post.statusCode, 400);
    assert.match(post.json().error, /removeProxyIndex/);
  });

  it('rejects removeProxyIndex for a non-opencode provider', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', enabled: true, removeProxyIndex: 0 },
    });
    assert.equal(post.statusCode, 400);
  });

  it('removes the key at the same index keyMeta reports', async () => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: {}, apiKeys: ['sk-aaa', '   ', 'sk-bbb'] }),
    );

    const before = await scoped.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    const beforeMeta = before.json().providers.opencode.keyMeta;
    assert.equal(beforeMeta.length, 2, 'a blank key must not occupy an index');

    const post = await scoped.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, removeKeyIndex: 1 },
    });
    assert.equal(post.statusCode, 200);

    const response = await scoped.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    const provider = response.json().providers.opencode;
    assert.equal(provider.keyMeta.length, 1);
    assert.match(provider.keyMeta[0].hint, /aaa/);
    await scoped.close();
  });
});
