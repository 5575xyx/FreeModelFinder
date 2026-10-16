import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  resetAutoPoolCursor,
  updateConfig,
  type AppConfig,
  type ChatResponse,
  type GatewayKeyEntry,
  type ProviderId,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { keyModelAllowlist, withinAllowlist } from '../routes/openai.js';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

const UI_HEADERS = { origin: 'http://127.0.0.1:11435', 'x-fmf-client': 'ui' };

type GatewayKeyView = {
  id: string;
  key: string;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  dailyRequestLimit: number | null;
  dailyTokenLimit: number | null;
  modelAllowlist: string[];
};

async function gatewayApi(
  app: FastifyInstance,
  body?: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => { keys: GatewayKeyView[] } }> {
  return app.inject({
    method: body ? 'POST' : 'GET',
    url: '/api/gateway',
    headers: UI_HEADERS,
    ...(body ? { payload: body } : {}),
  }) as unknown as { statusCode: number; json: () => { keys: GatewayKeyView[] } };
}

/**
 * `POST /api/gateway` mutates through core's `updateConfig`, which reads the
 * config FROM DISK — not from the registry passed to `createServer`. Without a
 * matching baseline on disk the handler would edit a stale config and the test
 * would silently exercise the wrong keys.
 */
async function appWithBaseline(gateway: AppConfig['gateway']): Promise<FastifyInstance> {
  const config = baseConfig(gateway);
  await updateConfig(() => config);
  return await appWith(config);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  // Sticky picks are keyed by the request's opening message, and these tests
  // reuse the same one — so a pick made by an earlier test would otherwise be
  // replayed here instead of a fresh automatic route.
  resetAutoPoolCursor();
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

/** `autoRoute.enabled: true` is what makes the router look at cooldowns at all. */
function autoRouteConfig(gateway: AppConfig['gateway'], fallbackChain?: string[]): AppConfig {
  const config = baseConfig(gateway);
  config.autoRoute = {
    enabled: true,
    strategy: 'capability',
    ...(fallbackChain ? { fallbackChain } : {}),
  };
  return config;
}

/**
 * Puts a model in cooldown before the request is made. `custom` is NOT a
 * shared-quota provider, so this stays model-scoped and a sibling `custom:`
 * model remains eligible — exactly the shape the failover tests need. The
 * `fallbackChain` in the config pins WHICH candidate wins, so the tests do not
 * depend on model scores.
 */
function coolDown(model: string): (registry: ProviderRegistry) => void {
  return (registry) => {
    registry.getAutoRouter().markRateLimited(model, 'custom', {
      isRateLimit: true,
      message: 'test: rate limited',
    });
  };
}

async function chat(app: FastifyInstance, model: string, body: object = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: KEY_HEADERS,
    payload: { model, messages: [{ role: 'user', content: 'hi' }], ...body },
  });
}

async function anthropic(app: FastifyInstance, model: string, body: object = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: KEY_HEADERS,
    payload: {
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      ...body,
    },
  });
}

/**
 * Gemini carries the model in the URL path, so it is percent-encoded here. The
 * preHandler decodes it again; every other helper hands a literal model id.
 */
async function gemini(
  app: FastifyInstance,
  model: string,
  action: 'generateContent' | 'streamGenerateContent' = 'generateContent',
) {
  return app.inject({
    method: 'POST',
    url: `/v1beta/models/${encodeURIComponent(model)}:${action}`,
    headers: KEY_HEADERS,
    payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
  });
}

/** The parsed `data:` payloads of an SSE body, in order. */
function ssePayloads(body: string): Array<Record<string, unknown>> {
  return (
    body
      .split(/\r?\n\r?\n/)
      .map((frame) => (frame.startsWith('data: ') ? frame.slice('data: '.length).trim() : ''))
      // The OpenAI stream terminates with `data: [DONE]`, which is not JSON.
      .filter((json) => json.startsWith('{'))
      .map((json) => JSON.parse(json) as Record<string, unknown>)
  );
}

/**
 * Knobs for the faked providers. Bare catalog ids reach the provider (`fx:fast`
 * for a custom source, `gpt-4o-mini` for OpenRouter), so both hooks are keyed
 * on the bare form.
 */
