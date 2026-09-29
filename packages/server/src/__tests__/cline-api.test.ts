import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  __resetCatalogCacheForTests,
  createTestRuntime,
  getCredentialRuntime,
  type AppConfig,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { CLINE_MAX_FLOWS, createServer, createServerRuntime } from '../server.js';

const localUiHeaders = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

const DEVICE_URL = 'https://api.workos.com/user_management/authorize/device';
const AUTH_URL = 'https://api.workos.com/user_management/authenticate';
const REGISTER_URL = 'https://api.cline.bot/api/v1/auth/register';
const CATALOG_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models';

const COLD_ACCOUNT_ID = 'acc-cold';
const LIST_ACCOUNT_ID = 'acc-list';
const REDACT_ACCOUNT_ID = 'acc-redact';

type Scenario =
  'approve' | 'expired' | 'denied' | 'start-fails' | 'zero-ttl' | 'no-email' | 'legacy';

let scenario: Scenario = 'approve';
let authPolls = 0;
let catalogFetches = 0;
const passthroughUrls: string[] = [];
let realFetch: typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function testConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {
      cline: { enabled: true },
      openrouter: { enabled: false, credentials: { apiKey: 'openrouter-key' } },
      gemini: { enabled: false },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

function installUpstreamStub(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === DEVICE_URL) {
      if (scenario === 'start-fails') {
        return new Response('Bearer sk-leaked-token', { status: 500 });
      }
      return json({
        device_code: 'device-code-1',
        user_code: 'ABCD-EFGH',
        verification_uri_complete: 'https://webos.example/activate?user_code=ABCD-EFGH',
        interval: 0,
        expires_in: scenario === 'zero-ttl' ? 0 : 300,
      });
    }
    if (url === AUTH_URL) {
      authPolls += 1;
      if (scenario === 'expired') return json({ error: 'expired_token' }, 400);
      if (scenario === 'denied') return json({ error: 'access_denied' }, 400);
      if (authPolls === 1) return json({ error: 'authorization_pending' }, 400);
      return json({ access_token: 'workos-access', refresh_token: 'workos-refresh' });
    }
    if (url === REGISTER_URL) {
      if (scenario === 'legacy') return json({ data: { refreshToken: 'rt-legacy-value' } });
      if (scenario === 'no-email') return json({ data: { refreshToken: 'rt-no-email-value' } });
      return json({
        data: { refreshToken: 'rt-secret-value', userInfo: { email: 'ada@example.com' } },
      });
    }
    if (url === CATALOG_URL) {
      catalogFetches += 1;
      return json({
        free: [{ id: 'test-free/model', name: 'Test Free', context_length: 4096 }],
      });
    }
    passthroughUrls.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
}

async function resetAccounts(): Promise<void> {
  const runtime = getCredentialRuntime();
  const pool = await runtime.getPool('cline');
  for (const account of pool.accounts) {
    await runtime.removeAccount('cline', account.id);
  }
}

async function seedAccount(id: string): Promise<void> {
  await getCredentialRuntime().upsertAccount('cline', {
    id,
    label: 'ada@example.com',
    status: 'active',
    addedAt: Date.now() - 5_000,
    payload: {
      refreshToken: 'rt-secret-value',
      originToken: 'rt-secret-value',
      email: 'ada@example.com',
    },
  });
}

async function completeLogin(app: FastifyInstance): Promise<string> {
  const flowId = String((await startLogin(app)).flowId);
  let state = await pollLogin(app, flowId);
  if (state.status !== 'complete') state = await pollLogin(app, flowId);
  assert.equal(state.status, 'complete');
  return flowId;
}

async function startLogin(app: FastifyInstance): Promise<Record<string, string | number>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/cline/login/start',
    headers: localUiHeaders,
  });
  assert.equal(response.statusCode, 200);
  return response.json() as Record<string, string | number>;
}

