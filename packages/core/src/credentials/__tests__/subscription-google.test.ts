import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  SUBSCRIPTION_ADAPTERS,
  SubscriptionImportError,
  SubscriptionRefreshError,
} from '../adapters/subscription/index.js';

const google = SUBSCRIPTION_ADAPTERS.google;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** 服务端的 derived id 契约：完整 refresh token 的 sha256 前 12 位 hex */
function expectedDerivedId(refreshToken: string): string {
  return `google-${createHash('sha256').update(refreshToken.trim()).digest('hex').slice(0, 12)}`;
}

/** 构造测试用 ~/.gemini/oauth_creds.json */
function oauthCreds(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    access_token: 'AT',
    refresh_token: 'RT0123456789',
    scope: 'https://www.googleapis.com/auth/cloud-platform openid email',
    token_type: 'Bearer',
    id_token: 'header.payload.sig',
    expiry_date: 1755000000000,
    client_id: 'CID.apps.googleusercontent.com',
    client_secret: 'CS-secret',
    ...overrides,
  });
}

/** 记录请求的 fetch 桩，返回预置 Response */
function stubFetch(response: () => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('google adapter registration', () => {
  it('is registered as a real google adapter (not the placeholder)', () => {
    assert.equal(google.platform, 'google');
    // 占位适配器 parseImport 会抛 'not implemented'；真适配器解析合法 oauth_creds.json 成功
    const parsed = google.parseImport(oauthCreds());
    assert.equal(parsed.payload.accessToken, 'AT');
  });
});

describe('google parseImport', () => {
  it('parses ~/.gemini/oauth_creds.json into camelCase payload keys', () => {
    const parsed = google.parseImport(oauthCreds());
    assert.equal(parsed.payload.accessToken, 'AT');
    assert.equal(parsed.payload.refreshToken, 'RT0123456789');
    assert.equal(parsed.payload.clientId, 'CID.apps.googleusercontent.com');
    assert.equal(parsed.payload.clientSecret, 'CS-secret');
    assert.equal(parsed.payload.expiresAt, '1755000000000', 'expiresAt 为 expiry_date 毫秒字符串');
    assert.equal(
      parsed.payload.scope,
      'https://www.googleapis.com/auth/cloud-platform openid email',
    );
    assert.equal(parsed.payload.idToken, 'header.payload.sig');
    assert.equal(
      parsed.profile.id,
      expectedDerivedId('RT0123456789'),
      'profile.id 由完整 refresh token 摘要派生',
    );
  });

  it('keeps optional fields as empty strings when absent', () => {
    const parsed = google.parseImport(
      oauthCreds({ scope: undefined, id_token: undefined, expiry_date: undefined }),
    );
    assert.equal(parsed.payload.scope, '');
    assert.equal(parsed.payload.idToken, '');
    assert.equal(parsed.payload.expiresAt, '');
  });

  it('throws SubscriptionImportError mentioning google for invalid JSON', () => {
    assert.throws(
      () => google.parseImport('this is not json'),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /google/i);
        return true;
      },
    );
  });

  it('throws SubscriptionImportError mentioning google when refresh_token is missing', () => {
    assert.throws(
      () => google.parseImport(oauthCreds({ refresh_token: undefined })),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /google/i);
        assert.match(error.message, /refresh_token/i);
        return true;
      },
    );
  });

  it('throws SubscriptionImportError mentioning client_secret when it is missing', () => {
    // spec §5.3：文件内缺少 client_secret 时直接报错，不猜、不内置 Antigravity secret
    for (const missing of [undefined, '']) {
      assert.throws(
        () => google.parseImport(oauthCreds({ client_secret: missing })),
        (error: unknown) => {
          assert.ok(error instanceof SubscriptionImportError);
          assert.match(error.message, /client_secret/);
          return true;
        },
      );
    }
  });
});

