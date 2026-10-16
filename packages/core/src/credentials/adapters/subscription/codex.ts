import { pkceChallenge } from '../../oauth/pkce.js';
import { decodeJwtPayload, describeFetchFailure } from './helpers.js';
import type {
  ParsedSubscription,
  RefreshResult,
  SubscriptionAdapter,
  SubscriptionAccountProfile,
} from './types.js';
import { SubscriptionImportError, SubscriptionRefreshError } from './types.js';

const PLATFORM = 'codex' as const;
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email';
/** 交互登录的 scope 与刷新不同：必须带 offline_access，否则拿不到 refresh_token。 */
const AUTH_SCOPE = 'openid email profile offline_access';
const ACCOUNT_ID_MAX = 32;
const DETAIL_LIMIT = 300;
/** ChatGPT OIDC 自定义声明命名空间 */
const AUTH_CLAIMS_KEY = 'https://api.openai.com/auth';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** 从 id_token claims 提取身份：email（顶层）、plan/稳定账号 id（auth 命名空间声明） */
function profileFromIdToken(
  idToken: string | undefined,
  fallbackAccountId: string,
): SubscriptionAccountProfile {
  const claims = idToken ? decodeJwtPayload(idToken) : null;
  const authClaims = claims ? asRecord(claims[AUTH_CLAIMS_KEY]) : null;
  const email = claims ? asNonEmptyString(claims.email) : undefined;
  const plan = authClaims ? asNonEmptyString(authClaims.chatgpt_plan_type) : undefined;
  const id =
    (authClaims &&
      (asNonEmptyString(authClaims.chatgpt_account_id) ??
        asNonEmptyString(authClaims.auth_user_id))) ??
    fallbackAccountId;
  return { id, ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
}

export const codexAdapter: SubscriptionAdapter = {
  platform: PLATFORM,

  parseImport(raw: string): ParsedSubscription {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SubscriptionImportError('codex: auth.json is not valid JSON');
    }
    const root = asRecord(parsed);
    const tokens = root ? asRecord(root.tokens) : null;
    const accessToken = tokens ? asNonEmptyString(tokens.access_token) : undefined;
    const refreshToken = tokens ? asNonEmptyString(tokens.refresh_token) : undefined;
    if (!tokens || !accessToken || !refreshToken) {
      throw new SubscriptionImportError(
        'codex: auth.json must contain tokens.access_token and tokens.refresh_token',
      );
    }
    const idToken = asNonEmptyString(tokens.id_token);
    const accountId = asNonEmptyString(tokens.account_id) ?? '';
    const profile = profileFromIdToken(idToken, accountId);
    return {
      payload: {
        accessToken,
        refreshToken,
        idToken: idToken ?? '',
        accountId,
        email: profile.email ?? '',
        plan: profile.plan ?? '',
        expiresAt: '', // 未知 → parseExpiryMs 视同过期，首次使用强制刷新
      },
      profile,
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
          client_id: CLIENT_ID,
          refresh_token: opts.refreshToken,
          scope: SCOPE,
        }).toString(),
      });
    } catch (error) {
      const detail = describeFetchFailure(error);
      throw new SubscriptionRefreshError(`codex: token refresh network error: ${detail}`, {
        kind: 'network',
      });
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
      throw new SubscriptionRefreshError('codex: token refresh rate limited', {
        kind: 'rate_limit',
        status: 429,
        ...(Number.isFinite(seconds) && seconds >= 0
          ? { resetAt: Date.now() + seconds * 1000 }
          : {}),
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const fatal = response.status === 400 && /refresh_token_reused|invalid_grant/.test(body);
      throw new SubscriptionRefreshError(
        `codex: token refresh failed ${response.status}: ${body.slice(0, DETAIL_LIMIT)}`,
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
      throw new SubscriptionRefreshError('codex: token refresh returned an unexpected body', {
        kind: 'network',
        status: response.status,
      });
    }

    const refreshToken =
      (data ? asNonEmptyString(data.refresh_token) : undefined) ?? opts.refreshToken; // 未轮换则沿用旧值
    const idToken =
      (data ? asNonEmptyString(data.id_token) : undefined) ?? opts.payload.idToken ?? '';
    const expiresIn =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in
        : undefined;
    const expiresAt = expiresIn !== undefined ? String(Date.now() + expiresIn * 1000) : '';
    const profile = profileFromIdToken(idToken, opts.payload.accountId ?? '');
    return {
      payload: {
        ...opts.payload,
        accessToken,
        refreshToken,
        idToken,
        email: profile.email ?? opts.payload.email ?? '',
        plan: profile.plan ?? opts.payload.plan ?? '',
        expiresAt,
      },
      profile,
    };
  },

  isFatalRefreshError(error: unknown): boolean {
    return error instanceof SubscriptionRefreshError && error.kind === 'fatal';
  },

  accountIdOf(profile: SubscriptionAccountProfile, payload: Record<string, string>): string {
    const id = profile.id.trim();
    return id || (payload.accountId ?? '').slice(0, ACCOUNT_ID_MAX);
  },

  buildAuthUrl(opts: { state: string; redirectUri: string; verifier?: string }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', opts.redirectUri);
    url.searchParams.set('scope', AUTH_SCOPE);
    url.searchParams.set('state', opts.state);
    // 参考项目原生客户端的三个附加参数：prompt=login 强制重新登录（多账号场景必需），
    // id_token_add_organizations 让 id_token 带上组织声明，codex_cli_simplified_flow 走简化流程。
    url.searchParams.set('prompt', 'login');
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    if (opts.verifier) {
      url.searchParams.set('code_challenge', pkceChallenge(opts.verifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  },

  async exchangeCode(opts: {
    code: string;
    redirectUri: string;
    verifier?: string;
    fetchImpl?: typeof fetch;
  }): Promise<ParsedSubscription> {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    // Codex 的 token 端点只吃 form-urlencoded——这点与 Claude 的 JSON body 不同。
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    });
    if (opts.verifier) body.set('code_verifier', opts.verifier);

    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      const detail = describeFetchFailure(error);
      throw new SubscriptionImportError(`codex: token exchange network error: ${detail}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SubscriptionImportError(
        `codex: token exchange failed ${response.status}: ${text.slice(0, DETAIL_LIMIT)}`,
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
    if (!data || !accessToken || !refreshToken) {
      throw new SubscriptionImportError('codex: token exchange returned an unexpected body');
    }

    const idToken = asNonEmptyString(data.id_token) ?? '';
    const expiresIn =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in
        : undefined;
    const expiresAt = expiresIn !== undefined ? String(Date.now() + expiresIn * 1000) : '';
    const profile = profileFromIdToken(idToken || undefined, '');
    return {
      payload: {
        accessToken,
        refreshToken,
        idToken,
        accountId: profile.id,
        email: profile.email ?? '',
        plan: profile.plan ?? '',
        expiresAt,
      },
      profile,
    };
  },
};
