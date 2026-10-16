import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  SUBSCRIPTION_ADAPTERS,
  SubscriptionRefreshError,
  getCredentialRuntime,
  type AppConfig,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';

const localUiHeaders = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

type SubscriptionProviderId = 'codex' | 'claude' | 'google';
const PLATFORMS: SubscriptionProviderId[] = ['codex', 'claude', 'google'];
const originalCodexRefresh = SUBSCRIPTION_ADAPTERS.codex.refresh;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** 构造一个可被 codex parseImport 解析的 id_token（仅用于展示身份，不验签）。 */
function makeIdToken(): string {
  return `${b64url({ alg: 'none' })}.${b64url({
    email: 'ada@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-123',
      chatgpt_plan_type: 'plus',
    },
  })}.sig`;
}

function codexAuthJson(overrides: Record<string, string> = {}): string {
  return JSON.stringify({
    tokens: {
      access_token: 'AT_SECRET_PLAINTEXT',
      refresh_token: 'RT_SECRET_PLAINTEXT',
      id_token: makeIdToken(),
      account_id: 'acct-123',
      ...overrides,
    },
  });
}

function testConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {
      openrouter: { enabled: false },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

async function resetSubscriptionAccounts(): Promise<void> {
  const runtime = getCredentialRuntime();
  for (const platform of PLATFORMS) {
    const pool = await runtime.getPool(platform);
    for (const account of pool.accounts) {
      await runtime.removeAccount(platform, account.id);
    }
  }
}

function rawConfigPath(): string {
  return join(process.env.FREEMODELFINDER_HOME as string, 'config.json');
}

async function listAccounts(
  app: FastifyInstance,
): Promise<Array<{ provider: string; id: string; status: string; email?: string; plan?: string }>> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/subscription/accounts',
    headers: localUiHeaders,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().accounts;
}

