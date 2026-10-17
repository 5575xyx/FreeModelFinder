import { createHash } from 'node:crypto';
import { pkceChallenge } from '../../oauth/pkce.js';
import type {
  ParsedSubscription,
  RefreshResult,
  SubscriptionAdapter,
  SubscriptionAccountProfile,
} from './types.js';
import { describeFetchFailure } from './helpers.js';
import { SubscriptionImportError, SubscriptionRefreshError } from './types.js';

const PLATFORM = 'claude' as const;
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
/** 原生 Claude Code 走 axios，控制面据此放行；普通 Node fetch UA 可能被 Cloudflare 拒绝 */
const AXIOS_UA = 'axios/1.15.2';
const ACCEPT = 'application/json, text/plain, */*';
const RETRY_AFTER_MS_HEADER = 'retry-after-ms';
const RETRY_AFTER_HEADER = 'retry-after';
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** 完整 refresh token 摘要截取长度（既是 block map 的键，也是派生 id 的可见后缀） */
const RT_DIGEST_LEN = 16;
/** 派生 id 使用的摘要长度，比 block key 短，保持 id 可读性 */
const RT_ID_DIGEST_LEN = 12;
const DETAIL_LIMIT = 300;

/**
 * 对完整 refresh token 取 sha256 摘要。
 * 必须哈希全文：真实 Claude OAuth refresh token 共享常量前缀 `sk-ant-ort01-`，
 * 若只看前 8 位，所有账号会塌缩成同一个键 —— 账号 A 的 429 冷却会误伤账号 B，
 * 且多个账号会派生出相同的 account id 而互相覆盖。摘要函数非加密用途，仅求前缀分散。
 */
function refreshTokenDigest(refreshToken: string): string {
  return createHash('sha256').update(refreshToken.trim()).digest('hex');
}

/**
 * 按 refresh token 摘要记录的冷却表（spec §5.2）。
 * 只保留定长摘要，避免长期持有完整 token；进程重启后由 payload.blockedUntil 接续。
 */
const claudeRefreshBlock = new Map<string, number>();

function blockKey(refreshToken: string): string {
  return refreshTokenDigest(refreshToken).slice(0, RT_DIGEST_LEN);
}

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

function derivedId(refreshToken: string): string {
  return `claude-${refreshTokenDigest(refreshToken).slice(0, RT_ID_DIGEST_LEN)}`;
}

function clampBackoff(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_BACKOFF_MS;
  return Math.min(Math.max(ms, MIN_BACKOFF_MS), MAX_BACKOFF_MS);
}

/** Retry-After（秒/HTTP 日期）优先，其次 Retry-After-Ms；均缺省回退 5s；结果 clamp 到 5s–5min */
function parseRetryAfterMs(headers: Headers, now: number): number {
  const retryAfter = headers.get(RETRY_AFTER_HEADER)?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return clampBackoff(seconds * 1000);
    const when = Date.parse(retryAfter);
    if (!Number.isNaN(when)) return clampBackoff(when - now);
  }
  const retryAfterMs = headers.get(RETRY_AFTER_MS_HEADER)?.trim();
  if (retryAfterMs) {
    const ms = Number(retryAfterMs);
    if (Number.isFinite(ms) && ms >= 0) return clampBackoff(ms);
  }
  return MIN_BACKOFF_MS;
}

function parseBlockedUntil(payload: Record<string, string>): number {
  const raw = Number(payload.blockedUntil ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * 拆开回调 code 里可能附带的 `#state` 片段。
 *
 * 对齐参考项目 `(*ClaudeAuth).parseCodeAndState`（anthropic_auth.go:352-359）：Anthropic 的
 * 回调有时把 state 拼在 code 后面而不是作为独立查询参数。
 */
function splitCodeAndState(raw: string): [code: string, fragmentState: string] {
  const index = raw.indexOf('#');
  if (index < 0) return [raw, ''];
  return [raw.slice(0, index), raw.slice(index + 1)];
}

interface ProfileInfo {
  id: string;
  email?: string;
  accountUuid?: string;
  organization?: string;
  orgUuid?: string;
  orgName?: string;
}

/** 解析 profile 响应；任何异常/非 200 都返回 null（profile 是尽力而为的辅助信息） */
async function fetchProfile(
  fetchImpl: typeof fetch,
  accessToken: string,
  fallbackId: string,
): Promise<ProfileInfo | null> {
  try {
    const response = await fetchImpl(PROFILE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: ACCEPT,
        'User-Agent': AXIOS_UA,
      },
    });
    if (!response.ok) return null;
    const data = asRecord(await response.json());
    if (!data) return null;
    const account = asRecord(data.account);
    const organization = asRecord(data.organization);
    const accountUuid = account ? asNonEmptyString(account.uuid) : undefined;
    const email = account ? asNonEmptyString(account.email) : undefined;
    const orgUuid = organization ? asNonEmptyString(organization.uuid) : undefined;
    const orgName = organization ? asNonEmptyString(organization.name) : undefined;
    return {
      id: accountUuid ?? fallbackId,
      ...(email ? { email } : {}),
      ...(accountUuid ? { accountUuid } : {}),
      ...(orgName ? { organization: orgName, orgName } : {}),
      ...(orgUuid ? { orgUuid } : {}),
    };
  } catch {
    return null;
  }
}

