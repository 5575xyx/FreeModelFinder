/**
 * 订阅类 provider 的标识。
 *
 * 参考项目 CLIProxyAPI 里 Google 那家叫 `antigravity`；本仓内部统一叫 `google`，
 * 由 `adapters/subscription/oauth-config.ts` 的归一化函数负责别名映射。
 */
export type SubscriptionProviderId = 'codex' | 'claude' | 'google';

/** 对齐参考项目 `GetAuthStatus` 的三态：等待 / 完成 / 失败。 */
export type OAuthSessionStatus = 'wait' | 'ok' | 'error';

export interface OAuthSessionSnapshot {
  provider: SubscriptionProviderId;
  status: OAuthSessionStatus;
  error?: string;
  redirectUri: string;
  createdAt: number;
}

export interface OAuthSessionRecord extends OAuthSessionSnapshot {
  /** PKCE code_verifier；不启用 PKCE 的 provider（Google）恒为 undefined。 */
  verifier?: string;
}
