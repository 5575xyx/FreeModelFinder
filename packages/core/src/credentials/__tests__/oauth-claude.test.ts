import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeAdapter } from '../adapters/subscription/claude.js';
import { SubscriptionImportError } from '../adapters/subscription/types.js';
import { pkceChallenge } from '../oauth/pkce.js';

const claude = claudeAdapter;
const REDIRECT_URI = 'http://localhost:54545/callback';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string;
}

function stubFetch(routes: { token: unknown; profile?: unknown }): {
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
    const payload = url === PROFILE_URL ? (routes.profile ?? {}) : routes.token;
    return new Response(JSON.stringify(payload), {
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

function bodyOf(call: FetchCall): Record<string, string> {
  return JSON.parse(call.body) as Record<string, string>;
}

describe('claude OAuth', () => {
  it('buildAuthUrl targets claude.ai with PKCE and the full scope set', () => {
    const url = new URL(
      claude.buildAuthUrl({ state: 'STATE', redirectUri: REDIRECT_URI, verifier: 'VERIFIER' }),
    );
    assert.equal(`${url.origin}${url.pathname}`, 'https://claude.ai/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('scope'), SCOPE);
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('state'), 'STATE');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), pkceChallenge('VERIFIER'));
    // 参考项目原生客户端会多带一个 code=true
    assert.equal(url.searchParams.get('code'), 'true');
  });

  it('exchangeCode posts a JSON body with the axios-style User-Agent', async () => {
    const { impl, calls } = stubFetch({
      token: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
    });

    await claude.exchangeCode({
      code: 'CODE',
      redirectUri: REDIRECT_URI,
      verifier: 'VERIFIER',
      state: 'STATE',
      fetchImpl: impl,
    });

    const call = tokenCall(calls);
    assert.equal(call.method, 'POST');
    assert.match(call.headers.get('content-type') ?? '', /application\/json/);
    // 原生 Claude Code 走 axios，控制面按 UA 放行；普通 Node fetch 的 UA 可能被 Cloudflare 拒绝
    assert.equal(call.headers.get('user-agent'), 'axios/1.15.2');

    const body = bodyOf(call);
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.code, 'CODE');
    assert.equal(body.redirect_uri, REDIRECT_URI);
    assert.equal(body.client_id, CLIENT_ID);
    assert.equal(body.code_verifier, 'VERIFIER');
    assert.equal(body.state, 'STATE');
  });

  it('exchangeCode strips a trailing "#state" from the returned code before exchange', async () => {
    const { impl, calls } = stubFetch({
      token: { access_token: 'AT', refresh_token: 'RT' },
    });

    await claude.exchangeCode({
      code: 'abc#xyz',
      redirectUri: REDIRECT_URI,
      verifier: 'VERIFIER',
      state: 'STATE',
      fetchImpl: impl,
    });

    const body = bodyOf(tokenCall(calls));
    assert.equal(body.code, 'abc');
    // code 里 `#` 之后的片段优先于调用方传入的 state
    assert.equal(body.state, 'xyz');
  });

  it('maps identity from the token response and lets the profile lookup override it', async () => {
    const { impl } = stubFetch({
      token: {
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
        account: { uuid: 'acc-from-token', email_address: '' },
        organization: { uuid: 'org-from-token', name: '' },
      },
      profile: {
        account: { uuid: 'acc-from-profile', email: 'claude@example.com' },
        organization: { uuid: 'org-from-profile', name: 'Org From Profile' },
      },
    });

    const parsed = await claude.exchangeCode({
      code: 'CODE',
      redirectUri: REDIRECT_URI,
      verifier: 'VERIFIER',
      fetchImpl: impl,
    });

    assert.equal(parsed.payload.accessToken, 'AT');
    assert.equal(parsed.payload.refreshToken, 'RT');
    assert.equal(parsed.payload.accountUuid, 'acc-from-profile');
    assert.equal(parsed.payload.email, 'claude@example.com');
    assert.equal(parsed.payload.orgUuid, 'org-from-profile');
    assert.equal(parsed.payload.orgName, 'Org From Profile');
    assert.equal(parsed.profile.id, 'acc-from-profile');
    assert.equal(parsed.profile.email, 'claude@example.com');
    assert.equal(parsed.profile.organization, 'Org From Profile');
  });

  it('throws SubscriptionImportError when the token response has no refresh_token', async () => {
    const { impl } = stubFetch({ token: { access_token: 'AT' } });
    await assert.rejects(
      claude.exchangeCode({
        code: 'CODE',
        redirectUri: REDIRECT_URI,
        verifier: 'VERIFIER',
        fetchImpl: impl,
      }),
      SubscriptionImportError,
    );
  });

  it('exchangeCode surfaces the fetch cause so real-world network blockers are diagnosable', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed', {
        cause: new Error('getaddrinfo EAI_AGAIN platform.claude.com'),
      });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        claude.exchangeCode({
          code: 'CODE',
          redirectUri: REDIRECT_URI,
          verifier: 'VERIFIER',
          fetchImpl: failing,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /fetch failed: getaddrinfo EAI_AGAIN/);
        return true;
      },
    );
  });
});
