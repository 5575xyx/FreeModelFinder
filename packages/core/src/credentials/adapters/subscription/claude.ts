import type {
  ParsedSubscription,
  RefreshResult,
  SubscriptionAdapter,
  SubscriptionAccountProfile,
} from './types.js';
import { SubscriptionImportError, SubscriptionRefreshError } from './types.js';

const PLATFORM = 'claude' as const;
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
/** 派生 id 时截取的 refresh token 前缀长度（同时也是 block map 的键） */
const RT_PREFIX = 8;
const DETAIL_LIMIT = 300;

/**
 * 按 refresh token 前缀记录的冷却表（spec §5.2）。
 * 只保留前 8 位，避免长期持有完整 token；进程重启后由 payload.blockedUntil 接续。
 */
const claudeRefreshBlock = new Map<string, number>();

function blockKey(refreshToken: string): string {
  return refreshToken.trim().slice(0, RT_PREFIX);
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
  return `claude-${refreshToken.trim().slice(0, RT_PREFIX)}`;
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
      const detail = error instanceof Error ? error.message : String(error);
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

  accountIdOf(profile: SubscriptionAccountProfile, payload: Record<string, string>): string {
    const accountUuid = (payload.accountUuid ?? '').trim();
    if (accountUuid) return accountUuid;
    const fromProfile = profile.id.trim();
    if (fromProfile) return fromProfile;
    return derivedId(payload.refreshToken ?? '');
  },
};