describe('subscription account API', () => {
  let app: FastifyInstance;

  before(async () => {
    await resetSubscriptionAccounts();
    ({ app } = await createServer({
      registry: new ProviderRegistry(testConfig()),
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app.close();
    await resetSubscriptionAccounts();
  });

  beforeEach(async () => {
    await resetSubscriptionAccounts();
  });

  afterEach(() => {
    SUBSCRIPTION_ADAPTERS.codex.refresh = originalCodexRefresh;
  });

  it('imports a codex account via raw and persists it encrypted at rest', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/import',
      headers: localUiHeaders,
      payload: { provider: 'codex', raw: codexAuthJson() },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.account.provider, 'codex');
    assert.equal(body.account.id, 'acct-123');
    assert.equal(body.account.email, 'ada@example.com');
    assert.equal(body.account.plan, 'plus');

    const accounts = await listAccounts(app);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.status, 'active');
    assert.equal(accounts[0]?.email, 'ada@example.com');

    // Review Focus #4：原始 config.json 不得出现明文 refresh/access token。
    const rawConfig = await readFile(rawConfigPath(), 'utf8');
    assert.ok(!rawConfig.includes('RT_SECRET_PLAINTEXT'), 'refresh token leaked in plaintext');
    assert.ok(!rawConfig.includes('AT_SECRET_PLAINTEXT'), 'access token leaked in plaintext');
  });

  // 导入只是把账号写进凭据池，而 getProvider 的第一道闸门是 config.providers.<id>.enabled
  // （store.ts 里三家默认都是 false）。没有任何代码路径会把它置 true —— 于是"导入成功"之后
  // /v1/models 不列出订阅模型、auto 选不到、显式 codex:… 抛 "provider codex is not enabled"。
  it('enables the provider on a successful import so the account is actually usable', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/import',
      headers: localUiHeaders,
      payload: { provider: 'codex', raw: codexAuthJson() },
    });
    assert.equal(response.statusCode, 200, response.body);

    const config = JSON.parse(await readFile(rawConfigPath(), 'utf8')) as {
      providers: Record<string, { enabled?: boolean } | undefined>;
    };
    assert.equal(config.providers.codex?.enabled, true);
  });

  it('rejects malformed JSON with a provider-scoped 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/import',
      headers: localUiHeaders,
      payload: { provider: 'codex', raw: 'not-json{' },
    });
    assert.equal(response.statusCode, 400);
    assert.ok(response.body.includes('codex'), response.body);
    assert.equal((await listAccounts(app)).length, 0);
  });

  it('requires exactly one of raw or path', async () => {
    const neither = await app.inject({
      method: 'POST',
      url: '/api/subscription/import',
      headers: localUiHeaders,
      payload: { provider: 'codex' },
    });
    assert.equal(neither.statusCode, 400);

    const both = await app.inject({
      method: 'POST',
      url: '/api/subscription/import',
      headers: localUiHeaders,
      payload: { provider: 'codex', raw: codexAuthJson(), path: '~/.codex/auth.json' },
    });
    assert.equal(both.statusCode, 400);
  });

  it('rejects an unknown provider', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/import',
      headers: localUiHeaders,
      payload: { provider: 'nope', raw: '{}' },
    });
    assert.equal(response.statusCode, 400);
    assert.ok(response.body.includes('unknown provider'), response.body);
  });

  it('rejects a path outside the whitelist and path traversal', async () => {
    for (const path of [
      'C:\\Windows\\win.ini',
      '/etc/passwd',
      '~/.codex/../../secret',
      '~/.ssh/id_rsa',
      '~/.codexfoo/auth.json',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/subscription/import',
        headers: localUiHeaders,
        payload: { provider: 'codex', path },
      });
      assert.equal(response.statusCode, 400, `${path} -> ${response.body}`);
    }
    assert.equal((await listAccounts(app)).length, 0);
  });

  it('rejects a google import whose oauth_creds.json lacks client_secret', async () => {
    // Task 8 已接入真实 google 适配器：不再有 501 分支，导入错误统一走 provider 作用域 400
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/import',
      headers: localUiHeaders,
      payload: {
        provider: 'google',
        raw: JSON.stringify({ refresh_token: 'RT', client_id: 'CID' }),
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.ok(response.body.includes('client_secret'), response.body);
  });

  it('serves import hints for the three subscription providers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscription/import-hints',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200);
    const hints = response.json();
    assert.equal(hints.length, 3);
    assert.deepEqual(hints.map((h: { provider: string }) => h.provider).sort(), [
      'claude',
      'codex',
      'google',
    ]);
    const codex = hints.find((h: { provider: string }) => h.provider === 'codex');
    assert.equal(codex.path, '~/.codex/auth.json');
  });

  it('deletes an account', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/subscription/import',
      headers: localUiHeaders,
      payload: { provider: 'codex', raw: codexAuthJson() },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/subscription/accounts/codex/acct-123',
      headers: localUiHeaders,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().ok, true);
    assert.equal((await listAccounts(app)).length, 0);
  });

  it('404s a delete of an unknown account', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/subscription/accounts/codex/missing',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 404);
  });

  it('refreshes an account and persists the rotated payload', async () => {
    await getCredentialRuntime().upsertAccount('codex', {
      id: 'acct-refresh',
      label: 'ada@example.com',
      status: 'active',
      addedAt: Date.now(),
      payload: { refreshToken: 'RT_OLD', accessToken: 'AT_OLD', accountId: 'acct-refresh' },
    });

    SUBSCRIPTION_ADAPTERS.codex.refresh = async ({ payload }) => ({
      payload: { ...payload, accessToken: 'AT_NEW', refreshToken: 'RT_NEW' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/accounts/codex/acct-refresh/refresh',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ok, true);

    const pool = await getCredentialRuntime().getPool('codex');
    const stored = pool.accounts.find((entry) => entry.id === 'acct-refresh');
    assert.equal(stored?.payload.refreshToken, 'RT_NEW');
    assert.equal(stored?.status, 'active');
  });

  it('marks the account invalid on a fatal refresh error', async () => {
    await getCredentialRuntime().upsertAccount('codex', {
      id: 'acct-fatal',
      status: 'active',
      addedAt: Date.now(),
      payload: { refreshToken: 'RT_FATAL' },
    });

    SUBSCRIPTION_ADAPTERS.codex.refresh = async () => {
      throw new SubscriptionRefreshError('codex: token refresh failed 400: invalid_grant', {
        kind: 'fatal',
        status: 400,
      });
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/accounts/codex/acct-fatal/refresh',
      headers: localUiHeaders,
    });
    assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);

    const pool = await getCredentialRuntime().getPool('codex');
    const stored = pool.accounts.find((entry) => entry.id === 'acct-fatal');
    assert.equal(stored?.status, 'invalid');
  });

  // 手动刷新接口若不用单飞锁，就会与 provider 内部的自动刷新并发改发同一个 refresh token。
  // 轮换型 OAuth（Codex 必轮换）下第二次会被上游判为 refresh_token_reused / invalid_grant，
  // 账号直接报废 —— 而用户恰恰是在出问题、有流量时才去点"刷新"。
  it('collapses concurrent refreshes into a single upstream token call', async () => {
    await getCredentialRuntime().upsertAccount('codex', {
      id: 'acct-flight',
      status: 'active',
      addedAt: Date.now(),
      label: 'flight@example.com',
      payload: { refreshToken: 'RT_OLD', accessToken: 'AT_OLD', accountId: 'acct-flight' },
    });

    let calls = 0;
    let markFirst!: () => void;
    const firstReached = new Promise<void>((resolve) => {
      markFirst = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    SUBSCRIPTION_ADAPTERS.codex.refresh = async ({ payload }) => {
      calls += 1;
      markFirst();
      await gate;
      return { payload: { ...payload, accessToken: 'AT_NEW', refreshToken: 'RT_NEW' } };
    };

    const first = app.inject({
      method: 'POST',
      url: '/api/subscription/accounts/codex/acct-flight/refresh',
      headers: localUiHeaders,
    });
    await firstReached;
    const second = app.inject({
      method: 'POST',
      url: '/api/subscription/accounts/codex/acct-flight/refresh',
      headers: localUiHeaders,
    });
    // 第一个请求此刻正卡在上游往返中；给第二个请求足够时间走到单飞锁。
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(calls, 1, 'concurrent refreshes must share one upstream token call');
  });

  it('returns 502 for a non-fatal refresh error', async () => {
    await getCredentialRuntime().upsertAccount('codex', {
      id: 'acct-transient',
      status: 'active',
      addedAt: Date.now(),
      payload: { refreshToken: 'RT_TRANSIENT' },
    });

    SUBSCRIPTION_ADAPTERS.codex.refresh = async () => {
      throw new SubscriptionRefreshError('codex: token refresh network error: boom', {
        kind: 'network',
      });
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/accounts/codex/acct-transient/refresh',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 502);
  });

  it('404s a refresh of an unknown account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/accounts/codex/missing/refresh',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 404);
  });
});
