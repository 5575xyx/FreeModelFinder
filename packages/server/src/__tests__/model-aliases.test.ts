import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatResponse,
  type ProviderId,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// No `model` here: the fake provider echoes the id it was actually asked for
// (`req.model`), so a baked-in value would only ever be overwritten. The
// provider supplies it, keeping the assembled object a complete ChatResponse.
const CHAT_REPLY = {
  id: 'alias-reply',
  created: 1_700_000_000,
  content: 'ok',
  finish_reason: 'stop',
} as const;

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

// Catalog for the in-chat image/video shortcut tests. The capability
// fast-path keys off the LAST id segment (openai.ts:616), so these bare ids
// carry the 'image'/'vid' markers the /image/i and /vid(eo)?/i tests match.
const IMAGE_VIDEO_MODELS = [
  { id: 'custom:fx:image-model', provider: 'custom' as const, displayName: 'Image', free: true },
  { id: 'custom:fx:vid-model', provider: 'custom' as const, displayName: 'Vid', free: true },
];

async function appWith(
  config: AppConfig,
  models: Array<{
    id: string;
    provider: ProviderId;
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
    chat: async (req: { model: string }): Promise<ChatResponse> => ({
      ...CHAT_REPLY,
      model: req.model,
    }),
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

  it('replaces a custom source model with its alias despite the custom-prefixed target', async () => {
    // A real CustomProvider catalog id is "<source>:<model>" (no "custom:"
    // prefix), while the UI alias picker emits "custom:<source>:<model>".
    // The alias must still render, or custom aliases silently never apply.
    const config = baseConfig();
    config.modelAliases = { 'GLM-5.3': 'custom:fx:fast' };
    const app = await appWith(config, [
      { id: 'fx:fast', provider: 'custom', displayName: 'Fast', free: true },
    ]);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.id, 'GLM-5.3');
    assert.equal(body.data[0]?.alias_of, 'fx:fast');
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

  // The image/video shortcut branches build their payload by hand instead of
  // going through dispatchWithAutoRoute, so they needed their own echo fix.
  it('echoes the alias from the in-chat image shortcut branch', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-image': 'custom:fx:image-model' };
    const app = await appWith(config, IMAGE_VIDEO_MODELS, (registry) => {
      registry.generateImage = async () => ({
        provider: registry.getProvider('custom'),
        response: { created: 1, data: [{ url: 'https://img.invalid/a.png' }] },
      });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'my-image', messages: [{ role: 'user', content: 'a cat' }] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { model: string };
    assert.equal(body.model, 'my-image');
  });

  it('echoes the alias from the in-chat video shortcut branch', async () => {
    const config = baseConfig();
    // 'vid-…' matches /vid(eo)?/i and the composed id keeps the real 'custom'
    // provider prefix, which the branch echoes into the polling hint.
    config.modelAliases = { 'my-video': 'custom:fx:vid-model' };
    const app = await appWith(config, IMAGE_VIDEO_MODELS, (registry) => {
      registry.generateVideo = async () => ({
        provider: registry.getProvider('custom'),
        response: { video_id: 'vid_123', status: 'queued' },
      });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'my-video', messages: [{ role: 'user', content: 'a cat' }] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { model: string };
    assert.equal(body.model, 'my-video');
  });
});

// /api/* is gated by the local-UI origin check (server.ts:525), so management
// requests must carry the same headers the dashboard sends — see
// auto-route-api.test.ts.
const localUiHeaders = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

describe('/api/model-aliases', () => {
  it('returns an empty map when nothing is configured', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'GET',
      url: '/api/model-aliases',
      headers: localUiHeaders,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { modelAliases: {} });
  });

  it('persists a valid alias map', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: { 'my-model': 'custom:fx:fast' } },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, modelAliases: { 'my-model': 'custom:fx:fast' } });

    const get = await app.inject({
      method: 'GET',
      url: '/api/model-aliases',
      headers: localUiHeaders,
    });
    assert.deepEqual(get.json(), { modelAliases: { 'my-model': 'custom:fx:fast' } });
  });

  it('replaces the whole map so an omitted alias is deleted', async () => {
    const config = baseConfig();
    config.modelAliases = { 'old-alias': 'custom:fx:fast' };
    const app = await appWith(config);

    await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: { 'new-alias': 'custom:fx:plain' } },
    });
    const get = await app.inject({
      method: 'GET',
      url: '/api/model-aliases',
      headers: localUiHeaders,
    });
    assert.deepEqual(get.json(), { modelAliases: { 'new-alias': 'custom:fx:plain' } });
  });

  it('rejects an alias containing a colon', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: { 'my:model': 'custom:fx:fast' } },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: string }).error, /:/);
  });

  it('rejects the reserved alias name auto', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: { auto: 'custom:fx:fast' } },
    });
    assert.equal(res.statusCode, 400);
  });

  it('reports the colon rule before the conflict rule for a prefixed alias', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: { 'custom:fx:fast': 'custom:fx:plain' } },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: string }).error, /must not contain/);
  });

  it('rejects a non-object payload', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: ['nope'] },
    });
    assert.equal(res.statusCode, 400);
  });

  // Alias names may safely equal a real model id: shadowing is a no-op in the
  // reverse lookup held by toClientFacingModel, and the only real conflict that
  // matters is two aliases claiming the same target, which is rejected below.
  it('accepts an alias named after a catalog id that points to another model', async () => {
    const app = await appWith(baseConfig(), [
      { id: 'gpt-4o-mini', provider: 'openrouter', displayName: 'GPT-4o Mini', free: true },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: { 'gpt-4o-mini': 'custom:fx:plain' } },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as { modelAliases: Record<string, string> }).modelAliases, {
      'gpt-4o-mini': 'custom:fx:plain',
    });
  });

  // Same for the bare (provider-stripped) id of a prefixed catalog model.
  it('accepts an alias named after the bare id of a prefixed model', async () => {
    const app = await appWith(baseConfig(), [
      { id: 'cline:z-ai/glm-5.3-flash', provider: 'cline', displayName: 'GLM', free: true },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: { 'z-ai/glm-5.3-flash': 'custom:fx:plain' } },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as { modelAliases: Record<string, string> }).modelAliases, {
      'z-ai/glm-5.3-flash': 'custom:fx:plain',
    });
  });

  it('rejects a body that omits modelAliases rather than clearing silently', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('clears every alias with an explicit empty map', async () => {
    const config = baseConfig();
    config.modelAliases = { old: 'custom:fx:fast' };
    const app = await appWith(config);
    await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: {} },
    });
    const get = await app.inject({
      method: 'GET',
      url: '/api/model-aliases',
      headers: localUiHeaders,
    });
    assert.deepEqual(get.json(), { modelAliases: {} });
  });
});

