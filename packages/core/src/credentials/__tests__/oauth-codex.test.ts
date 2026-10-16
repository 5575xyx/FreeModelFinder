import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { codexAdapter } from '../adapters/subscription/codex.js';
import { SubscriptionImportError } from '../adapters/subscription/index.js';
import {
  SUBSCRIPTION_OAUTH,
  normalizeSubscriptionProvider,
} from '../adapters/subscription/oauth-config.js';

const codex = codexAdapter;

const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';

function base64url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function buildJwt(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
}

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string;
}

function stubFetch(payload: unknown): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe('subscription OAuth config', () => {
  it('SUBSCRIPTION_OAUTH pins the official callback ports and paths', () => {
    assert.deepEqual(SUBSCRIPTION_OAUTH, {
      codex: { callbackPort: 1455, callbackPath: '/auth/callback', usesPkce: true },
      claude: { callbackPort: 54545, callbackPath: '/callback', usesPkce: true },
      google: { callbackPort: 51121, callbackPath: '/oauth-callback', usesPkce: false },
    });
  });

  it('normalizeSubscriptionProvider accepts antigravity as google', () => {
    assert.equal(normalizeSubscriptionProvider('antigravity'), 'google');
    assert.equal(normalizeSubscriptionProvider('google'), 'google');
    assert.equal(normalizeSubscriptionProvider('codex'), 'codex');
    // 参考项目对 provider 查询参数做 ToLower(TrimSpace)
    assert.equal(normalizeSubscriptionProvider('  CLAUDE '), 'claude');
  });

  it('normalizeSubscriptionProvider rejects unknown values', () => {
    assert.equal(normalizeSubscriptionProvider(''), null);
    // `gemini` 是本仓另一个（API key）provider，不是订阅 provider，不能混进来
    assert.equal(normalizeSubscriptionProvider('gemini'), null);
    assert.equal(normalizeSubscriptionProvider('vertex'), null);
  });
});

describe('codex OAuth', () => {
  it('buildAuthUrl targets auth.openai.com and carries PKCE S256 + required params', () => {
    const url = new URL(
      codex.buildAuthUrl({ state: 'STATE', redirectUri: REDIRECT_URI, verifier: 'VERIFIER' }),
    );
    assert.equal(`${url.origin}${url.pathname}`, 'https://auth.openai.com/oauth/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    // 交互登录的 scope 与刷新不同：必须带 offline_access 才能拿到 refresh_token
    assert.equal(url.searchParams.get('scope'), 'openid email profile offline_access');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(url.searchParams.get('state'), 'STATE');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), base64url('VERIFIER'));
    // 参考项目原生客户端带的三个参数：强制重新登录（多账号场景必需）+
    // 让 id_token 带上组织声明 + 走 simplified flow
    assert.equal(url.searchParams.get('prompt'), 'login');
    assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
    assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  });

  it('exchangeCode posts form-urlencoded to the token endpoint and maps the response', async () => {
    const idToken = buildJwt({
      email: 'oauth@example.com',
      'https://api.openai.com/auth': {
        auth_user_id: 'user_9',
        chatgpt_account_id: 'acc_9',
        chatgpt_plan_type: 'plus',
      },
    });
    const { impl, calls } = stubFetch({
      access_token: 'AT_1',
      refresh_token: 'RT_1',
      id_token: idToken,
      expires_in: 3600,
    });

    const parsed = await codex.exchangeCode({
      code: 'CODE',
      redirectUri: REDIRECT_URI,
      verifier: 'VERIFIER',
      fetchImpl: impl,
    });

    const call = calls[0];
    assert.ok(call, 'expected exactly one upstream call');
    assert.equal(call.url, 'https://auth.openai.com/oauth/token');
    assert.equal(call.method, 'POST');
    assert.match(call.headers.get('content-type') ?? '', /application\/x-www-form-urlencoded/);

    const body = new URLSearchParams(call.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'CODE');
    assert.equal(body.get('redirect_uri'), REDIRECT_URI);
    assert.equal(body.get('code_verifier'), 'VERIFIER');
    assert.equal(body.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');

    assert.equal(parsed.payload.accessToken, 'AT_1');
    assert.equal(parsed.payload.refreshToken, 'RT_1');
    assert.equal(parsed.payload.idToken, idToken);
    assert.equal(parsed.profile.email, 'oauth@example.com');
    assert.equal(parsed.profile.plan, 'plus');
  });

  it('exchangeCode surfaces the fetch cause so real-world network blockers are diagnosable', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed', {
        cause: new Error('Connect Timeout Error (attempted address: auth.openai.com:443)'),
      });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        codex.exchangeCode({
          code: 'CODE',
          redirectUri: REDIRECT_URI,
          verifier: 'VERIFIER',
          fetchImpl: failing,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /fetch failed: Connect Timeout Error/);
        return true;
      },
    );
  });
});