async function pollLogin(
  app: FastifyInstance,
  flowId: string,
): Promise<{ status: string; account?: { id: string; label: string; status: string } }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/cline/login/poll',
    headers: localUiHeaders,
    payload: { flowId },
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

before(() => {
  installUpstreamStub();
});

after(() => {
  globalThis.fetch = realFetch;
});

describe('cline startup warm-up', () => {
  let app: FastifyInstance;
  let registry: ProviderRegistry;
  let originalWarm: typeof ProviderRegistry.prototype.warmCredentials;
  let warmCalls = 0;
  let warmResolvedAtReturn = false;

  before(async () => {
    const seedRuntime = createTestRuntime({ throttleMs: 60_000 });
    await seedRuntime.upsertAccount('cline', {
      id: COLD_ACCOUNT_ID,
      label: 'cold@example.com',
      status: 'active',
      addedAt: Date.now() - 5_000,
      payload: { refreshToken: 'rt-cold-value' },
    });
    await seedRuntime.waitForPersist();

    warmCalls = 0;
    let resolved = false;
    originalWarm = ProviderRegistry.prototype.warmCredentials;
    ProviderRegistry.prototype.warmCredentials = async function (
      this: ProviderRegistry,
    ): Promise<void> {
      warmCalls += 1;
      const result = await originalWarm.call(this);
      resolved = true;
      return result;
    };
    registry = new ProviderRegistry(testConfig());
    const server = await createServer({
      registry,
      watchIntervalMs: 60 * 60 * 1000,
    });
    warmResolvedAtReturn = resolved;
    app = server.app;
  });

  after(async () => {
    ProviderRegistry.prototype.warmCredentials = originalWarm;
    await app.close();
    await resetAccounts();
  });

  it('awaits credential warm-up before the server comes up', () => {
    assert.ok(warmCalls >= 1, `expected warmCredentials to run, got ${warmCalls}`);
    assert.equal(warmResolvedAtReturn, true);
  });

  it('answers hasKey from the warmed pool on a cold start', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().providers.cline.hasKey, true);
  });

  it('serves the cline catalog through the local upstream stub', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(response.statusCode, 200);

    __resetCatalogCacheForTests();
    const before = catalogFetches;
    await registry.listAllModels(true);
    assert.ok(
      catalogFetches > before,
      `expected a fresh catalog fetch through the stub, got ${catalogFetches} (before ${before})`,
    );
    assert.equal(
      passthroughUrls.filter((url) => url.includes('api.cline.bot')).length,
      0,
      passthroughUrls.join(','),
    );
  });

  it('warms again when the provider registry is rebuilt', async () => {
    const before = warmCalls;
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'cline', enabled: true },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(warmCalls > before, 'expected warmCredentials after a registry rebuild');
  });

  it('awaits credential warm-up on the split admin/gateway runtime', async () => {
    let resolved = false;
    ProviderRegistry.prototype.warmCredentials = async function (
      this: ProviderRegistry,
    ): Promise<void> {
      const result = await originalWarm.call(this);
      resolved = true;
      return result;
    };
    const runtime = await createServerRuntime({
      mode: 'server',
      adminOrigin: 'https://admin.example',
      publicUrl: 'https://gateway.example',
      registry: new ProviderRegistry(testConfig()),
      watchIntervalMs: 60 * 60 * 1000,
    });
    try {
      assert.equal(resolved, true);
    } finally {
      ProviderRegistry.prototype.warmCredentials = originalWarm;
      await runtime.close();
    }
  });
});

