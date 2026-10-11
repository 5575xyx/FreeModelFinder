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
  beforeCreate?: (registry: ProviderRegistry) => void,
): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(config);
  beforeCreate?.(registry);
  registry.listAllModels = async () => ({
    models,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  // Deliberately only the PROVIDER is faked. ProviderRegistry.resolveModel itself
  // resolves aliases (registry.ts:464), so stubbing resolveModel here would hide
  // the very routing path these tests are meant to exercise.
  const provider = {
    id: 'custom',
    chat: async (req: { model: string }) => ({ ...CHAT_REPLY, model: req.model }),
    stream: async function* (req: { model: string }) {
      yield {
        id: 'alias-stream',
        model: req.model,
        created: 1,
        delta: 'ok',
        finish_reason: 'stop' as const,
      };
    },
  } as never;
  registry.getProvider = () => provider;
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
  // Routing itself was already alias-aware via resolveModel; Task 4 adds
  // preflight keying (asserted separately below) and the response echo.
  it('routes an aliased model id to the custom provider in all three protocols', async () => {
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
    const chunks = res.body
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line.includes('chat.completion.chunk'))
      .map((line) => JSON.parse(line.slice(6)) as { model: string });
    assert.ok(chunks.length > 0, 'stream must emit at least one chunk');
    assert.equal(chunks[0]?.model, 'my-model');
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
    assert.match(
      res.body,
      /event: message_start\ndata: \{"type":"message_start","message":\{[^}]*"model":"my-model"/,
    );
  });

  it('still echoes the alias when the client requested the real id directly', async () => {
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

  it('hands the REAL model id to preflight so cooldowns key by the real model', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const seen: string[] = [];
    const app = await appWith(config, undefined, (registry) => {
      const router = registry.getAutoRouter();
      const original = router.preflight.bind(router);
      router.preflight = async (model: string) => {
        seen.push(model);
        return original(model);
      };
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.deepEqual(seen, ['custom:fx:fast'], 'preflight must key by the real id, not the alias');
  });
});