export const claudeAdapter: SubscriptionAdapter = {
  platform: PLATFORM,

  parseImport(raw: string): ParsedSubscription {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SubscriptionImportError('claude: .credentials.json is not valid JSON');
    }
    const root = asRecord(parsed);
    const oauth = root ? asRecord(root.claudeAiOauth) : null;
    if (!oauth) {
      throw new SubscriptionImportError(
        'claude: .credentials.json must contain a claudeAiOauth block',
      );
    }
    const refreshToken = asNonEmptyString(oauth.refreshToken);
    if (!refreshToken) {
      throw new SubscriptionImportError('claude: claudeAiOauth must contain a refreshToken');
    }
    const accessToken = asNonEmptyString(oauth.accessToken) ?? '';
    const expiresAt = stringifyScalar(oauth.expiresAt) ?? '';
    const subscriptionType = stringifyScalar(oauth.subscriptionType) ?? '';
    const scopes = Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string').join(' ')
      : '';
    const email = asNonEmptyString(oauth.email) ?? '';
    const accountUuid = asNonEmptyString(oauth.accountUuid) ?? '';
    const orgUuid = asNonEmptyString(oauth.orgUuid) ?? '';
    const orgName = asNonEmptyString(oauth.orgName) ?? '';
    const id = accountUuid || derivedId(refreshToken);
    return {
      payload: {
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
        subscriptionType,
        email,
        accountUuid,
        orgUuid,
        orgName,
        blockedUntil: '',
      },
      profile: {
        id,
        ...(email ? { email } : {}),
        ...(subscriptionType ? { plan: subscriptionType } : {}),
        ...(orgName ? { organization: orgName } : {}),
      },
    };
  },

  async refresh(opts: {
    fetchImpl?: typeof fetch;
    refreshToken: string;
    payload: Record<string, string>;
  }): Promise<RefreshResult> {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const key = blockKey(opts.refreshToken);
    const blockedUntil = Math.max(
      claudeRefreshBlock.get(key) ?? 0,
      parseBlockedUntil(opts.payload),
    );
    const now = Date.now();
    if (blockedUntil > now) {
      // 冷却期内直接失败，绝不再打网络（spec §5.2）
      throw new SubscriptionRefreshError('claude: token refresh temporarily blocked', {
        kind: 'rate_limit',
        status: 429,
        resetAt: blockedUntil,
      });
    }

    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: ACCEPT,
          'User-Agent': AXIOS_UA,
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: opts.refreshToken,
          scope: SCOPE,
        }),
      });
    } catch (error) {
      const detail = describeFetchFailure(error);
      throw new SubscriptionRefreshError(`claude: token refresh network error: ${detail}`, {
        kind: 'network',
      });
    }

    if (response.status === 429) {
      const until = Date.now() + parseRetryAfterMs(response.headers, Date.now());
      claudeRefreshBlock.set(key, until);
      // 同时落到 payload，供进程重启后继续生效
      opts.payload.blockedUntil = String(until);
      throw new SubscriptionRefreshError('claude: token refresh rate limited', {
        kind: 'rate_limit',
        status: 429,
        resetAt: until,
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const fatal =
        response.status === 401 || response.status === 403 || /invalid_grant/.test(body);
      throw new SubscriptionRefreshError(
        `claude: token refresh failed ${response.status}: ${body.slice(0, DETAIL_LIMIT)}`,
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
      throw new SubscriptionRefreshError('claude: token refresh returned an unexpected body', {
        kind: 'network',
        status: response.status,
      });
    }

    // 成功 → 解除冷却
    claudeRefreshBlock.delete(key);
    // Claude 不总是轮换 refresh token；响应缺字段时沿用旧值
    const refreshToken = asNonEmptyString(data.refresh_token) ?? opts.refreshToken;
    const expiresIn =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in
        : undefined;
    const expiresAt =
      expiresIn !== undefined
        ? String(Date.now() + expiresIn * 1000)
        : (opts.payload.expiresAt ?? '');

    const info = await fetchProfile(fetchImpl, accessToken, derivedId(refreshToken));
    const subscriptionType = opts.payload.subscriptionType;
    const payload: Record<string, string> = {
      ...opts.payload,
      accessToken,
      refreshToken,
      expiresAt,
      blockedUntil: '',
    };
    if (info?.email) payload.email = info.email;
    if (info?.accountUuid) payload.accountUuid = info.accountUuid;
    if (info?.orgUuid) payload.orgUuid = info.orgUuid;
    if (info?.orgName) payload.orgName = info.orgName;

    const profile: SubscriptionAccountProfile = {
      id: info?.id ?? (opts.payload.accountUuid || derivedId(refreshToken)),
      ...(info?.email ? { email: info.email } : {}),
      ...(subscriptionType ? { plan: subscriptionType } : {}),
      ...(info?.organization ? { organization: info.organization } : {}),
    };
    return { payload, profile };
  },

  isFatalRefreshError(error: unknown): boolean {
    return error instanceof SubscriptionRefreshError && error.kind === 'fatal';
  },

  /**
   * 账号 id 优先级：payload.accountUuid → profile.id → 完整 refresh token 的 sha256 派生 id。
   * 末级回退必须依赖完整 token（而非前 8 位），否则共享 `sk-ant-ort01-` 前缀的账号会撞成同一 id。
   */
  accountIdOf(profile: SubscriptionAccountProfile, payload: Record<string, string>): string {
    const accountUuid = (payload.accountUuid ?? '').trim();
    if (accountUuid) return accountUuid;
    const fromProfile = profile.id.trim();
    if (fromProfile) return fromProfile;
    return derivedId(payload.refreshToken ?? '');
  },

  buildAuthUrl(opts: { state: string; redirectUri: string; verifier?: string }): string {
    const params = new URLSearchParams({
      // 参考项目原生客户端的固定参数
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: opts.redirectUri,
      scope: SCOPE,
      state: opts.state,
    });
    if (opts.verifier) {
      params.set('code_challenge', pkceChallenge(opts.verifier));
      params.set('code_challenge_method', 'S256');
    }
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
    const [code, fragmentState] = splitCodeAndState(opts.code);

    // 字段顺序有意为之：复刻原生 Claude Code 2.1.220 在线上发出的 key 顺序
    //（参考项目 anthropic_auth.go:150-157），避免序列化出的 body 字节与官方不一致。
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: opts.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: opts.verifier ?? '',
      // code 里 `#` 之后的片段优先于调用方传入的 state
      state: fragmentState || opts.state || '',
    };

    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: ACCEPT,
          'User-Agent': AXIOS_UA,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const detail = describeFetchFailure(error);
      throw new SubscriptionImportError(`claude: token exchange network error: ${detail}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SubscriptionImportError(
        `claude: token exchange failed ${response.status}: ${text.slice(0, DETAIL_LIMIT)}`,
      );
    }

    let data: Record<string, unknown> | null;
    try {
      data = asRecord(await response.json());
    } catch {
      data = null;
    }
    const accessToken = data ? asNonEmptyString(data.access_token) : undefined;
    const refreshToken = data ? asNonEmptyString(data.refresh_token) : undefined;
    if (!data || !accessToken) {
      throw new SubscriptionImportError('claude: token exchange returned an unexpected body');
    }
    if (!refreshToken) {
      // 没有 refresh token 的账号用完就废，不能当作登录成功落库
      throw new SubscriptionImportError('claude: token exchange returned no refresh_token');
    }

    // 身份优先取 token 响应（参考项目 tokenResponse），再让 profile 查询的非空字段覆盖
    //（参考项目 inspectOAuthAccount：profile 是尽力而为，失败只告警）
    const account = asRecord(data.account);
    const organization = asRecord(data.organization);
    let email = account ? (asNonEmptyString(account.email_address) ?? '') : '';
    let accountUuid = account ? (asNonEmptyString(account.uuid) ?? '') : '';
    let orgUuid = organization ? (asNonEmptyString(organization.uuid) ?? '') : '';
    let orgName = organization ? (asNonEmptyString(organization.name) ?? '') : '';
    const info = await fetchProfile(fetchImpl, accessToken, derivedId(refreshToken));
    if (info) {
      if (info.email) email = info.email;
      if (info.accountUuid) accountUuid = info.accountUuid;
      if (info.orgUuid) orgUuid = info.orgUuid;
      if (info.orgName) orgName = info.orgName;
    }

    const expiresIn =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in
        : undefined;
    const expiresAt = expiresIn !== undefined ? String(Date.now() + expiresIn * 1000) : '';

    return {
      payload: {
        accessToken,
        refreshToken,
        expiresAt,
        scopes: SCOPE,
        subscriptionType: '',
        email,
        accountUuid,
        orgUuid,
        orgName,
        blockedUntil: '',
      },
      profile: {
        id: accountUuid || derivedId(refreshToken),
        ...(email ? { email } : {}),
        ...(orgName ? { organization: orgName } : {}),
      },
    };
  },
};
