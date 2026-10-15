import { redact } from '../../redact.js';

export interface SubscriptionAdapter {
  readonly platform: 'codex' | 'claude' | 'google';
  /** 解析用户导入的原始凭据串；失败抛 SubscriptionImportError */
  parseImport(raw: string): ParsedSubscription;
  /** 刷新令牌并返回新 payload；失败抛 SubscriptionRefreshError */
  refresh(opts: {
    fetchImpl?: typeof fetch;
    refreshToken: string;
    payload: Record<string, string>;
  }): Promise<RefreshResult>;
  /** true = 账号永久失效（invalid_grant 等），应剔除 */
  isFatalRefreshError(error: unknown): boolean;
  accountIdOf(profile: SubscriptionAccountProfile, payload: Record<string, string>): string;
}

export interface ParsedSubscription {
  payload: Record<string, string>;
  profile: SubscriptionAccountProfile;
}

export interface RefreshResult {
  payload: Record<string, string>;
  profile?: SubscriptionAccountProfile;
}

export interface SubscriptionAccountProfile {
  id: string;
  email?: string;
  plan?: string;
  organization?: string;
}

export class SubscriptionImportError extends Error {
  constructor(message: string) {
    super(redact(message));
    this.name = 'SubscriptionImportError';
  }
}

export class SubscriptionRefreshError extends Error {
  readonly kind: 'fatal' | 'rate_limit' | 'network';
  readonly status?: number;
  readonly resetAt?: number;

  constructor(
    message: string,
    options: { kind: 'fatal' | 'rate_limit' | 'network'; status?: number; resetAt?: number },
  ) {
    super(redact(message));
    this.name = 'SubscriptionRefreshError';
    this.kind = options.kind;
    this.status = options.status;
    this.resetAt = options.resetAt;
  }
}

/** 刷新提前量：过期时间早于此窗口内即视为需要刷新 */
export const REFRESH_SKEW_MS = 60_000;
