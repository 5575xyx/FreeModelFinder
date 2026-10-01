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
          proxies: ['user:secret@host:8080', 'http://user:secret@host:2', 'direct'],
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
    assert.deepEqual(
      provider.proxyMeta.map((row: { hint: string }) => row.hint),
      ['***@host:8080', 'http://***@host:2/', 'direct'],
    );
  });

  it('removes a single proxy via removeProxyIndex', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['direct', 'http://a:1', 'http://b:2'] } }),
    );
    t.after(() => scoped.close());

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
  });

  it('rejects an out-of-range removeProxyIndex', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['http://a:1'] } }),
    );
    t.after(() => scoped.close());

    const post = await scoped.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, removeProxyIndex: 9 },
    });
    assert.equal(post.statusCode, 400);
  });

  it('rejects a negative removeProxyIndex', async () => {
    // Both 400-only cases below are answered before any config is read, so the shared
    // app is safe here despite its registry being rebuilt by earlier POSTs.
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

  it('removes the key at the same index keyMeta reports', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: {}, apiKeys: ['sk-aaa', '   ', 'sk-bbb'] }),
    );
    t.after(() => scoped.close());

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
  });

  // cleanExtra whitelists extra keys by name only and never inspects array element
  // values, so a non-string proxy reaches storage verbatim. proxyMeta/proxyCount do
  // not filter, so delete indices must address that same unfiltered list.
  it('removes a visible proxy from a list holding a non-string entry', async (t) => {
    const scoped = await serverFor(opencodeConfig({ apiKey: '', extra: {} }));
    t.after(() => scoped.close());

    const seed = await scoped.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, extra: { proxies: [42, 'http://a:1'] } },
    });
    assert.equal(seed.statusCode, 200);

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
    assert.equal(provider.proxyCount, 1);
    assert.deepEqual(
      provider.proxyMeta.map((row: { hint: string }) => row.hint),
      [''],
    );
  });

  it('removes a non-string proxy without clearing the whole list', async (t) => {
    const scoped = await serverFor(opencodeConfig({ apiKey: '', extra: {} }));
    t.after(() => scoped.close());

    const seed = await scoped.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, extra: { proxies: [42, 'http://a:1'] } },
    });
    assert.equal(seed.statusCode, 200);

    const post = await scoped.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'opencode', enabled: true, removeProxyIndex: 0 },
    });
    assert.equal(post.statusCode, 200);

    const response = await scoped.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    const provider = response.json().providers.opencode;
    assert.equal(provider.proxyCount, 1);
    assert.deepEqual(
      provider.proxyMeta.map((row: { hint: string }) => row.hint),
      ['http://a:1/'],
    );
  });

  it('rejects removeProxyIndex submitted together with extra.proxies', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['http://a:1', 'http://b:2'] } }),
    );
    t.after(() => scoped.close());

    const post = await scoped.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: {
        provider: 'opencode',
        enabled: true,
        extra: { proxies: ['http://new:1', 'http://new2:2'] },
        removeProxyIndex: 0,
      },
    });
    assert.equal(post.statusCode, 400);
    assert.match(post.json().error, /conflicts/);
  });

  // opencodeConfig leaves the provider disabled on purpose: saved rows are listed and
  // removable regardless of `enabled`, so revealing one must work the same way.
  it('reveals one stored key without exposing the others in /api/config', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({
        apiKey: '',
        apiKeys: ['sk-first-secret', 'sk-second-secret'],
        extra: { proxies: ['http://user:pw@host:1'] },
      }),
    );
    t.after(() => scoped.close());

    const reveal = await scoped.inject({
      method: 'POST',
      url: '/api/providers/reveal',
      headers: localUiHeaders,
      payload: { provider: 'opencode', kind: 'key', index: 1 },
    });
    assert.equal(reveal.statusCode, 200);
    assert.deepEqual(reveal.json(), { value: 'sk-second-secret' });

    const config = await scoped.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.doesNotMatch(config.body, /sk-first-secret/);
    assert.doesNotMatch(config.body, /sk-second-secret/);
  });

  it('reveals a stored proxy including its password', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['http://user:pw@host:1'] } }),
    );
    t.after(() => scoped.close());

    const reveal = await scoped.inject({
      method: 'POST',
      url: '/api/providers/reveal',
      headers: localUiHeaders,
      payload: { provider: 'opencode', kind: 'proxy', index: 0 },
    });
    assert.equal(reveal.statusCode, 200);
    assert.equal(reveal.json().value, 'http://user:pw@host:1');
  });

  // The row at index 1 is what proxyMeta renders as the second row, so a filtered
  // lookup would hand back 42's slot or miss entirely.
  it('reveals a proxy at the raw index held by a non-string entry', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: [42, 'http://a:1'] } }),
    );
    t.after(() => scoped.close());

    const reveal = await scoped.inject({
      method: 'POST',
      url: '/api/providers/reveal',
      headers: localUiHeaders,
      payload: { provider: 'opencode', kind: 'proxy', index: 1 },
    });
    assert.equal(reveal.statusCode, 200);
    assert.deepEqual(reveal.json(), { value: 'http://a:1' });
  });

  it('returns 404 for an out-of-range reveal index', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['http://a:1'] } }),
    );
    t.after(() => scoped.close());

    const reveal = await scoped.inject({
      method: 'POST',
      url: '/api/providers/reveal',
      headers: localUiHeaders,
      payload: { provider: 'opencode', kind: 'proxy', index: 42 },
    });
    assert.equal(reveal.statusCode, 404);
  });

  it('rejects an unknown reveal kind and a non-integer index', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['http://a:1'] } }),
    );
    t.after(() => scoped.close());

    const badKind = await scoped.inject({
      method: 'POST',
      url: '/api/providers/reveal',
      headers: localUiHeaders,
      payload: { provider: 'opencode', kind: 'nope', index: 0 },
    });
    assert.equal(badKind.statusCode, 400);

    const badIndex = await scoped.inject({
      method: 'POST',
      url: '/api/providers/reveal',
      headers: localUiHeaders,
      payload: { provider: 'opencode', kind: 'key', index: 1.5 },
    });
    assert.equal(badIndex.statusCode, 400);
  });

  it('requires the ui origin guard for reveal', async (t) => {
    const scoped = await serverFor(
      opencodeConfig({ apiKey: '', extra: { proxies: ['http://a:1'] } }),
    );
    t.after(() => scoped.close());

    const reveal = await scoped.inject({
      method: 'POST',
      url: '/api/providers/reveal',
      headers: { 'x-fmf-client': 'ui' },
      payload: { provider: 'opencode', kind: 'key', index: 0 },
    });
    assert.equal(reveal.statusCode, 403);
  });
});
