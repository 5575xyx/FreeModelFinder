import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SUBSCRIPTION_ADAPTERS,
  SubscriptionImportError,
  SubscriptionRefreshError,
} from '../adapters/subscription/index.js';

const codex = SUBSCRIPTION_ADAPTERS.codex;

/** 构造测试用 JWT：x.<base64url(claims)>.y，仅测身份声明解析，不验签 */
function buildJwt(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
}

const idToken = buildJwt({
  email: 'user@example.com',
  'https://api.openai.com/auth': {
    auth_user_id: 'user_1',
    chatgpt_account_id: 'acc_1',
    chatgpt_plan_type: 'pro',
  },
});

const authJson = JSON.stringify({
  OPENAI_API_KEY: null,
  auth_mode: 'chatgpt',
  tokens: {
    id_token: idToken,
    access_token: 'AT',
    refresh_token: 'RT',
    account_id: 'acc_1',
  },
  last_refresh: '2026-10-14T00:00:00.000Z',
});

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

describe('codex adapter registration', () => {
  it('is registered as a real codex adapter (not the placeholder)', () => {
    assert.equal(codex.platform, 'codex');
    // 占位适配器 parseImport 会抛 'not implemented'；真适配器解析合法 auth.json 成功
    const parsed = codex.parseImport(authJson);
    assert.equal(parsed.payload.accountId, 'acc_1');
  });
});

describe('codex parseImport', () => {
  it('parses ~/.codex/auth.json and derives profile from the id_token claims', () => {
    const parsed = codex.parseImport(authJson);
    assert.equal(parsed.payload.accessToken, 'AT');
    assert.equal(parsed.payload.refreshToken, 'RT');
    assert.equal(parsed.payload.idToken, idToken);
    assert.equal(parsed.payload.accountId, 'acc_1');
    assert.equal(parsed.payload.expiresAt, '', 'expiresAt 置空串=未知，首次使用强制刷新');
    assert.equal(parsed.payload.email, 'user@example.com');
    assert.equal(parsed.payload.plan, 'pro');
    assert.equal(parsed.profile.email, 'user@example.com');
    assert.equal(parsed.profile.plan, 'pro');
    assert.equal(parsed.profile.id, 'acc_1', 'profile.id 优先取 chatgpt_account_id 声明');
  });

  it('falls back to top-level email claim and account_id when auth claims are absent', () => {
    const jwt = buildJwt({ email: 'top@example.com' });
    const raw = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: jwt, access_token: 'AT', refresh_token: 'RT', account_id: 'acc_2' },
    });
    const parsed = codex.parseImport(raw);
    assert.equal(parsed.profile.email, 'top@example.com');
    assert.equal(parsed.profile.id, 'acc_2');
  });

  it('throws SubscriptionImportError mentioning codex for invalid JSON', () => {
    assert.throws(
      () => codex.parseImport('this is not json'),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /codex/i);
        return true;
      },
    );
  });

  it('throws SubscriptionImportError mentioning codex when tokens.refresh_token is missing', () => {
    const raw = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: idToken, access_token: 'AT', account_id: 'acc_1' },
    });
    assert.throws(
      () => codex.parseImport(raw),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /codex/i);
        return true;
      },
    );
  });

  it('throws SubscriptionImportError when the tokens block is absent entirely', () => {
    assert.throws(
      () => codex.parseImport(JSON.stringify({ auth_mode: 'chatgpt' })),
      SubscriptionImportError,
    );
  });
});