interface ProviderHooks {
  /** every `chat` dispatch, in order — the "what actually served" oracle */
  dispatchLog: string[];
  /** bare model id that fails exactly once with a 429, or null to never fail */
  rateLimitOnce?: string;
}

async function appWith(
  config: AppConfig,
  models: CatalogModel[] = CATALOG,
  beforeCreate?: (registry: ProviderRegistry) => void,
  hooks: ProviderHooks = { dispatchLog: [] },
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
  const failOnce = hooks.rateLimitOnce;
  let failed = false;
  const providerWith = (providerId: ProviderId) => {
    const chat = async (req: { model: string }): Promise<ChatResponse> => {
      hooks.dispatchLog.push(req.model);
      if (failOnce && !failed && req.model === failOnce) {
        failed = true;
        throw new Error('Upstream failed 429: too many requests');
      }
      return { ...CHAT_REPLY, model: req.model };
    };
    return {
      id: providerId,
      chat,
      stream: async function* (req: { model: string }) {
        hooks.dispatchLog.push(req.model);
        yield {
          id: 'allowlist-stream',
          model: req.model,
          created: 1,
          delta: 'ok',
          finish_reason: 'stop' as const,
        };
      },
    };
  };
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

  it('keeps only the valid entries of a dirty list, trimming and lowercasing them', () => {
    // The router compares model ids in lowercase, so the set must be built the
    // same way or a mixed-case entry would never match.
    const set = keyModelAllowlist(
      key([42, '', '   ', 'CUSTOM:fx:Fast', 'custom:fx:fast'] as unknown as string[]),
    );
    assert.ok(set, 'one valid entry must still restrict the key');
    assert.deepEqual(set, new Set(['custom:fx:fast']));
  });
});

