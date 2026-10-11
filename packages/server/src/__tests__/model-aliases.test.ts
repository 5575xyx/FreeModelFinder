import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig, type ChatResponse } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const CHAT_REPLY: ChatResponse = {
  id: 'alias-reply',
  model: 'plain',
  created: 1_700_000_000,
  content: 'ok',
  finish_reason: 'stop',
};

function baseConfig(): AppConfig {
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
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

async function appWith(
  config: AppConfig,
  models: Array<{
    id: string;
    provider: 'custom' | 'openrouter';
    displayName: string;
    free: boolean;
  }> = [
    { id: 'custom:fx:plain', provider: 'custom', displayName: 'Plain', free: true },
    { id: 'custom:fx:fast', provider: 'custom', displayName: 'Fast', free: true },
  ],
): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(config);
  registry.listAllModels = async () => ({
    models,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  // Not exercised by the /v1/models tests; present so later dispatch tests can
  // add cases here without rebuilding the harness.
  //
  // Deliberately does NOT resolve aliases: the route handlers must call
  // resolveAlias before preflight, which is exactly what the dispatch tests
  // below assert. It mirrors the real registry only for the part that runs
  // after that normalization: a composed custom id keeps its SOURCE segment
  // (bareModelId('custom', 'fx:fast') === 'fx:fast'), so finalModel composes
  // back to 'custom:fx:fast' and the reverse lookup can match the alias
  // target. Anything else throws, as an unresolvable model does in production.
  registry.resolveModel = (model) => {
    const sep = model.indexOf(':');
    if (sep <= 0 || model.slice(0, sep) !== 'custom' || sep === model.length - 1) {
      throw new Error(`unknown model: ${model}`);
    }
    const id = model.slice(sep + 1);
    return {
      provider: {
        id: 'custom',
        chat: async () => ({ ...CHAT_REPLY, model: id }),
        stream: async function* () {
          yield { id: 'alias-stream', model: id, created: 1, delta: 'ok', finish_reason: 'stop' };
        },
      } as never,
      modelId: id,
    };
  };
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

describe('/v1/models alias replacement', () => {
  it('replaces an aliased model id with the alias and adds alias_of', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };

    const aliased = body.data.find((m) => m.id === 'my-model');
    assert.ok(aliased, 'alias must appear in the list');
    assert.equal(aliased.alias_of, 'custom:fx:fast');
    assert.equal(
      body.data.some((m) => m.id === 'custom:fx:fast'),
      false,
      'the original id must be replaced, not duplicated',
    );
  });

  it('leaves a model without an alias untouched and without alias_of', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    const plain = body.data.find((m) => m.id === 'custom:fx:plain');
    assert.ok(plain);
    assert.equal(plain.alias_of, undefined);
  });

  it('returns real ids unchanged when no alias is configured', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    assert.deepEqual(body.data.map((m) => m.id).sort(), ['custom:fx:fast', 'custom:fx:plain']);
    assert.equal(
      body.data.every((m) => m.alias_of === undefined),
      true,
    );
  });

  it('keys capability_score and quota by the real id, not the alias', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    config.autoRoute = {
      enabled: false,
      strategy: 'capability',
      // Deliberately distinctive: a lookup keyed by the alias would miss the
      // profile and silently fall back to the heuristic baseline (50 here).
      profiles: [{ id: 'custom:fx:fast', provider: 'custom', capabilityScore: 99 }],
    };
    const app = await appWith(config);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      data: Array<{
        id: string;
        alias_of?: string;
        capability_score: number;
        quota: { model: string };
      }>;
    };

    const aliased = body.data.find((m) => m.id === 'my-model');
    assert.ok(aliased, 'alias must appear in the list');
    assert.equal(aliased.alias_of, 'custom:fx:fast');
    assert.equal(
      aliased.capability_score,
      99,
      'capability_score must look up the routing profile by the real id',
    );
    // getModelQuota echoes composeModelId(provider, bare); for the custom
    // provider that doubles the prefix. What matters is that it was keyed by the
    // real id — with the alias it would have been 'custom:my-model'.
    assert.equal(aliased.quota.model, 'custom:custom:fx:fast');
  });

  it('replaces a bare catalog id and reports the catalog id as alias_of', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'openrouter:gpt-4o-mini' };
    const app = await appWith(config, [
      { id: 'gpt-4o-mini', provider: 'openrouter', displayName: 'GPT-4o Mini', free: true },
    ]);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.id, 'my-model');
    // alias_of carries the CATALOG id, which for OpenAI-compatible providers is
    // the bare form — not the composed alias target.
    assert.equal(body.data[0]?.alias_of, 'gpt-4o-mini');
  });
});

describe('alias routing and response echo', () => {
  it('routes an aliased model id to the real provider in all three protocols', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    for (const request of [
      {
        url: '/v1/chat/completions',
        payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }] },
      },
      {
        url: '/v1/messages',
        payload: { model: 'my-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      },
      {
        url: '/v1beta/models/my-model:generateContent',
        payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      },
    ]) {
      const res = await app.inject({ method: 'POST', ...request });
      assert.equal(res.statusCode, 200, `${request.url} should succeed`);
      assert.match(res.body, /ok/);
    }
  });

  it('echoes the alias as the response model for OpenAI non-streaming', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    const body = res.json() as { model: string };
    assert.equal(body.model, 'my-model');
  });

  it('echoes the alias as the response model for OpenAI streaming chunks', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"model":"my-model"/);
  });

  it('echoes the alias as the response model for Anthropic non-streaming', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'my-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    });
    const body = res.json() as { model: string };
    assert.equal(body.model, 'my-model');
  });

  it('echoes the alias in the Anthropic message_start frame', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'my-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"model":"my-model"/);
  });

  it('keeps echoing the composed real id when the request used the original id', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'custom:fx:fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    const body = res.json() as { model: string };
    assert.equal(body.model, 'my-model');
  });
});