describe('cline device login API', () => {
  let app: FastifyInstance;

  before(async () => {
    await resetAccounts();
    ({ app } = await createServer({
      registry: new ProviderRegistry(testConfig()),
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app.close();
    await resetAccounts();
  });

  beforeEach(() => {
    scenario = 'approve';
    authPolls = 0;
  });

  it('keeps the login routes behind the local UI gate', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/cline/accounts/acc-1/logout',
    });
    assert.equal(anonymous.statusCode, 403);

    const remote = await app.inject({
      method: 'POST',
      url: '/api/cline/accounts/acc-1/logout',
      headers: localUiHeaders,
      remoteAddress: '192.0.2.10',
    });
    assert.equal(remote.statusCode, 403);
  });

  it('walks the device login flow into a stored account', async () => {
    const started = await startLogin(app);
    assert.equal(typeof started.flowId, 'string');
    assert.equal(started.code, 'ABCD-EFGH');
    assert.equal(started.userUrl, 'https://webos.example/activate?user_code=ABCD-EFGH');
    assert.ok(Number(started.expiresAt) > Date.now());

    const flowId = String(started.flowId);
    const pending = await pollLogin(app, flowId);
    assert.equal(pending.status, 'pending');
    assert.equal(authPolls, 1);

    const complete = await pollLogin(app, flowId);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.account?.label, 'ada@example.com');
    assert.equal(complete.account?.status, 'active');
    assert.equal(typeof complete.account?.id, 'string');

    const repeat = await pollLogin(app, flowId);
    assert.equal(repeat.status, 'complete');
    assert.equal(repeat.account?.id, complete.account?.id);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().accounts.length, 1);
    assert.ok(!listed.body.includes('refreshToken'));
    assert.ok(!listed.body.includes('rt-secret-value'));
    assert.ok(!listed.body.includes('workos-refresh'));
  });

  it('reuses the stored account when the same login runs twice', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    const existing = before.json().accounts;

    const flowId = String((await startLogin(app)).flowId);
    let completed = await pollLogin(app, flowId);
    if (completed.status !== 'complete') completed = await pollLogin(app, flowId);
    assert.equal(completed.status, 'complete');

    const after = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    const accounts = after.json().accounts;
    assert.equal(accounts.length, existing.length);
    assert.deepEqual(
      accounts.map((account: { id: string }) => account.id),
      existing.map((account: { id: string }) => account.id),
    );
  });

  it('reuses the account after a refresh rotation and a repeat login', async () => {
    await resetAccounts();
    await seedAccount('acc-rotation');
    const runtime = getCredentialRuntime();
    const listed = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    const seeded = listed
      .json()
      .accounts.find((entry: { label: string }) => entry.label === 'ada@example.com');
    assert.ok(seeded, listed.body);

    const pool = await runtime.getPool('cline');
    const stored = pool.accounts.find((entry) => entry.id === seeded.id);
    assert.ok(stored);
    await runtime.upsertAccount('cline', {
      ...stored,
      payload: { ...stored.payload, refreshToken: 'rt-rotated-value' },
    });

    assert.ok(await completeLogin(app));

    const after = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    const accounts = after.json().accounts;
    assert.equal(
      accounts.filter((entry: { label: string }) => entry.label === 'ada@example.com').length,
      1,
    );

    const finalPool = await runtime.getPool('cline');
    const kept = finalPool.accounts.find((entry) => entry.id === seeded.id);
    assert.ok(kept);
    assert.equal(kept.payload.refreshToken, 'rt-rotated-value');
    assert.equal(kept.payload.originToken, 'rt-secret-value');
  });

  it('matches accounts stored without an originToken by their refreshToken', async () => {
    await resetAccounts();
    const runtime = getCredentialRuntime();
    const listed = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    const before = listed.json().accounts.length;
    await runtime.upsertAccount('cline', {
      id: 'acc-legacy',
      label: 'legacy@example.com',
      status: 'active',
      addedAt: Date.now(),
      payload: { refreshToken: 'rt-legacy-value' },
    });

    scenario = 'legacy';
    assert.ok(await completeLogin(app));
    scenario = 'approve';

    const after = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    const accounts = after.json().accounts;
    assert.equal(accounts.length, before + 1);
    const reused = accounts.find((entry: { id: string }) => entry.id === 'acc-legacy');
    assert.ok(reused, after.body);
    assert.equal(reused.label, 'legacy@example.com');

    const pool = await runtime.getPool('cline');
    const stored = pool.accounts.find((entry) => entry.id === 'acc-legacy');
    assert.ok(stored);
    assert.equal(stored.payload.refreshToken, 'rt-legacy-value');
    assert.equal(stored.payload.originToken, 'rt-legacy-value');
  });

  it('maps expired and denied upstream states', async () => {
    scenario = 'expired';
    const expired = await pollLogin(app, String((await startLogin(app)).flowId));
    assert.equal(expired.status, 'expired');

    scenario = 'denied';
    const denied = await pollLogin(app, String((await startLogin(app)).flowId));
    assert.equal(denied.status, 'denied');

    scenario = 'zero-ttl';
    const timedOut = await pollLogin(app, String((await startLogin(app)).flowId));
    assert.equal(timedOut.status, 'expired');

    scenario = 'approve';
    const unknown = await pollLogin(app, 'no-such-flow');
    assert.equal(unknown.status, 'expired');
  });

  it('requires a flow id when polling', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cline/login/poll',
      headers: localUiHeaders,
      payload: {},
    });
    assert.equal(response.statusCode, 400);
  });

  it('redacts upstream secrets from login errors', async () => {
    scenario = 'start-fails';
    const response = await app.inject({
      method: 'POST',
      url: '/api/cline/login/start',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 502);
    assert.ok(response.body.includes('[REDACTED]'), response.body);
    assert.ok(!response.body.includes('sk-leaked-token'));
    scenario = 'approve';
  });

  it('bounds the live flow table when login start is spammed', async () => {
    let firstId = '';
    let lastId = '';
    for (let index = 0; index <= CLINE_MAX_FLOWS; index += 1) {
      const flowId = String((await startLogin(app)).flowId);
      if (index === 0) firstId = flowId;
      lastId = flowId;
    }
    assert.ok(firstId);
    const evicted = await pollLogin(app, firstId);
    assert.equal(evicted.status, 'expired');
    const live = await pollLogin(app, lastId);
    assert.equal(live.status, 'pending');
  });

  it('bounds finished logins so completed flows stop accumulating', async () => {
    const tracked = await completeLogin(app);
    let evicted = false;
    for (let index = 0; index <= CLINE_MAX_FLOWS && !evicted; index += 1) {
      await completeLogin(app);
      const repeat = await pollLogin(app, tracked);
      evicted = repeat.status !== 'complete';
    }
    assert.equal(evicted, true);
  });

  it('persists a completed login once when polls arrive together', async () => {
    const flowId = String((await startLogin(app)).flowId);
    const first = await pollLogin(app, flowId);
    assert.equal(first.status, 'pending');

    const [a, b] = await Promise.all([pollLogin(app, flowId), pollLogin(app, flowId)]);
    assert.equal(a.status, 'complete');
    assert.equal(b.status, 'complete');
    assert.equal(a.account?.id, b.account?.id);

    const repeat = await pollLogin(app, flowId);
    assert.equal(repeat.status, 'complete');
    assert.equal(repeat.account?.id, a.account?.id);
  });

  it('falls back to a generated label when the upstream sends no email', async () => {
    scenario = 'no-email';
    const flowId = await completeLogin(app);
    assert.ok(flowId);
    scenario = 'approve';

    const listed = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    const account = listed
      .json()
      .accounts.find((entry: { label: string }) => entry.label.startsWith('Cline 账号 '));
    assert.ok(account, listed.body);
    assert.equal(account.label, `Cline 账号 ${account.id.slice(0, 8)}`);
  });
});