describe('withinAllowlist', () => {
  const allow = keyModelAllowlist(key(['custom:fx:fast']));

  it('leaves an unrestricted caller unrestricted', () => {
    assert.equal(withinAllowlist('custom:fx:plain', null, []), true);
  });

  it('matches a bare catalog id against its composed allowlist entry', () => {
    assert.ok(allow, 'one valid entry must still restrict the key');
    assert.equal(withinAllowlist('fx:fast', allow, CATALOG), true);
    assert.equal(withinAllowlist('fx:plain', allow, CATALOG), false);
  });

  it('compares a non-catalog id as-is, case-insensitively', () => {
    // An id configured straight into autoRoute.visionModel is not in the
    // catalog, so it cannot be composed — the literal value is the id.
    assert.ok(allow);
    assert.equal(withinAllowlist('CUSTOM:fx:fast', allow, []), true);
    assert.equal(withinAllowlist('custom:fx:plain', allow, []), false);
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

  it('serves automatic routing for a restricted key, inside its allowlist', async () => {
    // `auto` is a first-class model for every key. Refusing it would make every
    // allowlisted key lose automatic routing, which is not what a model
    // allowlist is for — instead the automatic pick itself is constrained to the
    // list (buildFallbackChain / rankCandidates receive it).
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }),
      CATALOG,
      undefined,
      hooks,
    );

    const res = await chat(app, 'auto');
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    const body = res.json() as { model?: string };
    assert.equal(body.model, 'custom:fx:fast', 'the pick must be the only allowed model');
    assert.deepEqual(hooks.dispatchLog, ['fx:fast']);
  });

  it("never picks outside a restricted key's allowlist when auto-routing", async () => {
    // The catalog also holds openrouter:gpt-4o-mini, which is NOT on this key's
    // list. With `fx:fast` cooling, `fx:plain` is the only eligible model — an
    // unconstrained pick would happily reach for the openrouter model instead.
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({
        requireAuth: true,
        keys: [key(['custom:fx:fast', 'custom:fx:plain'])],
      }),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await chat(app, 'auto');
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.deepEqual(hooks.dispatchLog, ['fx:plain']);
    assert.equal(
      (res.json() as { fmf_auto_route?: { picked?: string } }).fmf_auto_route?.picked,
      'custom:fx:plain',
    );
  });

  it("keeps the pool walk inside a restricted key's allowlist", async () => {
    // No pre-request cooldown: `fx:fast` is picked, the provider 429s, and the
    // whole-pool walk has to stay inside the list rather than stepping onto the
    // openrouter model that `auto` would normally consider.
    const hooks = { dispatchLog: [] as string[], rateLimitOnce: 'fx:fast' };
    const app = await appWith(
      autoRouteConfig({
        requireAuth: true,
        keys: [key(['custom:fx:fast', 'custom:fx:plain'])],
      }),
      CATALOG,
      undefined,
      hooks,
    );

    const res = await chat(app, 'auto');
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.deepEqual(hooks.dispatchLog, ['fx:fast', 'fx:plain']);
    assert.equal((res.json() as { model?: string }).model, 'custom:fx:plain');
    assert.ok(!hooks.dispatchLog.includes('gpt-4o-mini'), 'the walk must not leave the list');
  });

  it("fails clearly when a restricted key's allowlist admits no model", async () => {
    // The only allowed model is cooling, so `auto` has nothing legal to serve.
    // It must NOT fall through to the first catalog model — that is the bypass.
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await chat(app, 'auto');
    assert.notEqual(res.statusCode, 200, 'nothing legal was eligible, so no 200');
    assert.match(
      JSON.stringify(res.json()),
      /allowed list is available/,
      'the failure must say the allowlist is the reason',
    );
    assert.deepEqual(hooks.dispatchLog, [], 'no model may be dispatched');
  });

  it('allows `default` when the default model is on the list, and refuses it otherwise', async () => {
    // `default` is not automatic routing — it resolves to the configured default
    // model, so it is checked like any other concrete model.
    const withDefault = baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] });
    withDefault.defaultModel = 'custom:fx:fast';
    const appOk = await appWith(withDefault);
    const ok = await chat(appOk, 'default');
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.json()));

    const withoutDefault = baseConfig({ requireAuth: true, keys: [key(['custom:fx:plain'])] });
    withoutDefault.defaultModel = 'custom:fx:fast';
    const appDenied = await appWith(withoutDefault);
    const denied = await chat(appDenied, 'default');
    assert.equal(denied.statusCode, 403, JSON.stringify(denied.json()));
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'model_not_allowed');
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

  it('treats an explicitly empty allowlist exactly like no allowlist', async () => {
    // Task 2 persists an unconfigured allowlist as [], so this is the shape a
    // never-touched key will most likely take. It must stay unrestricted.
    const unrestricted = await appWith(baseConfig({ requireAuth: true, keys: [key()] }));
    const empty = await appWith(baseConfig({ requireAuth: true, keys: [key([])] }));

    const list = (res: { json(): { data: Array<{ id: string }> } }) =>
      res
        .json()
        .data.map((m) => m.id)
        .sort();

    const a = await unrestricted.inject({ method: 'GET', url: '/v1/models', headers: KEY_HEADERS });
    const b = await empty.inject({ method: 'GET', url: '/v1/models', headers: KEY_HEADERS });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.deepEqual(list(b), list(a));
    assert.equal(list(b).length, 3, 'every model must be listed');

    for (const model of ['custom:fx:fast', 'custom:fx:plain', 'openrouter:gpt-4o-mini']) {
      const res = await chat(empty, model);
      assert.equal(res.statusCode, 200, `${model} must stay reachable`);
    }
  });

  it('matches an allowlist entry regardless of its casing', async () => {
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key(['CUSTOM:fx:Fast'])] }));

    const res = await chat(app, 'custom:fx:fast');
    assert.equal(res.statusCode, 200, 'casing must not be a lockout');
  });

  it('refuses a whitespace-padded model name instead of trimming it', async () => {
    // Authorization resolves the RAW model name, byte-identical to what the
    // handler dispatches. Trimming here would silently forgive a typo: " auto"
    // would become automatic routing rather than an unknown model. A stray space
    // is reported as "not allowed" and left for the handler to report.
    const app = await appWith(baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }));

    for (const model of ['custom:fx:fast ', ' custom:fx:fast', 'auto ', ' auto']) {
      const res = await chat(app, model);
      assert.equal(res.statusCode, 403, `${JSON.stringify(model)} must be refused`);
      const error = (res.json() as { error: { code: string; message: string } }).error;
      assert.equal(
        error.code,
        'model_not_allowed',
        `${JSON.stringify(model)} must be an allowlist refusal, not a resolution failure`,
      );
      assert.match(
        error.message,
        /Allowed models: custom:fx:fast/,
        `${JSON.stringify(model)} must not be misread as automatic routing`,
      );
    }

    // The exact, unspaced name is unaffected.
    const exact = await chat(app, 'custom:fx:fast');
    assert.equal(exact.statusCode, 200, 'the exact name must still work');
  });

  it('ignores a malformed key entry without throwing', async () => {
    // An entry whose key is missing or empty (e.g. it failed decryption) must be
    // skipped, not compared: Buffer.from(undefined) throws and would turn a valid
    // sibling key into a 500. preHandler already skips such entries, so both
    // lookups have to agree.
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      baseConfig({
        requireAuth: true,
        keys: [
          { id: 'broken', createdAt: 0 } as unknown as GatewayKeyEntry,
          { id: 'ok', key: KEY, createdAt: 0, modelAllowlist: ['custom:fx:fast'] },
        ],
      }),
      CATALOG,
      undefined,
      hooks,
    );

    const allowed = await chat(app, 'custom:fx:fast');
    assert.equal(allowed.statusCode, 200, 'the valid sibling key must still work');
    assert.deepEqual(hooks.dispatchLog, ['fx:fast']);

    const denied = await chat(app, 'custom:fx:plain');
    assert.equal(denied.statusCode, 403, 'the restriction must still apply');
  });
});

