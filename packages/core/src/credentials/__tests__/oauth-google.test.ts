import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { googleAdapter } from '../adapters/subscription/google.js';
import { SubscriptionImportError } from '../adapters/subscription/types.js';

const google = googleAdapter;
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:51121/oauth-callback';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json';
const SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string;
}

function stubFetch(routes: { token: unknown; userinfo?: unknown; userinfoStatus?: number }): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (url === USERINFO_URL) {
      const status = routes.userinfoStatus ?? 200;
      return status === 200
        ? new Response(JSON.stringify(routes.userinfo ?? {}), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response('userinfo boom', { status });
    }
    return new Response(JSON.stringify(routes.token), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function tokenCall(calls: FetchCall[]): FetchCall {
  const call = calls.find((entry) => entry.url === TOKEN_URL);
  assert.ok(call, 'expected a token exchange call');
  return call;
}

describe('google OAuth', () => {
  it('buildAuthUrl targets accounts.google.com and carries NO PKCE parameters', () => {
    const url = new URL(
      google.buildAuthUrl({ state: 'STATE', redirectUri: REDIRECT_URI, verifier: 'IGNORED' }),
    );
    assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), SCOPE);
    assert.equal(url.searchParams.get('state'), 'STATE');
    // 参考项目用 access_type=offline + prompt=consent 保证每次都下发 refresh_token
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    // Google 这家不使用 PKCE（参考项目 antigravity/auth.go:146-154 无任何 PKCE 参数）
    assert.equal(url.searchParams.has('code_challenge'), false);
    assert.equal(url.searchParams.has('code_challenge_method'), false);
  });

  it('buildAuthUrl uses the caller-supplied redirect uri verbatim', () => {
    const supplied = 'http://127.0.0.1:53123/oauth-callback';
    const url = new URL(
      google.buildAuthUrl({ state: 'STATE', redirectUri: supplied, verifier: undefined }),
    );
    assert.equal(url.searchParams.get('redirect_uri'), supplied);
  });

  it('exchangeCode posts form-urlencoded and derives the profile', async () => {
    const { impl, calls } = stubFetch({
      token: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer' },
      userinfo: {},
    });

    const parsed = await google.exchangeCode({
      code: 'CODE',
      redirectUri: REDIRECT_URI,
      fetchImpl: impl,
    });

    const call = tokenCall(calls);
    assert.equal(call.method, 'POST');
    assert.match(call.headers.get('content-type') ?? '', /application\/x-www-form-urlencoded/);

    const body = new URLSearchParams(call.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'CODE');
    assert.equal(body.get('redirect_uri'), REDIRECT_URI);
    assert.equal(body.get('client_id'), CLIENT_ID);
    // 交互登录没有文件可读，client_secret 取内置的 Antigravity 应用机密
    assert.equal(body.get('client_secret'), CLIENT_SECRET);

    assert.equal(parsed.payload.accessToken, 'AT');
    assert.equal(parsed.payload.refreshToken, 'RT');
    assert.equal(parsed.payload.clientId, CLIENT_ID);
    assert.equal(parsed.payload.clientSecret, CLIENT_SECRET);
    assert.equal(parsed.payload.scope, SCOPE);
    assert.ok(Number(parsed.payload.expiresAt) > Date.now(), 'expiresAt should be in the future');
  });

  it('exchangeCode fetches the userinfo email and sets profile.email', async () => {
    const { impl, calls } = stubFetch({
      token: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
      userinfo: { email: 'google@example.com' },
    });

    const parsed = await google.exchangeCode({
      code: 'CODE',
      redirectUri: REDIRECT_URI,
      fetchImpl: impl,
    });

    const userinfo = calls.find((entry) => entry.url === USERINFO_URL);
    assert.ok(userinfo, 'expected a userinfo call');
    assert.equal(userinfo.headers.get('authorization'), 'Bearer AT');
    assert.equal(parsed.profile.email, 'google@example.com');
    // Google 没有服务端账号 id，身份由 refresh token 摘要派生
    assert.match(parsed.profile.id, /^google-[0-9a-f]{12}$/);
  });

  it('exchangeCode still succeeds when userinfo fails (email stays undefined)', async () => {
    const { impl } = stubFetch({
      token: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
      userinfoStatus: 500,
    });

    const parsed = await google.exchangeCode({
      code: 'CODE',
      redirectUri: REDIRECT_URI,
      fetchImpl: impl,
    });

    assert.equal(parsed.payload.accessToken, 'AT');
    assert.equal(parsed.profile.email, undefined);
  });

  it('throws SubscriptionImportError when the token response has no refresh_token', async () => {
    const { impl } = stubFetch({ token: { access_token: 'AT' } });
    await assert.rejects(
      google.exchangeCode({ code: 'CODE', redirectUri: REDIRECT_URI, fetchImpl: impl }),
      SubscriptionImportError,
    );
  });

  it('exchangeCode surfaces the fetch cause so real-world network blockers are diagnosable', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed', {
        cause: new Error('Connect Timeout Error (attempted address: oauth2.googleapis.com:443)'),
      });
    }) as typeof fetch;

    await assert.rejects(
      () => google.exchangeCode({ code: 'CODE', redirectUri: REDIRECT_URI, fetchImpl: failing }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /fetch failed: Connect Timeout Error/);
        return true;
      },
    );
  });
});
