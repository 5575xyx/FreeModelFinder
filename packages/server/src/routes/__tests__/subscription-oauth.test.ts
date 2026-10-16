import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  SUBSCRIPTION_ADAPTERS,
  getCredentialRuntime,
  startLoopbackListener,
  type AppConfig,
  type LoopbackCallback,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';

const localUiHeaders = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

type SubscriptionProviderId = 'codex' | 'claude' | 'google';
const PLATFORMS: SubscriptionProviderId[] = ['codex', 'claude', 'google'];

const originalExchange = {
  codex: SUBSCRIPTION_ADAPTERS.codex.exchangeCode,
  claude: SUBSCRIPTION_ADAPTERS.claude.exchangeCode,
  google: SUBSCRIPTION_ADAPTERS.google.exchangeCode,
};

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function codexAuthJson(): string {
  return JSON.stringify({
    tokens: {
      access_token: 'AT',
      refresh_token: 'RT',
      id_token: `${b64url({ alg: 'none' })}.${b64url({
        email: 'ada@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct-import',
          chatgpt_plan_type: 'plus',
        },
      })}.sig`,
      account_id: 'acct-import',
    },
  });
}

function testConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: { openrouter: { enabled: false } },
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

/** 探针：exchangeCode 被调用时记录，未被调用则为 0。 */
let exchangeCalls = 0;
/** 每个测试自己创建的 pending 会话，afterEach 统一取消以释放端口。 */
let liveStates: string[] = [];