describe('failover stays inside the allowlist', () => {
  // The preHandler is not the only enforcement point: handlers switch models
  // AFTER it passes. These tests pin that both switch paths stay inside the list.
  //
  // `payload.model` is the composed id that actually served the request (set at
  // openai.ts:862 from `finalModel`, and no alias is configured here), so it is
  // the oracle. Asserting on status alone would miss the bug: the bypass returns
  // a 200.

  it('never fails over outside a single-model allowlist', async () => {
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await chat(app, 'custom:fx:fast');
    if (res.statusCode === 200) {
      // No legal fallback: the request may proceed to its own model...
      assert.equal(res.json().model, 'custom:fx:fast', '...but never to a different one');
    } else {
      assert.ok(
        [429, 502].includes(res.statusCode),
        `unexpected status ${res.statusCode} for a single-model allowlist`,
      );
    }
    assert.equal(
      (res.json() as { fmf_route_notices?: unknown[] }).fmf_route_notices,
      undefined,
      'no switch notice may be emitted',
    );
  });

  it('fails over only inside a multi-model allowlist', async () => {
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key(['custom:fx:fast', 'custom:fx:plain'])] }, [
        'openrouter:gpt-4o-mini',
      ]),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await chat(app, 'custom:fx:fast');
    assert.equal(res.statusCode, 200);
    const body = res.json() as { model?: string; fmf_route_notices?: Array<{ to: string }> };
    assert.equal(body.model, 'custom:fx:plain', 'the switch must land inside the allowlist');
    assert.ok(body.fmf_route_notices?.length, 'the switch must be announced');
    assert.equal(body.fmf_route_notices?.[0]?.to, 'custom:fx:plain');
    assert.deepEqual(hooks.dispatchLog, ['fx:plain']);
  });

  it('keeps the post-429 one-shot switch inside the allowlist', async () => {
    // No pre-request cooldown: preflight passes, the provider 429s, and the
    // explicit one-shot switch is what has to stay inside the list.
    const hooks = { dispatchLog: [] as string[], rateLimitOnce: 'fx:fast' };
    const app = await appWith(
      autoRouteConfig(
        { requireAuth: true, keys: [key(['custom:fx:fast', 'openrouter:gpt-4o-mini'])] },
        ['custom:fx:plain'],
      ),
      CATALOG,
      undefined,
      hooks,
    );

    const res = await chat(app, 'custom:fx:fast');
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.json().model,
      'openrouter:gpt-4o-mini',
      'must not fall through to custom:fx:plain, which is outside the allowlist',
    );
    assert.deepEqual(hooks.dispatchLog, ['fx:fast', 'gpt-4o-mini']);
  });

  it('still fails over for an unrestricted key', async () => {
    // Control case: no allowlist means the router is untouched.
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key()] }, ['custom:fx:plain']),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await chat(app, 'custom:fx:fast');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().model, 'custom:fx:plain');
    assert.deepEqual(hooks.dispatchLog, ['fx:plain']);
  });
});