describe('google refresh', () => {
  const basePayload = {
    accessToken: 'AT',
    refreshToken: 'RT0123456789',
    clientId: 'CID.apps.googleusercontent.com',
    clientSecret: 'CS-secret',
    scope: 'scope-a',
    idToken: 'id-token-value',
    expiresAt: '1755000000000',
  };

  it('POSTs a form-urlencoded grant using the imported client credentials', async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({ access_token: 'AT2', expires_in: 3600, token_type: 'Bearer' }),
    );
    const before = Date.now();
    const result = await google.refresh({
      fetchImpl: impl,
      refreshToken: 'RT0123456789',
      payload: basePayload,
    });
    const after = Date.now();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, TOKEN_URL);
    assert.equal(calls[0]?.init?.method, 'POST');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');

    const form = new URLSearchParams(String(calls[0]?.init?.body));
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('client_id'), 'CID.apps.googleusercontent.com');
    assert.equal(form.get('client_secret'), 'CS-secret');
    assert.equal(form.get('refresh_token'), 'RT0123456789');

    assert.equal(result.payload.accessToken, 'AT2');
    // Google 不轮换 refresh token：始终沿用旧值
    assert.equal(result.payload.refreshToken, 'RT0123456789');
    const expiresAt = Number(result.payload.expiresAt);
    assert.ok(expiresAt >= before + 3600000, `expiresAt ${expiresAt} 应 >= before+3600000`);
    assert.ok(expiresAt <= after + 3600000, `expiresAt ${expiresAt} 应 <= after+3600000`);

    // 其余 payload 字段原样保留
    assert.equal(result.payload.clientId, 'CID.apps.googleusercontent.com');
    assert.equal(result.payload.clientSecret, 'CS-secret');
    assert.equal(result.payload.scope, 'scope-a');
    assert.equal(result.payload.idToken, 'id-token-value');

    // 无独立 profile 端点：refresh 不返回 profile 更新
    assert.equal(result.profile, undefined);
  });

  it('never adopts a rotated refresh_token from the response', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({ access_token: 'AT2', refresh_token: 'RT-NEW', expires_in: 3600 }),
    );
    const result = await google.refresh({
      fetchImpl: impl,
      refreshToken: 'RT0123456789',
      payload: basePayload,
    });
    assert.equal(result.payload.refreshToken, 'RT0123456789');
  });

  it('falls back to the previous expiresAt when expires_in is absent', async () => {
    const { impl } = stubFetch(() => jsonResponse({ access_token: 'AT2' }));
    const result = await google.refresh({
      fetchImpl: impl,
      refreshToken: 'RT0123456789',
      payload: basePayload,
    });
    assert.equal(result.payload.accessToken, 'AT2');
    assert.equal(result.payload.expiresAt, '1755000000000');
  });

  it('treats 400 + invalid_grant as fatal', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'Token has been expired' },
        {
          status: 400,
        },
      ),
    );
    await assert.rejects(
      () =>
        google.refresh({
          fetchImpl: impl,
          refreshToken: 'RT0123456789',
          payload: basePayload,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'fatal');
        assert.equal(error.status, 400);
        assert.equal(google.isFatalRefreshError(error), true);
        return true;
      },
    );
  });

  it('classifies other non-2xx (e.g. 500) as retryable network', async () => {
    const { impl } = stubFetch(() => new Response('server exploded', { status: 500 }));
    await assert.rejects(
      () =>
        google.refresh({
          fetchImpl: impl,
          refreshToken: 'RT0123456789',
          payload: basePayload,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'network');
        assert.equal(google.isFatalRefreshError(error), false);
        return true;
      },
    );
  });

  it('maps network failures (fetch throws) to kind=network, not fatal', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(
      () =>
        google.refresh({
          fetchImpl: failing,
          refreshToken: 'RT0123456789',
          payload: basePayload,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'network');
        assert.equal(google.isFatalRefreshError(error), false);
        return true;
      },
    );
  });

  it('redacts secrets from the error message', async () => {
    const { impl } = stubFetch(() => new Response('refresh_token=SECRETVAL bad', { status: 500 }));
    await assert.rejects(
      () =>
        google.refresh({
          fetchImpl: impl,
          refreshToken: 'RT0123456789',
          payload: basePayload,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          !error.message.includes('SECRETVAL'),
          `message must not contain the raw token: ${error.message}`,
        );
        return true;
      },
    );
  });
});

describe('google accountIdOf', () => {
  it('is stable for the same refresh token and distinct across tokens (no short-prefix collision)', () => {
    const idA = google.accountIdOf({ id: '' }, { refreshToken: 'RT-AAAAAAAAAAAAAAAAAAAA' });
    const idAAgain = google.accountIdOf({ id: '' }, { refreshToken: 'RT-AAAAAAAAAAAAAAAAAAAA' });
    const idB = google.accountIdOf({ id: '' }, { refreshToken: 'RT-BBBBBBBBBBBBBBBBBBBB' });

    assert.equal(idA, idAAgain, '同一 refresh token 必须得到同一 account id');
    assert.notEqual(idA, idB, '不同 refresh token 不得得到同一 account id');
    assert.equal(idA, expectedDerivedId('RT-AAAAAAAAAAAAAAAAAAAA'));
    assert.equal(idB, expectedDerivedId('RT-BBBBBBBBBBBBBBBBBBBB'));
    // 不得是朴素的前缀切片（Google refresh token 前缀不保证唯一）
    assert.notEqual(idA, `google-${'RT-AAAAAAAAAAAAAAAAAAAA'.slice(0, 8)}`);
  });

  it('derives distinct ids for tokens sharing the same 8-char prefix', () => {
    const tokenA = '1//0abcdefGHIJKLMNOPQRSTUV-A';
    const tokenB = '1//0abcdefZZZZZZZZZZZZZZZZ-B';
    assert.equal(tokenA.slice(0, 8), tokenB.slice(0, 8), 'precondition: shared 8-char prefix');
    assert.notEqual(
      google.accountIdOf({ id: '' }, { refreshToken: tokenA }),
      google.accountIdOf({ id: '' }, { refreshToken: tokenB }),
    );
  });

  it('agrees with the id parseImport derives (profile.id) and falls back to the digest', () => {
    const parsed = google.parseImport(oauthCreds());
    assert.equal(google.accountIdOf(parsed.profile, parsed.payload), parsed.profile.id);
    assert.equal(google.accountIdOf({ id: '' }, {}), expectedDerivedId(''));
  });
});
