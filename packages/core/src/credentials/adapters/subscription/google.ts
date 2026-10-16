import { createHash } from 'node:crypto';
import { decodeJwtPayload } from './helpers.js';
import type {
  ParsedSubscription,
  RefreshResult,
  SubscriptionAccountProfile,
  SubscriptionAdapter,
} from './types.js';
import { SubscriptionImportError, SubscriptionRefreshError } from './types.js';

const PLATFORM = 'google' as const;
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json';
/**
 * 交互登录用参考项目（Antigravity）注册的固定 OAuth 应用；client_secret 只在 token 端点使用。
 * 与 parseImport 那条"文件内自带 client_secret"的路径互不影响（spec §5.3）。
 */
const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');
/** 派生 id 使用的摘要长度（hex 字符数） */
const RT_ID_DIGEST_LEN = 12;
const DETAIL_LIMIT = 300;

/** payload 键集合（契约见 spec §5.3）：clientSecret 命中 credential-store 的加密白名单 */
const PAYLOAD_KEYS = [
  'accessToken',
  'refreshToken',
  'clientId',
  'clientSecret',
  'expiresAt',
  'scope',
  'idToken',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringifyScalar(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * 对完整 refresh token 取 sha256 摘要。
 * Google 的 refresh token 前缀（`1//0...`）不保证唯一，按前缀截断会让不同账号派生出同一
 * account id 而互相覆盖；必须哈希全文。摘要非加密用途，仅求前缀分散。
 */
function refreshTokenDigest(refreshToken: string): string {
  return createHash('sha256').update(refreshToken.trim()).digest('hex');
}

function derivedId(refreshToken: string): string {
  return `google-${refreshTokenDigest(refreshToken).slice(0, RT_ID_DIGEST_LEN)}`;
}

/**
 * Google 没有账号级 id 来源（不像 codex 的 account_id / claude 的 account uuid），
 * 唯一稳定的身份来自 refresh token 本身。
 */
function profileFromRefreshToken(refreshToken: string): SubscriptionAccountProfile {
  return { id: derivedId(refreshToken) };
}

/**
 * id_token 的 email 声明仅用于展示（不验签、非权威）。
 * 本地解码，不发任何网络请求；畸形 token 返回 undefined。
 */
function emailFromIdToken(idToken: string): string | undefined {
  const claims = idToken ? decodeJwtPayload(idToken) : null;
  if (!claims) return undefined;
  return asNonEmptyString(claims.email);
}

/**
 * 取 userinfo 的 email（参考项目 `FetchUserInfo`）。
 *
 * 只用于展示，不参与任何鉴权判定，所以失败一律降级为 undefined，绝不因此让登录失败。
 */
async function fetchUserInfoEmail(
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(USERINFO_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const data = asRecord(await response.json());
    return data ? asNonEmptyString(data.email) : undefined;
  } catch {
    return undefined;
  }
}

export const googleAdapter: SubscriptionAdapter = {
  platform: PLATFORM,

  parseImport(raw: string): ParsedSubscription {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SubscriptionImportError('google: oauth_creds.json is not valid JSON');
    }
    const root = asRecord(parsed);
    if (!root) {
      throw new SubscriptionImportError('google: oauth_creds.json must be a JSON object');
    }
    const refreshToken = asNonEmptyString(root.refresh_token);
    if (!refreshToken) {
      throw new SubscriptionImportError(
        'google: oauth_creds.json must contain a non-empty refresh_token',
      );
    }
    // spec §5.3 决策：文件内缺少可用 client_secret 时直接报错，不猜、不内置 Antigravity secret
    const clientSecret = asNonEmptyString(root.client_secret);
    if (!clientSecret) {
      throw new SubscriptionImportError(
        'google: oauth_creds.json must contain a client_secret (it is required to refresh tokens)',
      );
    }

    const idToken = asNonEmptyString(root.id_token) ?? '';
    const profile = profileFromRefreshToken(refreshToken);
    const email = emailFromIdToken(idToken);
    return {
      payload: {
        accessToken: asNonEmptyString(root.access_token) ?? '',
        refreshToken,
        clientId: asNonEmptyString(root.client_id) ?? '',
        clientSecret,
        expiresAt: stringifyScalar(root.expiry_date) ?? '',
        scope: asNonEmptyString(root.scope) ?? '',
        idToken,
      },
      profile: { ...profile, ...(email ? { email } : {}) },
    };
  },

  async refresh(opts: {
    fetchImpl?: typeof fetch;
    refreshToken: string;
    payload: Record<string, string>;
  }): Promise<RefreshResult> {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: opts.payload.clientId ?? '',
          client_secret: opts.payload.clientSecret ?? '',
          refresh_token: opts.refreshToken,
        }).toString(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SubscriptionRefreshError(`google: token refresh network error: ${detail}`, {
        kind: 'network',
      });
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
      throw new SubscriptionRefreshError('google: token refresh rate limited', {
        kind: 'rate_limit',
        status: 429,
        ...(Number.isFinite(seconds) && seconds >= 0
          ? { resetAt: Date.now() + seconds * 1000 }
          : {}),
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // invalid_grant = refresh token 已被撤销/过期，重试无用
      const fatal = response.status === 400 && /invalid_grant/.test(body);
      throw new SubscriptionRefreshError(
        `google: token refresh failed ${response.status}: ${body.slice(0, DETAIL_LIMIT)}`,
        { kind: fatal ? 'fatal' : 'network', status: response.status },
      );
    }

    let data: Record<string, unknown> | null;
    try {
      data = asRecord(await response.json());
    } catch {
      data = null;
    }
    const accessToken = data ? asNonEmptyString(data.access_token) : undefined;
    if (!data || !accessToken) {
      throw new SubscriptionRefreshError('google: token refresh returned an unexpected body', {
        kind: 'network',
        status: response.status,
      });
    }

    const expiresIn =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in
        : undefined;
    const payload: Record<string, string> = {
      ...opts.payload,
      accessToken,
      // Google 不轮换 refresh token：忽略响应里可能出现的 refresh_token
      refreshToken: opts.refreshToken,
      expiresAt:
        expiresIn !== undefined
          ? String(Date.now() + expiresIn * 1000)
          : (opts.payload.expiresAt ?? ''),
    };
    // 保证 payload 键集合恒定为契约中的 7 个键
    for (const key of PAYLOAD_KEYS) payload[key] = payload[key] ?? '';
    // Google 无独立 profile 端点：不请求、不返回 profile 更新
    return { payload };
  },

  isFatalRefreshError(error: unknown): boolean {
    return error instanceof SubscriptionRefreshError && error.kind === 'fatal';
  },

  accountIdOf(_profile: SubscriptionAccountProfile, payload: Record<string, string>): string {
    return derivedId(payload.refreshToken ?? '');
  },

  buildAuthUrl(opts: { state: string; redirectUri: string; verifier?: string }): string {
    const params = new URLSearchParams({
      // offline + consent 保证每次都下发 refresh_token（否则二次登录拿不到）
      access_type: 'offline',
      client_id: OAUTH_CLIENT_ID,
      prompt: 'consent',
      redirect_uri: opts.redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPES,
      state: opts.state,
    });
    // 刻意不带 PKCE —— Google 这家不用（参考项目 antigravity/auth.go:146-154）
    return `${AUTHORIZE_URL}?${params.toString()}`;
  },

  async exchangeCode(opts: {
    code: string;
    redirectUri: string;
    verifier?: string;
    state?: string;
    fetchImpl?: typeof fetch;
  }): Promise<ParsedSubscription> {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: opts.code,
          client_id: OAUTH_CLIENT_ID,
          client_secret: OAUTH_CLIENT_SECRET,
          redirect_uri: opts.redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SubscriptionImportError(`google: token exchange network error: ${detail}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SubscriptionImportError(
        `google: token exchange failed ${response.status}: ${text.slice(0, DETAIL_LIMIT)}`,
      );
    }

    let data: Record<string, unknown> | null;
    try {
      data = asRecord(await response.json());
    } catch {
      data = null;
    }
    const accessToken = data ? asNonEmptyString(data.access_token) : undefined;
    if (!data || !accessToken) {
      throw new SubscriptionImportError('google: token exchange returned an unexpected body');
    }
    const refreshToken = asNonEmptyString(data.refresh_token);
    if (!refreshToken) {
      // 没有 refresh token 的账号一小时后就不可用；唯一的身份来源也是它，不能当成功
      throw new SubscriptionImportError('google: token exchange returned no refresh_token');
    }

    const expiresIn =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in
        : undefined;
    const expiresAt = expiresIn !== undefined ? String(Date.now() + expiresIn * 1000) : '';
    const email = await fetchUserInfoEmail(fetchImpl, accessToken);

    return {
      payload: {
        accessToken,
        refreshToken,
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
        expiresAt,
        scope: asNonEmptyString(data.scope) ?? OAUTH_SCOPES,
        idToken: asNonEmptyString(data.id_token) ?? '',
      },
      profile: {
        ...profileFromRefreshToken(refreshToken),
        ...(email ? { email } : {}),
      },
    };
  },
};