describe('protocol coverage: the allowlist is enforced on every gateway route', () => {
  // The preHandler is shared, but each protocol carries its OWN wiring: its own
  // preflight, its own post-429 switch, and (for Gemini) its own model parse. A
  // handler that skips the check becomes fully unrestricted and still answers
  // 200, so every test below asserts WHICH model served rather than only the
  // status code. Gemini's response has no model field, so `hooks.dispatchLog` —
  // the bare id each faked provider was actually asked for — is the oracle there.

  it('enforces the allowlist on /v1/messages', async () => {
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }),
      CATALOG,
      undefined,
      hooks,
    );

    const denied = await anthropic(app, 'custom:fx:plain');
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'model_not_allowed');
    assert.deepEqual(hooks.dispatchLog, [], 'a denied model must never reach a provider');

    const allowed = await anthropic(app, 'custom:fx:fast');
    assert.equal(allowed.statusCode, 200);
    assert.equal(
      (allowed.json() as { model?: string }).model,
      'custom:fx:fast',
      'the served model must be the allowlisted one',
    );
    assert.deepEqual(hooks.dispatchLog, ['fx:fast']);
  });

  it('enforces the allowlist on both Gemini content routes', async () => {
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }),
      CATALOG,
      undefined,
      hooks,
    );

    for (const action of ['generateContent', 'streamGenerateContent'] as const) {
      const denied = await gemini(app, 'custom:fx:plain', action);
      assert.equal(denied.statusCode, 403, `${action} must be denied`);
      assert.equal(
        (denied.json() as { error: { code: string } }).error.code,
        'model_not_allowed',
        `${action} must be refused by the allowlist`,
      );
    }
    assert.deepEqual(hooks.dispatchLog, [], 'a denied model must never reach a provider');

    const allowed = await gemini(app, 'custom:fx:fast');
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(
      hooks.dispatchLog,
      ['fx:fast'],
      'the allowlisted model must be the one dispatched',
    );
  });

  it('matches a percent-encoded Gemini model id against the decoded allowlist', async () => {
    // On the wire this is /v1beta/models/custom%3A%40scope%2Fmodel:generateContent.
    // The preHandler decodes req.url, then the handler's lastIndexOf(':') parse
    // splits it — both must land on the same decoded id.
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      baseConfig({ requireAuth: true, keys: [key(['custom:@scope/model'])] }),
      CATALOG,
      undefined,
      hooks,
    );

    const allowed = await gemini(app, 'custom:@scope/model');
    assert.equal(allowed.statusCode, 200, 'the decoded id must match its allowlist entry');
    assert.deepEqual(hooks.dispatchLog, ['@scope/model'], 'the provider must receive the bare id');

    const denied = await gemini(app, 'custom:@scope/other');
    assert.equal(denied.statusCode, 403);
    assert.equal(
      (denied.json() as { error: { code: string } }).error.code,
      'model_not_allowed',
      'a decoded id outside the allowlist must be refused',
    );
  });

  it('refuses a malformed percent sequence instead of letting it through', async () => {
    // %2 is not a valid escape, so Fastify rejects the URL itself (400
    // FST_ERR_BAD_URL) before the preHandler runs — the request never reaches a
    // model, which is the fail-closed outcome that matters here. The
    // decodeURIComponent guard in extractGatewayModel is defense in depth for a
    // caller that bypasses that validation.
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      baseConfig({ requireAuth: true, keys: [key(['custom:fx:fast'])] }),
      CATALOG,
      undefined,
      hooks,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/a%2:generateContent',
      headers: KEY_HEADERS,
      payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });
    assert.equal(res.statusCode, 400, 'a non-decodable path must be rejected');
    assert.equal(res.json().code, 'FST_ERR_BAD_URL');
    assert.deepEqual(hooks.dispatchLog, [], 'the provider must never be called');
  });

  it('keeps a /v1/messages failover inside the allowlist', async () => {
    // Anthropic's analogue of the OpenAI failover test: preflight must not pick
    // the decoy that sits just outside the list.
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key(['custom:fx:fast', 'custom:fx:plain'])] }, [
        'openrouter:gpt-4o-mini',
      ]),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await anthropic(app, 'custom:fx:fast');
    assert.equal(res.statusCode, 200);
    assert.equal(
      (res.json() as { model?: string }).model,
      'custom:fx:plain',
      'the switch must land inside the allowlist, not on openrouter:gpt-4o-mini',
    );
    assert.deepEqual(hooks.dispatchLog, ['fx:plain']);
  });

  it('keeps a Gemini failover inside the allowlist', async () => {
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key(['custom:fx:fast', 'custom:fx:plain'])] }, [
        'openrouter:gpt-4o-mini',
      ]),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await gemini(app, 'custom:fx:fast');
    assert.equal(res.statusCode, 200);
    const notices = (res.json() as { fmf_route_notices?: Array<{ to: string }> }).fmf_route_notices;
    assert.ok(notices?.length, 'the switch must be announced');
    assert.equal(notices?.[0]?.to, 'custom:fx:plain');
    assert.deepEqual(hooks.dispatchLog, ['fx:plain']);
  });

  it('keeps a Gemini streaming failover inside the allowlist', async () => {
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key(['custom:fx:fast', 'custom:fx:plain'])] }, [
        'openrouter:gpt-4o-mini',
      ]),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await gemini(app, 'custom:fx:fast', 'streamGenerateContent');
    assert.equal(res.statusCode, 200);
    const notice = ssePayloads(res.body)
      .map((frame) => frame.fmf_route_notice)
      .find((n) => n);
    assert.equal(
      (notice as { to: string }).to,
      'custom:fx:plain',
      'the streamed switch must land inside the allowlist',
    );
    assert.deepEqual(hooks.dispatchLog, ['fx:plain']);
  });

  it('keeps an OpenAI streaming failover inside the allowlist', async () => {
    const hooks = { dispatchLog: [] as string[] };
    const app = await appWith(
      autoRouteConfig({ requireAuth: true, keys: [key(['custom:fx:fast', 'custom:fx:plain'])] }, [
        'openrouter:gpt-4o-mini',
      ]),
      CATALOG,
      coolDown('custom:fx:fast'),
      hooks,
    );

    const res = await chat(app, 'custom:fx:fast', { stream: true });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/event-stream/);
    const notice = ssePayloads(res.body)
      .map((frame) => frame.fmf_route_notice)
      .find((n) => n);
    assert.equal(
      (notice as { to: string }).to,
      'custom:fx:plain',
      'the streamed switch must land inside the allowlist',
    );
    assert.deepEqual(
      hooks.dispatchLog,
      ['fx:plain'],
      'the decoy outside the allowlist must never be dispatched',
    );
  });
});

