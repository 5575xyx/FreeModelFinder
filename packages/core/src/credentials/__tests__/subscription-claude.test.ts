import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  SUBSCRIPTION_ADAPTERS,
  SubscriptionImportError,
  SubscriptionRefreshError,
} from '../adapters/subscription/index.js';

const claude = SUBSCRIPTION_ADAPTERS.claude;

/** 服务端的 derived id 契约：完整 token 的 sha256 前 12 位 hex */
function expectedDerivedId(refreshToken: string): string {
  return `claude-${createHash('sha256').update(refreshToken.trim()).digest('hex').slice(0, 12)}`;
}

/** 真实 Claude OAuth refresh token 共享的常量前缀；不能据此截断做键 */
const CLAUDE_RT_PREFIX = 'sk-ant-ort01-';
const TOKEN_A = `${CLAUDE_RT_PREFIX}AAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const TOKEN_B = `${CLAUDE_RT_PREFIX}BBBBBBBBBBBBBBBBBBBBBBBBBBBB`;

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** 构造测试用 ~/.claude/.credentials.json */
function credentialsJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'AT',
      refreshToken: 'RT0123456789',
      expiresAt: 1755000000000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      ...overrides,
    },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** 按 URL 路由的 fetch 桩；未注册的 URL 直接抛错，避免误断言 */
function routeFetch(
  handlers: Record<string, (init: RequestInit | undefined) => Response | Promise<Response>>,
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = handlers[url];
    if (!handler) throw new Error(`unstubbed fetch url: ${url}`);
    return handler(init);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const tokenOk = (body: unknown) => () => jsonResponse(body);
const profileOk = (body: unknown) => () => jsonResponse(body);

const profileBody = {
  account: { uuid: 'acc-uuid-1', email: 'dev@example.com' },
  organization: { uuid: 'org-uuid-1', name: 'Acme Labs' },
};

describe('claude adapter registration', () => {
  it('is registered as a real claude adapter (not the placeholder)', () => {
    assert.equal(claude.platform, 'claude');
    const parsed = claude.parseImport(credentialsJson());
    assert.equal(parsed.payload.accessToken, 'AT');
  });
});

describe('claude parseImport', () => {
  it('parses ~/.claude/.credentials.json and derives the profile id from the refresh token', () => {
    const parsed = claude.parseImport(credentialsJson());
    assert.equal(parsed.payload.accessToken, 'AT');
    assert.equal(parsed.payload.refreshToken, 'RT0123456789');
    assert.equal(parsed.payload.expiresAt, '1755000000000', 'expiresAt 为毫秒字符串');
    assert.equal(parsed.payload.scopes, 'user:inference user:profile');
    assert.equal(parsed.payload.subscriptionType, 'max');
    assert.equal(parsed.payload.blockedUntil, '');
    assert.equal(parsed.payload.email, '');
    assert.equal(parsed.payload.accountUuid, '');
    assert.equal(parsed.payload.orgUuid, '');
    assert.equal(parsed.payload.orgName, '');
    assert.equal(
      parsed.profile.id,
      expectedDerivedId('RT0123456789'),
      '缺 accountUuid 时取完整 refreshToken 的 sha256 派生 id',
    );
    assert.equal(parsed.profile.plan, 'max');
  });

  it('prefers accountUuid for the profile id when present', () => {
    const parsed = claude.parseImport(
      credentialsJson({ accountUuid: 'acc-uuid-1', email: 'dev@example.com' }),
    );
    assert.equal(parsed.profile.id, 'acc-uuid-1');
    assert.equal(parsed.profile.email, 'dev@example.com');
    assert.equal(parsed.payload.accountUuid, 'acc-uuid-1');
  });

  it('throws SubscriptionImportError mentioning claude for invalid JSON', () => {
    assert.throws(
      () => claude.parseImport('this is not json'),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /claude/i);
        return true;
      },
    );
  });

  it('throws SubscriptionImportError mentioning claude when claudeAiOauth is absent', () => {
    assert.throws(
      () => claude.parseImport(JSON.stringify({ someOtherBlock: {} })),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /claude/i);
        return true;
      },
    );
  });

  it('throws SubscriptionImportError mentioning claude when refreshToken is missing', () => {
    assert.throws(
      () => claude.parseImport(JSON.stringify({ claudeAiOauth: { accessToken: 'AT' } })),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionImportError);
        assert.match(error.message, /claude/i);
        return true;
      },
    );
  });
});

describe('claude refresh', () => {
  it('POSTs an axios-shaped JSON refresh and rotates tokens', async () => {
    const { impl, calls } = routeFetch({
      [TOKEN_URL]: tokenOk({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }),
      [PROFILE_URL]: profileOk(profileBody),
    });
    const before = Date.now();
    const result = await claude.refresh({
      fetchImpl: impl,
      refreshToken: 'RT0123456789',
      payload: { accessToken: 'AT', refreshToken: 'RT0123456789', subscriptionType: 'max' },
    });
    const after = Date.now();

    const tokenCall = calls.find((call) => call.url === TOKEN_URL);
    assert.ok(tokenCall, 'must POST to the claude token endpoint');
    assert.equal(tokenCall.init?.method, 'POST');
    const headers = tokenCall.init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['User-Agent'], 'axios/1.15.2');

    const body = JSON.parse(String(tokenCall.init?.body)) as Record<string, string>;
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.client_id, CLIENT_ID);
    assert.equal(body.refresh_token, 'RT0123456789');
    assert.equal(body.scope, SCOPE);

    assert.equal(result.payload.accessToken, 'AT2');
    assert.equal(result.payload.refreshToken, 'RT2', '响应给出新 refresh_token 时轮换');
    assert.equal(result.payload.blockedUntil, '', '成功刷新后清除冷却');
    const expiresAt = Number(result.payload.expiresAt);
    assert.ok(expiresAt >= before + 3600000, `expiresAt ${expiresAt} 应 >= before+3600000`);
    assert.ok(expiresAt <= after + 3600000, `expiresAt ${expiresAt} 应 <= after+3600000`);
  });

  it('keeps the old refresh_token when the response omits a new one', async () => {
    const { impl } = routeFetch({
      [TOKEN_URL]: tokenOk({ access_token: 'AT2', expires_in: 3600 }),
      [PROFILE_URL]: profileOk(profileBody),
    });
    const result = await claude.refresh({
      fetchImpl: impl,
      refreshToken: 'RT-keep-old-rt',
      payload: { accessToken: 'AT', refreshToken: 'RT-keep-old-rt' },
    });
    assert.equal(result.payload.refreshToken, 'RT-keep-old-rt');
    assert.equal(result.payload.accessToken, 'AT2');
  });

  it('maps 429 + Retry-After to rate_limit, records blockedUntil, and blocks the next refresh', async () => {
    const refreshToken = 'RT-block-429';
    const { impl, calls } = routeFetch({
      [TOKEN_URL]: () =>
        new Response('slow down', { status: 429, headers: { 'retry-after': '12' } }),
    });
    const payload: Record<string, string> = { accessToken: 'AT', refreshToken };
    const before = Date.now();

    await assert.rejects(
      () => claude.refresh({ fetchImpl: impl, refreshToken, payload }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'rate_limit');
        assert.equal(error.status, 429);
        assert.ok(
          typeof error.resetAt === 'number' &&
            error.resetAt >= before + 11_000 &&
            error.resetAt <= Date.now() + 13_000,
          `resetAt 应基于 Retry-After=12s，得到 ${error.resetAt}`,
        );
        return true;
      },
    );
    assert.equal(calls.length, 1, '首次 429 只发一次请求');

    const blockedUntil = Number(payload.blockedUntil);
    assert.ok(
      blockedUntil >= before + 11_000,
      `payload.blockedUntil 应被写入 now+12s，得到 ${payload.blockedUntil}`,
    );

    await assert.rejects(
      () => claude.refresh({ fetchImpl: impl, refreshToken, payload }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'rate_limit');
        return true;
      },
    );
    assert.equal(calls.length, 1, '冷却期内再次 refresh 不得发出网络请求');
  });

  it('isolates the cooldown per refresh token (shared sk-ant-ort01- prefix must not collide)', async () => {
    const { impl, calls } = routeFetch({
      [TOKEN_URL]: (init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        if (body.refresh_token === TOKEN_A) {
          return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
        }
        return jsonResponse({ access_token: 'AT-B', refresh_token: 'RT-B', expires_in: 3600 });
      },
      [PROFILE_URL]: profileOk(profileBody),
    });

    await assert.rejects(
      () =>
        claude.refresh({
          fetchImpl: impl,
          refreshToken: TOKEN_A,
          payload: { refreshToken: TOKEN_A },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'rate_limit');
        return true;
      },
    );
    const tokenCalls = () => calls.filter((call) => call.url === TOKEN_URL);
    assert.equal(tokenCalls().length, 1, 'token A 首次 429 只发一次请求');

    // token B 与 A 共享同一 8 字符前缀，若 block key 只看前 8 位则会被错误地一起冷却
    const result = await claude.refresh({
      fetchImpl: impl,
      refreshToken: TOKEN_B,
      payload: { refreshToken: TOKEN_B },
    });
    assert.equal(tokenCalls().length, 2, 'token B 的冷却必须与 token A 独立，应真实发起请求');
    assert.equal(result.payload.accessToken, 'AT-B');
    assert.equal(result.payload.refreshToken, 'RT-B');
  });

  it('clamps the cooldown into the 5s-5min window (Retry-After-Ms)', async () => {
    const refreshToken = 'RT-clamp-ms';
    const { impl } = routeFetch({
      [TOKEN_URL]: () =>
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after-ms': '900000' },
        }),
    });
    const before = Date.now();
    await assert.rejects(
      () => claude.refresh({ fetchImpl: impl, refreshToken, payload: { refreshToken } }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'rate_limit');
        assert.ok(
          typeof error.resetAt === 'number' &&
            error.resetAt >= before + 299_000 &&
            error.resetAt <= Date.now() + 301_000,
          `Retry-After-Ms 900000 应 clamp 到 5min，得到 ${error.resetAt}`,
        );
        return true;
      },
    );
  });

  it('honours a persisted payload.blockedUntil without issuing a request', async () => {
    const refreshToken = 'RT-persisted-block';
    const { impl, calls } = routeFetch({});
    await assert.rejects(
      () =>
        claude.refresh({
          fetchImpl: impl,
          refreshToken,
          payload: { refreshToken, blockedUntil: String(Date.now() + 60_000) },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'rate_limit');
        return true;
      },
    );
    assert.equal(calls.length, 0, '持久化的 blockedUntil 应阻止任何网络请求');
  });

  it('maps 401 to a fatal SubscriptionRefreshError', async () => {
    const { impl } = routeFetch({
      [TOKEN_URL]: () => jsonResponse({ error: 'invalid_token' }, { status: 401 }),
    });
    await assert.rejects(
      () =>
        claude.refresh({
          fetchImpl: impl,
          refreshToken: 'RT-401',
          payload: { refreshToken: 'RT-401' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'fatal');
        assert.equal(error.status, 401);
        assert.equal(claude.isFatalRefreshError(error), true);
        return true;
      },
    );
  });

  it('treats a body containing invalid_grant as fatal', async () => {
    const { impl } = routeFetch({
      [TOKEN_URL]: () => jsonResponse({ error: 'invalid_grant' }, { status: 400 }),
    });
    await assert.rejects(
      () =>
        claude.refresh({
          fetchImpl: impl,
          refreshToken: 'RT-invalid-grant',
          payload: { refreshToken: 'RT-invalid-grant' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(claude.isFatalRefreshError(error), true);
        return true;
      },
    );
  });

  it('classifies other non-2xx (e.g. 500) as retryable network', async () => {
    const { impl } = routeFetch({
      [TOKEN_URL]: () => new Response('server exploded', { status: 500 }),
    });
    await assert.rejects(
      () =>
        claude.refresh({
          fetchImpl: impl,
          refreshToken: 'RT-500',
          payload: { refreshToken: 'RT-500' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'network');
        assert.equal(claude.isFatalRefreshError(error), false);
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
        claude.refresh({
          fetchImpl: failing,
          refreshToken: 'RT-network',
          payload: { refreshToken: 'RT-network' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionRefreshError);
        assert.equal(error.kind, 'network');
        assert.equal(claude.isFatalRefreshError(error), false);
        return true;
      },
    );
  });

  it('fetches the OAuth profile after refresh and maps identity into the profile/payload', async () => {
    const { impl, calls } = routeFetch({
      [TOKEN_URL]: tokenOk({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }),
      [PROFILE_URL]: profileOk(profileBody),
    });
    const result = await claude.refresh({
      fetchImpl: impl,
      refreshToken: 'RT-profile',
      payload: { accessToken: 'AT', refreshToken: 'RT-profile', subscriptionType: 'max' },
    });

    const profileCall = calls.find((call) => call.url === PROFILE_URL);
    assert.ok(profileCall, 'must GET the OAuth profile endpoint');
    const headers = profileCall.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer AT2');

    assert.equal(result.profile?.id, 'acc-uuid-1');
    assert.equal(result.profile?.email, 'dev@example.com');
    assert.equal(result.profile?.plan, 'max');
    assert.equal(result.profile?.organization, 'Acme Labs');
    assert.equal(result.payload.email, 'dev@example.com');
    assert.equal(result.payload.accountUuid, 'acc-uuid-1');
    assert.equal(result.payload.orgUuid, 'org-uuid-1');
    assert.equal(result.payload.orgName, 'Acme Labs');
  });

  it('returns the tokens even when the profile lookup is unavailable (defensive non-200)', async () => {
    const { impl } = routeFetch({
      [TOKEN_URL]: tokenOk({ access_token: 'AT2', expires_in: 3600 }),
      [PROFILE_URL]: () => new Response('nope', { status: 403 }),
    });
    const result = await claude.refresh({
      fetchImpl: impl,
      refreshToken: 'RT-profile-403',
      payload: { accessToken: 'AT', refreshToken: 'RT-profile-403' },
    });
    assert.equal(result.payload.accessToken, 'AT2');
    assert.equal(result.profile?.id, expectedDerivedId('RT-profile-403'), '退回完整 token 派生 id');
  });
});

describe('claude accountIdOf', () => {
  it('prefers payload.accountUuid', () => {
    assert.equal(
      claude.accountIdOf({ id: 'profile-id' }, { accountUuid: 'acc-uuid-1', refreshToken: 'RT' }),
      'acc-uuid-1',
    );
  });

  it('falls back to profile.id and then to the full-token derived id', () => {
    assert.equal(claude.accountIdOf({ id: 'profile-id' }, {}), 'profile-id');
    assert.equal(
      claude.accountIdOf({ id: '' }, { refreshToken: 'ABCDEFGH1234' }),
      expectedDerivedId('ABCDEFGH1234'),
    );
    assert.equal(claude.accountIdOf({ id: '' }, {}), expectedDerivedId(''));
  });

  it('derives distinct ids for tokens sharing the sk-ant-ort01- prefix', () => {
    const idA = claude.accountIdOf({ id: '' }, { refreshToken: TOKEN_A });
    const idB = claude.accountIdOf({ id: '' }, { refreshToken: TOKEN_B });
    assert.notEqual(idA, idB, '不同 refresh token 不得得到同一 account id');
    assert.equal(idA, expectedDerivedId(TOKEN_A));
    assert.equal(idB, expectedDerivedId(TOKEN_B));
    assert.notEqual(idA, `claude-${TOKEN_A.slice(0, 8)}`);
  });
});
