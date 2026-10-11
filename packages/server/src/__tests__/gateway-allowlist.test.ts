import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatResponse,
  type GatewayKeyEntry,
  type ProviderId,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { keyModelAllowlist } from '../routes/openai.js';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// No `model` here: the fake provider echoes the id it was actually asked for
// (`req.model`), so a baked-in value would only ever be overwritten.
const CHAT_REPLY = {
  id: 'allowlist-reply',
  created: 1_700_000_000,
  content: 'ok',
  finish_reason: 'stop',
} as const;

const KEY = 'test-key';
const KEY_HEADERS = { authorization: `Bearer ${KEY}` };

// The dashboard authenticates without a bearer key, so it must never be
// allowlist-restricted — that is what keeps /v1/models usable locally.
const LOCAL_UI_HEADERS = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

// Catalog `id`s are the PROVIDER's own ids: "fx:fast" for a custom source and
// "gpt-4o-mini" for OpenRouter. Allowlists hold the composed form, so the two
// never compare literally and composeModelId() is mandatory.
const CATALOG = [
  { id: 'fx:fast', provider: 'custom' as const, displayName: 'Fast', free: true },
  { id: 'fx:plain', provider: 'custom' as const, displayName: 'Plain', free: true },
  {
    id: 'gpt-4o-mini',
    provider: 'openrouter' as const,
    displayName: 'GPT-4o Mini',
    free: true,
  },
];

type CatalogModel = (typeof CATALOG)[number];

function baseConfig(gateway: AppConfig['gateway']): AppConfig {
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
                id: 'fx',
                label: 'FX',
                baseUrl: 'https://fx.invalid/v1',
                apiKey: 'k',
                models: [
                  { id: 'plain', displayName: 'Plain' },
                  { id: 'fast', displayName: 'Fast' },
                ],
              },
            ],
          },
        },
      },
    },
    gateway,
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

function key(modelAllowlist?: string[]): GatewayKeyEntry {
  return { id: 'k1', key: KEY, createdAt: 0, ...(modelAllowlist ? { modelAllowlist } : {}) };
}

async function appWith(
  config: AppConfig,
  models: CatalogModel[] = CATALOG,
  beforeCreate?: (registry: ProviderRegistry) => void,
): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(config);
  beforeCreate?.(registry);
  registry.listAllModels = async () => ({
    models,
    succeededProviders: ['custom' as const, 'openrouter' as const],
    failedProviders: [],
  });
  // Deliberately only the PROVIDER is faked. ProviderRegistry.resolveModel
  // itself resolves aliases (registry.ts:464) and splits "provider:" prefixes,
  // so stubbing resolveModel would hide the routing path these tests exercise.
  const providerWith = (providerId: ProviderId) =>
    ({
      id: providerId,
      chat: async (req: { model: string }): Promise<ChatResponse> => ({
        ...CHAT_REPLY,
        model: req.model,
      }),
      stream: async function* (req: { model: string }) {
        yield {
          id: 'allowlist-stream',
          model: req.model,
          created: 1,
          delta: 'ok',
          finish_reason: 'stop' as const,
        };
      },
    }) as never;
  registry.getProvider = ((providerId: ProviderId) => providerWith(providerId)) as never;
  // "auto" resolution reads modelsCache, which listAllModels() normally fills.
  (registry as unknown as { modelsCache: unknown; cacheAt: number }).modelsCache = {
    models,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  };
  (registry as unknown as { cacheAt: number }).cacheAt = Date.now();
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

describe('keyModelAllowlist', () => {
  it('treats a missing key, an empty list, and all-invalid entries as unrestricted', () => {
    assert.equal(keyModelAllowlist(undefined), null);
    assert.equal(keyModelAllowlist(key()), null);
    assert.equal(keyModelAllowlist(key([])), null);
    assert.equal(keyModelAllowlist(key([42, '', '   '] as unknown as string[])), null);
  });

  it('keeps only the valid entries of a dirty list and trims them', () => {
    const set = keyModelAllowlist(key([42, '', '   ', 'custom:fx:fast'] as unknown as string[]));
    assert.ok(set, 'one valid entry must still restrict the key');
    assert.deepEqual(set, new Set(['custom:fx:fast']));
  });
});