describe('codex refresh', () => {
  const basePayload = { accessToken: 'AT', refreshToken: 'RT', accountId: 'acc_1' };

  it('POSTs form-urlencoded refresh to auth.openai.com/oauth/token and rotates tokens', async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({
        access_token: 'AT2',
        refresh_token: 'RT2',
        id_token: idToken,
        expires_in: 3600,
      }),
    );
    const before = Date.now();
    const result = await codex.refresh({
      fetchImpl: impl,
      refreshToken: 'RT',
      payload: basePayload,
    });
    const after = Date.now();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://auth.openai.com/oauth/token');
    assert.equal(calls[0]?.init?.method, 'POST');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');

    const form = new URLSearchParams(String(calls[0]?.init?.body));
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(form.get('refresh_token'), 'RT');
    assert.equal(form.get('scope'), 'openid profile email');

    assert.equal(result.payload.accessToken, 'AT2');
    assert.equal(result.payload.refreshToken, 'RT2', '响应给出新 refresh_token 时轮换');
    const expiresAt = Number(result.payload.expiresAt);
    assert.ok(expiresAt >= before + 3600000, `expiresAt ${expiresAt} 应 >= before+3600000`);
    assert.ok(expiresAt <= after + 3600000, `expiresAt ${expiresAt} 应 <= after+3600000`);
  });

  it('keeps the old refresh_token when the response omits a new one', async () => {
    const { impl } = stubFetch(() => jsonResponse({ access_token: 'AT2', expires_in: 3600 }));
    const result = await codex.refresh({
      fetchImpl: impl,
      refreshToken: 'RT',
      payload: basePayload,
    });
    assert.equal(result.payload.refreshToken, 'RT');
    assert.equal(result.payload.accessToken, 'AT2');
  });

  it('maps 400 refresh_token_reused to a fatal SubscriptionRefreshError', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'refresh_token_reused' },
        { status: 400 },
      ),
    );
    await assert.rejects(
      () => codex.refresh({ fetchImpl: impl, refreshToken: 'RT', payload: basePayload }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'fatal');
        assert.equal(error.status, 400);
        assert.equal(codex.isFatalRefreshError(error), true);
        return true;
      },
    );
  });

  it('treats 400 invalid_grant as fatal too', async () => {
    const { impl } = stubFetch(() => jsonResponse({ error: 'invalid_grant' }, { status: 400 }));
    await assert.rejects(
      () => codex.refresh({ fetchImpl: impl, refreshToken: 'RT', payload: basePayload }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(codex.isFatalRefreshError(error), true);
        return true;
      },
    );
  });

  it('maps 429 to a rate_limit error carrying resetAt from Retry-After', async () => {
    const { impl } = stubFetch(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    );
    await assert.rejects(
      () => codex.refresh({ fetchImpl: impl, refreshToken: 'RT', payload: basePayload }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'rate_limit');
        assert.equal(error.status, 429);
        assert.ok(
          typeof error.resetAt === 'number' && error.resetAt >= Date.now() + 29_000,
          `resetAt 应基于 Retry-After，得到 ${error.resetAt}`,
        );
        return true;
      },
    );
  });

  it('maps network failures (fetch throws) to kind=network, not fatal', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(
      () => codex.refresh({ fetchImpl: failing, refreshToken: 'RT', payload: basePayload }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'network');
        assert.equal(codex.isFatalRefreshError(error), false);
        return true;
      },
    );
  });

  it('isFatalRefreshError returns false for unrelated errors', () => {
    assert.equal(codex.isFatalRefreshError(new Error('boom')), false);
    const transient = new SubscriptionRefreshError('oops', { kind: 'network' });
    assert.equal(codex.isFatalRefreshError(transient), false);
  });
});

describe('codex accountIdOf', () => {
  it('prefers profile.id', () => {
    assert.equal(
      codex.accountIdOf({ id: 'acc_profile' }, { accountId: 'acc_payload' }),
      'acc_profile',
    );
  });

  it('falls back to payload.accountId truncated to 32 chars', () => {
    const long = 'a'.repeat(40);
    assert.equal(codex.accountIdOf({ id: '' }, { accountId: long }), 'a'.repeat(32));
    assert.equal(codex.accountIdOf({ id: '' }, { accountId: 'acc_1' }), 'acc_1');
  });
});