describe('subscription OAuth endpoints', () => {
  let app: FastifyInstance;
  let registry: ProviderRegistry;

  before(async () => {
    await resetSubscriptionAccounts();
    registry = new ProviderRegistry(testConfig());
    ({ app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 }));
  });

  after(async () => {
    await app.close();
    await resetSubscriptionAccounts();
  });

  beforeEach(async () => {
    await resetSubscriptionAccounts();
    exchangeCalls = 0;
    liveStates = [];
    SUBSCRIPTION_ADAPTERS.codex.exchangeCode = async () => {
      exchangeCalls += 1;
      throw new Error('exchangeCode stub not configured');
    };
    SUBSCRIPTION_ADAPTERS.claude.exchangeCode = async () => {
      exchangeCalls += 1;
      throw new Error('exchangeCode stub not configured');
    };
  });

  afterEach(async () => {
    for (const state of liveStates) {
      await app.inject({
        method: 'DELETE',
        url: `/api/subscription/oauth/session?state=${state}`,
        headers: localUiHeaders,
      });
    }
    liveStates = [];
    SUBSCRIPTION_ADAPTERS.codex.exchangeCode = originalExchange.codex;
    SUBSCRIPTION_ADAPTERS.claude.exchangeCode = originalExchange.claude;
    SUBSCRIPTION_ADAPTERS.google.exchangeCode = originalExchange.google;
  });

  async function beginOAuth(provider: string): Promise<{
    state: string;
    url: string;
    redirectUri: string;
  }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/subscription/oauth/auth-url?provider=${provider}`,
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { status: string; url: string; state: string };
    assert.equal(body.status, 'ok');
    liveStates.push(body.state);
    const parsed = new URL(body.url);
    return {
      state: body.state,
      url: body.url,
      redirectUri: parsed.searchParams.get('redirect_uri') ?? '',
    };
  }

  async function statusOf(state: string): Promise<{ status: string; error?: string }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/subscription/oauth/status?state=${state}`,
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }

  /** 轮询到目标状态；loopback 回调与换 token 都是异步的。 */
  async function waitForStatus(
    state: string,
    expected: 'ok' | 'error',
  ): Promise<{ status: string; error?: string }> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const record = await statusOf(state);
      if (record.status === expected) return record;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`session ${state} never reached ${expected}`);
  }

  it('auth-url returns a url and state and marks the session waiting', async () => {
    const { state, url, redirectUri } = await beginOAuth('codex');
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    const parsed = new URL(url);
    assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://auth.openai.com/oauth/authorize');
    assert.equal(parsed.searchParams.get('state'), state);
    assert.equal(parsed.searchParams.get('redirect_uri'), redirectUri);
    // redirect_uri 的主机名必须是 localhost（上游做精确匹配）
    assert.equal(redirectUri, 'http://localhost:1455/auth/callback');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.equal((await statusOf(state)).status, 'wait');
  });

  it('auth-url accepts antigravity as an alias for google', async () => {
    const { url, redirectUri } = await beginOAuth('antigravity');
    const parsed = new URL(url);
    assert.equal(
      `${parsed.origin}${parsed.pathname}`,
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    assert.equal(redirectUri, 'http://localhost:51121/oauth-callback');
    // Google 这家不用 PKCE
    assert.equal(parsed.searchParams.has('code_challenge'), false);
  });

  it('auth-url rejects an unknown provider with provider_not_found', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscription/oauth/auth-url?provider=nope',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().status, 'error');
    assert.equal(response.json().error, 'provider_not_found');
  });

  it('auth-url rejects a missing provider', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscription/oauth/auth-url',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'provider is required');
  });

  // codex/claude 的端口被官方应用注册死，两个并发会话必然抢同一个 listener。
  // 这里必须回 409 而不是让第二家去撞 EADDRINUSE（那会变成 500 且文案指向"端口被占"）。
  it('auth-url rejects a second concurrent session for the same provider with 409', async () => {
    await beginOAuth('codex');
    const second = await app.inject({
      method: 'GET',
      url: '/api/subscription/oauth/auth-url?provider=codex',
      headers: localUiHeaders,
    });
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(second.json().status, 'error');
    assert.equal(second.json().error, 'session already pending');
  });

  it('status returns wait while pending', async () => {
    const { state } = await beginOAuth('claude');
    assert.equal((await statusOf(state)).status, 'wait');
    assert.equal((await statusOf(state)).status, 'wait');
  });

  it('status returns invalid state for a malformed state', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscription/oauth/status?state=tooshort',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'invalid state');
  });

  it('status returns unknown or expired state for an unseen state', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/subscription/oauth/status?state=${'a'.repeat(43)}`,
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'error');
    assert.equal(response.json().error, 'unknown or expired state');
  });

  // 对齐参考项目 GetAuthStatus：无 state 参数时 `200 {"status":"ok"}`，
  // 而不是把"没给 state"当成非法输入报 400。这是探活语义（UI 用来判断端点是否活着）。
  it('status without a state answers 200 status ok like the reference', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subscription/oauth/status',
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status: 'ok' });
  });

  // 真实链路：auth-url 起监听 → 浏览器跳到回环地址 → 监听器交货 → 换 token → 落库。
  it('status returns ok once the loopback callback carried a matching state', async () => {
    SUBSCRIPTION_ADAPTERS.codex.exchangeCode = async ({ code, verifier }) => {
      exchangeCalls += 1;
      assert.equal(code, 'CODE_OK');
      assert.ok(verifier, 'codex must use PKCE');
      return {
        payload: {
          accessToken: 'AT',
          refreshToken: 'RT',
          accountId: 'oauth-codex-ok',
          email: 'oauth@example.com',
        },
        profile: { id: 'oauth-codex-ok', email: 'oauth@example.com' },
      };
    };

    const { state, redirectUri } = await beginOAuth('codex');
    const callback = await fetch(`${redirectUri}?code=CODE_OK&state=${state}`);
    assert.equal(callback.status, 200);

    const record = await waitForStatus(state, 'ok');
    assert.equal(record.status, 'ok');
    const pool = await getCredentialRuntime().getPool('codex');
    const stored = pool.accounts.find((entry) => entry.id === 'oauth-codex-ok');
    assert.ok(stored, 'the account must be persisted');
    assert.equal(stored.status, 'active');
    assert.equal(stored.label, 'oauth@example.com');
  });

  // 落账号必须与文件导入走同一条路径，否则 OAuth 进来的 provider 不会被启用，
  // /v1/models 与 auto 都看不到它。
  it('enables the provider in the live registry after an OAuth login', async () => {
    SUBSCRIPTION_ADAPTERS.google.exchangeCode = async () => {
      exchangeCalls += 1;
      return {
        payload: {
          accessToken: 'AT',
          refreshToken: 'RT_GOOGLE',
          clientId: 'CID',
          clientSecret: 'CS',
        },
        profile: { id: 'google-oauth-1', email: 'g@example.com' },
      };
    };

    const { state, redirectUri } = await beginOAuth('google');
    await fetch(`${redirectUri}?code=CODE_G&state=${state}`);
    await waitForStatus(state, 'ok');
    assert.equal(registry.getConfig().providers.google?.enabled, true);
  });

  it('status returns error when exchangeCode rejects', async () => {
    SUBSCRIPTION_ADAPTERS.codex.exchangeCode = async () => {
      exchangeCalls += 1;
      throw new Error('token exchange blew up');
    };

    const { state, redirectUri } = await beginOAuth('codex');
    await fetch(`${redirectUri}?code=CODE_FAIL&state=${state}`);

    const record = await waitForStatus(state, 'error');
    assert.match(record.error ?? '', /token exchange blew up/);
    assert.equal((await getCredentialRuntime().getPool('codex')).accounts.length, 0);
  });

  // 本机任何进程都能往回调端口投递。投一个形状合法但不是本会话的 state，
  // **不能**把受害者会话打挂（参考项目对不匹配的投递是忽略），也不能消耗掉监听。
  it('ignores a callback carrying a foreign state and still completes on the real one', async () => {
    SUBSCRIPTION_ADAPTERS.codex.exchangeCode = async () => {
      exchangeCalls += 1;
      return {
        payload: {
          accessToken: 'AT',
          refreshToken: 'RT',
          accountId: 'oauth-codex-after-csrf',
          email: 'csrf@example.com',
        },
        profile: { id: 'oauth-codex-after-csrf', email: 'csrf@example.com' },
      };
    };

    const { state, redirectUri } = await beginOAuth('codex');
    const intruder = await fetch(`${redirectUri}?code=STOLEN&state=${'b'.repeat(43)}`);
    assert.equal(intruder.status, 400);
    assert.equal((await statusOf(state)).status, 'wait', 'the session must keep waiting');
    assert.equal(exchangeCalls, 0, 'a foreign state must never reach the token endpoint');

    // 真实回调随后仍要能完成这个会话 —— 监听不能被外来投递消耗掉。
    const real = await fetch(`${redirectUri}?code=CODE_AFTER_CSRF&state=${state}`);
    assert.equal(real.status, 200);
    const record = await waitForStatus(state, 'ok');
    assert.equal(record.status, 'ok');
    assert.equal(exchangeCalls, 1);
    assert.equal((await getCredentialRuntime().getPool('codex')).accounts.length, 1);
  });

  // 用户在授权页点「拒绝」时，provider 跳回来的是 `?error=access_denied&state=…`。
  // 会话必须带着"你拒绝了"的结论立刻收尾，而不是挂到 10 分钟超时。
  it('records the denial when the provider redirects back with access_denied', async () => {
    const { state, redirectUri } = await beginOAuth('codex');

    const response = await fetch(
      `${redirectUri}?error=access_denied&error_description=user+denied&state=${state}`,
    );
    assert.equal(response.status, 200);

    const record = await waitForStatus(state, 'error');
    assert.equal(record.error, 'access_denied');
    assert.equal(exchangeCalls, 0, 'a denial must never reach the token endpoint');
    assert.equal((await getCredentialRuntime().getPool('codex')).accounts.length, 0);
  });

  // 走 /oauth/callback 的拒绝：先把原因记下，再关监听。
  // 若先关监听，abort 会把失败原因覆盖成 "OAuth callback listener closed"，
  // 用户看到的就不是"你拒绝了授权"，而是一句莫名其妙的监听器错误。
  it('keeps the denial reason when it arrives through /oauth/callback', async () => {
    const { state } = await beginOAuth('codex');

    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/oauth/callback',
      headers: { ...localUiHeaders, 'content-type': 'application/json' },
      payload: { state, error: 'access_denied' },
    });
    assert.equal(response.statusCode, 400, response.body);

    const record = await waitForStatus(state, 'error');
    assert.equal(record.error, 'access_denied');
    assert.equal((await getCredentialRuntime().getPool('codex')).accounts.length, 0);
  });

  it('cancel returns cancelled:true, frees the port and makes a later callback a no-op', async () => {
    const { state, redirectUri } = await beginOAuth('codex');

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/api/subscription/oauth/session?state=${state}`,
      headers: localUiHeaders,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().status, 'ok');
    assert.equal(cancelled.json().cancelled, true);

    // 监听器已关：迟到的回调连不上，更不会落账号
    await fetch(`${redirectUri}?code=CODE_LATE&state=${state}`).catch(() => undefined);
    assert.equal(exchangeCalls, 0);
    assert.equal((await getCredentialRuntime().getPool('codex')).accounts.length, 0);

    // 端口必须已释放，否则用户取消后重试会一直撞 EADDRINUSE
    liveStates = liveStates.filter((entry) => entry !== state);
    const retry = await beginOAuth('codex');
    assert.equal(retry.redirectUri, 'http://localhost:1455/auth/callback');
  });

  it('cancel without state returns 400', async () => {
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/subscription/oauth/session',
      headers: localUiHeaders,
    });
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal(missing.json().error, 'missing state');

    const invalid = await app.inject({
      method: 'DELETE',
      url: '/api/subscription/oauth/session?state=nope',
      headers: localUiHeaders,
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(invalid.json().error, 'invalid state');
  });

  it('cancel of an unknown state reports cancelled:false', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/subscription/oauth/session?state=${'c'.repeat(43)}`,
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().cancelled, false);
  });

  // 参考项目 CancelAuthSession 对已结束的会话返回 false（没有可取消的东西了），
  // 且保留记录，UI 才读得到最终结果；返回 true 会让用户以为是自己取消掉的。
  it('cancel of a finished session reports cancelled:false and keeps the outcome', async () => {
    SUBSCRIPTION_ADAPTERS.codex.exchangeCode = async () => {
      throw new Error('nope');
    };
    const { state, redirectUri } = await beginOAuth('codex');
    await fetch(`${redirectUri}?code=CODE_X&state=${state}`);
    const finished = await waitForStatus(state, 'error');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/subscription/oauth/session?state=${state}`,
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().cancelled, false);
    // 结果仍可读（不会被"取消"抹掉）
    assert.equal((await statusOf(state)).error, finished.error);
  });

  // 官方 CLI 常常也在监听 1455；用户最容易撞上的失败就是端口被占。
  it('auth-url surfaces a readable error when the fixed port is already taken', async () => {
    let blocker: LoopbackCallback | null = null;
    try {
      blocker = await startLoopbackListener({ port: 1455, path: '/blocker' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/subscription/oauth/auth-url?provider=codex',
        headers: localUiHeaders,
      });
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(response.json().status, 'error');
      assert.match(response.json().error, /1455/);
    } finally {
      blocker?.close();
    }
  });

  it('the callback endpoint completes a pending session via GET', async () => {
    SUBSCRIPTION_ADAPTERS.claude.exchangeCode = async ({ code, state, verifier }) => {
      exchangeCalls += 1;
      assert.equal(code, 'CODE_CB');
      assert.ok(state, 'claude posts state in the token body');
      assert.ok(verifier, 'claude must use PKCE');
      return {
        payload: { accessToken: 'AT', refreshToken: 'RT', accountUuid: 'oauth-claude-cb' },
        profile: { id: 'oauth-claude-cb', email: 'cb@example.com' },
      };
    };

    const { state } = await beginOAuth('claude');
    const response = await app.inject({
      method: 'GET',
      url: `/api/subscription/oauth/callback?code=CODE_CB&state=${state}`,
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers['content-type']), /text\/html/);

    await waitForStatus(state, 'ok');
    const pool = await getCredentialRuntime().getPool('claude');
    assert.ok(pool.accounts.some((entry) => entry.id === 'oauth-claude-cb'));
  });

  it('the callback endpoint rejects an unknown state without touching the token endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/subscription/oauth/callback?code=CODE&state=${'d'.repeat(43)}`,
      headers: localUiHeaders,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(exchangeCalls, 0);
  });

  it('oauth/import behaves exactly like credentials import', async () => {
    const payload = { raw: codexAuthJson() };
    const viaCredentials = await app.inject({
      method: 'POST',
      url: '/api/subscription/credentials?provider=codex',
      headers: localUiHeaders,
      payload,
    });
    assert.equal(viaCredentials.statusCode, 200, viaCredentials.body);

    await getCredentialRuntime().removeAccount('codex', 'acct-import');

    const viaOAuth = await app.inject({
      method: 'POST',
      url: '/api/subscription/oauth/import?provider=codex',
      headers: localUiHeaders,
      payload,
    });
    assert.equal(viaOAuth.statusCode, 200, viaOAuth.body);
    assert.deepEqual(viaOAuth.json(), viaCredentials.json());

    const pool = await getCredentialRuntime().getPool('codex');
    assert.ok(pool.accounts.some((entry) => entry.id === 'acct-import'));
  });

  it('oauth/import sniffs the provider when none is given', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/subscription/oauth/import',
      headers: localUiHeaders,
      payload: { raw: codexAuthJson() },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().account.provider, 'codex');
  });
});

/** 端口是否有人监听（真实 TCP 连一次，不靠内部状态猜）。 */
function portState(port: number): Promise<'accepting' | 'refused'> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve('accepting');
    });
    socket.once('error', () => {
      socket.destroy();
      resolve('refused');
    });
  });
}

// 服务关停必须把回环监听一起关掉。
//
// 否则：端口留在监听状态（用户以为"登录中"，其实服务已经没了），
// 且那个 10 分钟的会话定时器会把进程吊着不退出 —— 在测试里表现为整个 job 挂死。
describe('subscription OAuth server shutdown', () => {
  it('releases the fixed loopback port when the server closes with a pending session', async () => {
    const registry = new ProviderRegistry(testConfig());
    const { app: local } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });

    const started = await local.inject({
      method: 'GET',
      url: '/api/subscription/oauth/auth-url?provider=codex',
      headers: localUiHeaders,
    });
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(await portState(1455), 'accepting', 'precondition: the listener is up');

    await local.close();

    assert.equal(await portState(1455), 'refused', 'app.close() must release the callback port');
  });
});