// Source-scoped alias names carry a '/' ('novaway/glm') to scope the alias to a
// source in the UI. The existing machinery must stay '/'-compatible end to
// end: validateModelAliases only forbids ':' (config/aliases.ts), resolveModel
// hits the alias table verbatim before any ':' parsing, and the allowlist stays
// keyed on composed ids. Pins this so Tasks 3/4 can build on it.
describe('/api/model-aliases with source-scoped (slashed) alias names', () => {
  it('round-trips a slashed alias name through POST/GET', async () => {
    const app = await appWith(baseConfig());

    const post = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      headers: localUiHeaders,
      payload: { modelAliases: { 'novaway/glm': 'custom:novaway:glm-5.3' } },
    });
    assert.equal(post.statusCode, 200, 'a slashed alias name must be legal today');
    assert.deepEqual(post.json(), {
      ok: true,
      modelAliases: { 'novaway/glm': 'custom:novaway:glm-5.3' },
    });

    const get = await app.inject({
      method: 'GET',
      url: '/api/model-aliases',
      headers: localUiHeaders,
    });
    assert.equal(get.statusCode, 200);
    assert.deepEqual(get.json(), { modelAliases: { 'novaway/glm': 'custom:novaway:glm-5.3' } });
  });

  it('routes a request for the slashed alias to the composed target and echoes it back', async () => {
    // No ':' means the alias-table lookup (registry.ts) runs verbatim and
    // before the source-prefix parser, so 'novaway/glm' reaches the alias
    // table — and the alias is the name the response must echo.
    const config = baseConfig();
    config.modelAliases = { 'novaway/glm': 'custom:novaway:glm-5.3' };
    const app = await appWith(config, [
      {
        // provider-native id (no 'custom:' prefix); the alias target is the
        // composed form the UI emits, matching ModelInfo convention.
        id: 'novaway:glm-5.3',
        provider: 'custom',
        displayName: 'GLM 5.3',
        free: true,
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'novaway/glm', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { model: string };
    assert.equal(body.model, 'novaway/glm', 'toClientFacingModel must echo the alias name');

    // The echo must be driven by the alias-table reverse lookup, not by the
    // fake provider: asking for the composed id directly returns the alias.
    const byRealId = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'custom:novaway:glm-5.3', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(byRealId.statusCode, 200);
    assert.equal(byRealId.json().model, 'novaway/glm');
  });

  it('does not let a slashed alias name leak into auto allowlist matching', async () => {
    // The gateway auto-route test lives in gateway-allowlist.test.ts; pin the
    // same invariant from this file's fixtures: a restricted key's allowlist
    // keeps matching on composed ids, so a slashed alias name pointing at the
    // same model neither grants nor revokes access.
    const config = baseConfig();
    config.modelAliases = { 'novaway/glm': 'custom:novaway:glm-5.3' };
    config.gateway = {
      requireAuth: true,
      keys: [
        { id: 'k1', key: 'test-key', createdAt: 0, modelAllowlist: ['custom:novaway:glm-5.3'] },
      ],
    };
    config.autoRoute = { enabled: true, strategy: 'capability' };
    // ids are provider-native (no 'custom:' prefix); composeModelId adds it.
    const autoCatalog = [
      {
        id: 'novaway:glm-5.3',
        provider: 'custom' as const,
        displayName: 'GLM 5.3',
        free: true,
      },
      { id: 'fx:plain', provider: 'custom' as const, displayName: 'Plain', free: true },
    ];
    // `auto` resolution reads modelsCache, which the stubbed listAllModels never fills.
    // Populate it the same way gateway-allowlist.test.ts does so pickAutoModel can
    // see the catalog and the allowlist check runs against the composed ids.
    const app = await appWith(config, autoCatalog, (registry) => {
      const cache = registry as unknown as { modelsCache: unknown; cacheAt: number };
      cache.modelsCache = {
        models: autoCatalog,
        succeededProviders: ['custom' as const],
        failedProviders: [],
      };
      cache.cacheAt = Date.now();
    });

    const headers = { authorization: 'Bearer test-key' };
    // The alias resolves to a model on the allowlist → 200.
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: { model: 'novaway/glm', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.json()));
    assert.equal(ok.json().model, 'novaway/glm');

    // The slashed alias name itself is NOT an allowlist entry: the composed
    // auto pick still matches by the composed id, not by alias-name strings.
    const auto = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(auto.statusCode, 200, JSON.stringify(auto.json()));
    assert.equal(auto.json().model, 'novaway/glm');
  });
});