describe('gateway key model allowlist', () => {
  it('leaves a key without a modelAllowlist fully unrestricted', async () => {
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key()] }));

    const list = await app.inject({ method: 'GET', url: '/v1/models', headers: KEY_HEADERS });
    assert.equal(list.statusCode, 200);
    const models = list.json() as { data: Array<{ id: string }> };
    // `data[].id` is the provider-native catalog id, not the composed form.
    assert.deepEqual(models.data.map((m) => m.id).sort(), ['fx:fast', 'fx:plain', 'gpt-4o-mini']);

    for (const model of ['custom:fx:fast', 'custom:fx:plain', 'openrouter:gpt-4o-mini']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: KEY_HEADERS,
        payload: { model, messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(res.statusCode, 200, `${model} must stay reachable`);
    }
  });

  it('shows only the allowlisted models to a restricted key', async () => {
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }));

    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: KEY_HEADERS });
    assert.equal(res.statusCode, 200);
    const models = res.json() as { data: Array<{ id: string }> };
    assert.deepEqual(
      models.data.map((m) => m.id),
      ['fx:fast'],
    );
  });

  it('returns an empty list rather than failing when nothing matches', async () => {
    const app = await appWith(
      baseConfig({ requireAuth: true, keys: [key(['custom:fx:nonexistent'])] }),
    );

    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: KEY_HEADERS });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as { data: unknown[] }).data, []);
  });

  it('still renders an alias for an allowlisted model', async () => {
    // The alias is configured on the composed target, exactly as the UI writes
    // it, and the allowlist entry is that same composed id.
    const config = baseConfig({ requireAuth: true, keys: [key(['openrouter:gpt-4o-mini'])] });
    config.modelAliases = { 'my-model': 'openrouter:gpt-4o-mini' };
    const app = await appWith(
      config,
      CATALOG.filter((m) => m.provider === 'openrouter'),
    );

    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: KEY_HEADERS });
    assert.equal(res.statusCode, 200);
    const models = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    assert.equal(models.data.length, 1, 'only the allowlisted model may survive the filter');
    assert.equal(models.data[0]?.id, 'my-model', 'the client-facing id must be the alias');
    // alias_of carries the catalog id (bare for OpenAI-compatible providers),
    // mirroring the contract pinned in model-aliases.test.ts.
    assert.equal(models.data[0]?.alias_of, 'gpt-4o-mini');
  });

  it('resolves a bare catalog id through its composed allowlist entry', async () => {
    const app = await appWith(
      baseConfig({ requireAuth: true, keys: [key(['openrouter:gpt-4o-mini'])] }),
    );

    const list = await app.inject({ method: 'GET', url: '/v1/models', headers: KEY_HEADERS });
    assert.equal(list.statusCode, 200);
    const models = list.json() as { data: Array<{ id: string }> };
    assert.deepEqual(
      models.data.map((m) => m.id),
      ['gpt-4o-mini'],
    );

    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: KEY_HEADERS,
      payload: { model: 'openrouter:gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(chat.statusCode, 200);
  });

  it('allows a POST for an allowlisted model', async () => {
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: KEY_HEADERS,
      payload: { model: 'custom:fx:fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 200);
  });

  it('rejects a POST for a model outside the allowlist', async () => {
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: KEY_HEADERS,
      payload: { model: 'custom:fx:plain', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'model_not_allowed');
  });

  it('allows a POST that names an alias whose target is allowlisted', async () => {
    const config = baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] });
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: KEY_HEADERS,
      payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 200);
  });

  it('rejects automatic routing for a restricted key', async () => {
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: KEY_HEADERS,
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'model_not_allowed');
  });

  it('keeps automatic routing working for an unrestricted key', async () => {
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key()] }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: KEY_HEADERS,
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 200);
  });

  it('applies no restriction when the gateway does not require auth', async () => {
    const app = await appWith(baseConfig({ requireAuth: false }));

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200);
    const models = res.json() as { data: Array<{ id: string }> };
    assert.equal(models.data.length, 3);
  });

  it('never restricts the local dashboard, which authenticates without a key', async () => {
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: LOCAL_UI_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const models = res.json() as { data: Array<{ id: string }> };
    assert.equal(models.data.length, 3, 'the UI must see the full catalog');
  });
});