describe('gateway API: managing a key model allowlist', () => {
  it('always reports an allowlist array, empty when unconfigured', async () => {
    const app = await appWithBaseline({ requireAuth: true, keys: [key()] });

    const res = await gatewayApi(app);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().keys[0]?.modelAllowlist, [], 'absent must read back as []');

    // A key whose allowlist was cleared is indistinguishable from an unconfigured one.
    const cleared = await gatewayApi(app, {
      action: 'update',
      id: 'k1',
      modelAllowlist: [],
    });
    assert.deepEqual(cleared.json().keys[0]?.modelAllowlist, []);
  });

  it('persists an allowlist when a key is created with one', async () => {
    const app = await appWithBaseline({ requireAuth: true, keys: [] });

    const created = await gatewayApi(app, {
      action: 'create',
      modelAllowlist: ['custom:fx:fast', 'custom:fx:plain'],
    });
    assert.equal(created.statusCode, 200);
    const entry = created.json().keys[0];
    assert.equal(entry?.modelAllowlist?.length, 2);

    // And it survives the round trip through disk: the GET reads the persisted config.
    const res = await gatewayApi(app);
    assert.deepEqual(
      res.json().keys[0]?.modelAllowlist,
      ['custom:fx:fast', 'custom:fx:plain'],
      'the persisted value must round-trip',
    );
  });

  it('drops invalid entries and de-duplicates on create', async () => {
    const app = await appWithBaseline({ requireAuth: true, keys: [] });

    const res = await gatewayApi(app, {
      action: 'create',
      modelAllowlist: ['custom:fx:fast', 42, '', '   ', null, 'custom:fx:fast', 'Custom:FX:Fast'],
    });
    assert.deepEqual(
      res.json().keys[0]?.modelAllowlist,
      ['custom:fx:fast'],
      'non-strings, blanks, and case duplicates must be removed',
    );

    const allInvalid = await gatewayApi(app, {
      action: 'create',
      modelAllowlist: [42, '', null],
    });
    assert.deepEqual(
      allInvalid.json().keys[1]?.modelAllowlist,
      [],
      'a wholly invalid list must mean unrestricted',
    );
  });

  it('enforces an allowlist that was written through the API', async () => {
    const app = await appWithBaseline({ requireAuth: true, keys: [] });

    const created = await gatewayApi(app, { action: 'create', modelAllowlist: ['custom:fx:fast'] });
    const id = created.json().keys[0]?.id;
    const newKey = created.json().keys[0]?.key;
    assert.ok(id && newKey, 'the create must return a usable id and key');

    // The API write must flow straight through to the enforcement path.
    const outside = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${newKey}` },
      payload: { model: 'custom:fx:plain', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(outside.statusCode, 403);
    assert.equal((outside.json() as { error: { code: string } }).error.code, 'model_not_allowed');

    const inside = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${newKey}` },
      payload: { model: 'custom:fx:fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(inside.statusCode, 200);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${newKey}` },
    });
    assert.deepEqual(
      (list.json() as { data: Array<{ id: string }> }).data.map((m) => m.id),
      ['fx:fast'],
      'only the allowed model is visible to the new key',
    );
  });

  it('updates a key allowlist, clears it with an empty array, and leaves it alone when omitted', async () => {
    const app = await appWithBaseline({
      requireAuth: true,
      keys: [key(['custom:fx:fast'])],
    });
    const get = async () => await gatewayApi(app);

    const initial = await get();
    assert.deepEqual(initial.json().keys[0]?.modelAllowlist, ['custom:fx:fast']);

    const updated = await gatewayApi(app, {
      action: 'update',
      id: 'k1',
      modelAllowlist: ['custom:fx:plain'],
    });
    assert.deepEqual(updated.json().keys[0]?.modelAllowlist, ['custom:fx:plain']);

    // Omitting the field must NOT clear it — the UI sends only what it edited.
    const untouched = await gatewayApi(app, { action: 'update', id: 'k1', label: 'renamed' });
    assert.deepEqual(untouched.json().keys[0]?.label, 'renamed');
    assert.deepEqual(
      untouched.json().keys[0]?.modelAllowlist,
      ['custom:fx:plain'],
      'an omitted allowlist must be left alone',
    );

    // An explicit [] clears it, which is how the UI lifts a restriction.
    const cleared = await gatewayApi(app, {
      action: 'update',
      id: 'k1',
      modelAllowlist: [],
    });
    assert.deepEqual(cleared.json().keys[0]?.modelAllowlist, []);

    // The restriction really is gone: the model that was refused now works.
    const previouslyDenied = await chat(app, 'custom:fx:plain');
    assert.equal(
      previouslyDenied.statusCode,
      200,
      'clearing the allowlist must lift the restriction',
    );

    // And it is gone from disk, not just from memory.
    assert.deepEqual((await get()).json().keys[0]?.modelAllowlist, []);
  });
});