describe('cline accounts API', () => {
  let app: FastifyInstance;

  before(async () => {
    await resetAccounts();
    await seedAccount(LIST_ACCOUNT_ID);
    const runtime = getCredentialRuntime();
    runtime.reportSuccess('cline', LIST_ACCOUNT_ID);
    runtime.reportRateLimit(
      'cline',
      LIST_ACCOUNT_ID,
      'deepseek/deepseek-v4-flash',
      Date.now() + 60_000,
    );
    runtime.recordUsage('cline', LIST_ACCOUNT_ID, 'deepseek/deepseek-v4-flash', {
      requests: 2,
      promptTokens: 10,
      completionTokens: 5,
    });
    runtime.recordUsage('cline', LIST_ACCOUNT_ID, 'deepseek/deepseek-v4-flash', {
      requests: 1,
      error: 'upstream refused Bearer leak-token',
    });
    ({ app } = await createServer({
      registry: new ProviderRegistry(testConfig()),
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app.close();
    await resetAccounts();
  });

  it('aggregates cooldowns and usage without echoing credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes('refreshToken'));
    assert.ok(!response.body.includes('originToken'));
    assert.ok(!response.body.includes('rt-secret-value'));

    const account = response.json().accounts[0];
    assert.equal(account.id, LIST_ACCOUNT_ID);
    assert.equal(account.label, 'ada@example.com');
    assert.equal(account.status, 'active');
    assert.equal(typeof account.addedAt, 'number');
    assert.equal(typeof account.lastUsedAt, 'number');
    assert.equal(account.cooldowns.length, 1);
    assert.equal(account.cooldowns[0].model, 'deepseek/deepseek-v4-flash');
    assert.ok(account.cooldowns[0].resetAt > Date.now());
    assert.equal(account.usage.requests, 3);
    assert.equal(account.usage.promptTokens, 10);
    assert.equal(account.usage.completionTokens, 5);
    assert.ok(account.usage.lastError.includes('[REDACTED]'));
    assert.ok(!account.usage.lastError.includes('leak-token'));
  });

  it('clears the cooldowns of a single account', async () => {
    const cleared = await app.inject({
      method: 'POST',
      url: `/api/cline/accounts/${LIST_ACCOUNT_ID}/cooldowns/clear`,
      headers: localUiHeaders,
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().cleared, 1);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    assert.equal(listed.json().accounts[0].cooldowns.length, 0);
  });

  it('logs out an account', async () => {
    const loggedOut = await app.inject({
      method: 'POST',
      url: `/api/cline/accounts/${LIST_ACCOUNT_ID}/logout`,
      headers: localUiHeaders,
    });
    assert.equal(loggedOut.statusCode, 200);
    assert.equal(loggedOut.json().ok, true);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    assert.equal(listed.json().accounts.length, 0);
  });

  it('labels accounts that were stored without one', async () => {
    await getCredentialRuntime().upsertAccount('cline', {
      id: 'acc-without-label',
      status: 'active',
      addedAt: Date.now(),
      payload: { refreshToken: 'rt-no-label-value' },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/cline/accounts',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    const account = response.json().accounts[0];
    assert.ok(account);
    assert.equal(account.label, `Cline 账号 ${account.id.slice(0, 8)}`);
    await resetAccounts();
  });
});

describe('cline hasKey seam', () => {
  let app: FastifyInstance;
  let registry: ProviderRegistry;

  before(async () => {
    await resetAccounts();
    registry = new ProviderRegistry(testConfig());
    ({ app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 }));
  });

  after(async () => {
    await app.close();
    await resetAccounts();
  });

  async function hasKey(provider: string): Promise<boolean> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    return response.json().providers[provider].hasKey as boolean;
  }

  it('reports cline as unkeyed while the pool has no active account', async () => {
    assert.equal(await hasKey('cline'), false);
  });

  it('reports cline as keyed once an active account exists', async () => {
    await seedAccount('acc-haskey');
    assert.equal(await hasKey('cline'), true);
  });

  it('reports cline as unkeyed when the provider is disabled', async () => {
    const current = registry.getConfig();
    registry.updateConfig({
      ...current,
      providers: { ...current.providers, cline: { enabled: false } },
    });
    assert.equal(await hasKey('cline'), false);
    registry.updateConfig({
      ...current,
      providers: { ...current.providers, cline: { enabled: true } },
    });
    assert.equal(await hasKey('cline'), true);
  });

  it('keeps the apiKey based hasKey behaviour of other providers', async () => {
    assert.equal(await hasKey('openrouter'), true);
    assert.equal(await hasKey('gemini'), false);
  });
});

describe('cline dynamicModels persistence', () => {
  let app: FastifyInstance;

  before(async () => {
    await resetAccounts();
    ({ app } = await createServer({
      registry: new ProviderRegistry(testConfig()),
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app.close();
    await resetAccounts();
  });

  async function echoDynamicModels(): Promise<unknown> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    return response.json().providers.cline.dynamicModels;
  }

  async function postProvider(payload: Record<string, unknown>): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  it('echoes dynamicModels as enabled when the stored config omits it', async () => {
    assert.equal(await echoDynamicModels(), true);
  });

  it('persists a stored dynamicModels false and echoes it back', async () => {
    await postProvider({ provider: 'cline', dynamicModels: false });
    assert.equal(await echoDynamicModels(), false);
    await postProvider({ provider: 'cline', dynamicModels: true });
    assert.equal(await echoDynamicModels(), true);
  });

  it('keeps dynamicModels when a later POST omits the field', async () => {
    await postProvider({ provider: 'cline', dynamicModels: false });
    await postProvider({ provider: 'cline', enabled: true });
    assert.equal(await echoDynamicModels(), false);
    await postProvider({ provider: 'cline', apiKeys: ['sk-test-value'] });
    assert.equal(await echoDynamicModels(), false);
  });

  it('keeps dynamicModels across a clearCredentials POST', async () => {
    await postProvider({ provider: 'cline', dynamicModels: false });
    await postProvider({ provider: 'cline', clearCredentials: true });
    assert.equal(await echoDynamicModels(), false);

    await postProvider({ provider: 'cline', dynamicModels: false });
    await postProvider({ provider: 'cline', clearCredentials: true, dynamicModels: true });
    assert.equal(await echoDynamicModels(), true);
  });
});

describe('config credential redaction', () => {
  let app: FastifyInstance;

  before(async () => {
    await resetAccounts();
    await seedAccount(REDACT_ACCOUNT_ID);
    const config = testConfig();
    ({ app } = await createServer({
      registry: new ProviderRegistry({
        ...config,
        credentials: {
          cline: {
            accounts: [
              {
                id: REDACT_ACCOUNT_ID,
                label: 'ada@example.com',
                status: 'active',
                addedAt: Date.now() - 5_000,
                payload: {
                  refreshToken: 'rt-registry-value',
                  originToken: 'ot-registry-value',
                },
              },
            ],
          },
        },
      }),
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app.close();
    await resetAccounts();
  });

  function assertNoCredentialEcho(response: { body: string }): void {
    assert.ok(!response.body.includes('refreshToken'), response.body);
    assert.ok(!response.body.includes('originToken'), response.body);
    assert.ok(!response.body.includes('"credentials"'), response.body);
    assert.ok(!response.body.includes('rt-secret-value'), response.body);
    assert.ok(!response.body.includes('rt-registry-value'), response.body);
    assert.ok(!response.body.includes('ot-registry-value'), response.body);
    assert.ok(!response.body.includes('openrouter-key'), response.body);
  }

  it('keeps the credentials payload out of GET /api/config', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.providers.cline.hasKey, true);
    assert.equal(body.providers.openrouter.hasKey, true);
    assert.equal(body.custom.sources.length, 0);
    assertNoCredentialEcho(response);
  });

  it('keeps the credentials payload out of the management write response', async () => {
    const written = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'cline', enabled: true },
    });
    assert.equal(written.statusCode, 200);
    assertNoCredentialEcho(written);

    const response = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().providers.cline.hasKey, true);
    assertNoCredentialEcho(response);
  });
});
