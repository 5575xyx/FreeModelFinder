import type { SubscriptionProviderId } from '../../oauth/types.js';

export interface SubscriptionOAuthConfig {
  /**
   * 回调端口。0 = 由 OS 分配。
   *
   * 三家都用参考项目写死的端口：Google 用的 51121 是 Antigravity 客户端注册的回环端口，
   * 写死它在 "Desktop app" / "Web application" 两种 client 类型下都成立，
   * 而动态端口只在 Desktop 类型下被 Google 放行 —— 所以不冒这个险。
   */
  callbackPort: number;
  callbackPath: string;
  /** Google 的 authorize / token 不需要 PKCE（参考项目同样如此）。 */
  usesPkce: boolean;
}

/**
 * 三家的回调端点常量。
 *
 * 这些值必须与各家注册的 redirect_uri 完全一致，否则授权页直接报错。
 */
export const SUBSCRIPTION_OAUTH: Record<SubscriptionProviderId, SubscriptionOAuthConfig> = {
  codex: { callbackPort: 1455, callbackPath: '/auth/callback', usesPkce: true },
  claude: { callbackPort: 54545, callbackPath: '/callback', usesPkce: true },
  google: { callbackPort: 51121, callbackPath: '/oauth-callback', usesPkce: false },
};

/** 对外接受的 provider 别名 → 本仓内部 ProviderId。 */
const PROVIDER_ALIASES: Record<string, SubscriptionProviderId> = {
  codex: 'codex',
  claude: 'claude',
  google: 'google',
  // 参考项目 CLIProxyAPI 把 Google 那家叫 antigravity；端点必须兼容这个叫法。
  antigravity: 'google',
};

/**
 * 归一化 provider 查询参数。
 *
 * 对齐参考项目对 provider 查询参数做 `ToLower(TrimSpace)` 的处理；
 * 无法识别时返回 null，由调用方决定回什么状态码。
 */
export function normalizeSubscriptionProvider(value: string): SubscriptionProviderId | null {
  return PROVIDER_ALIASES[value.trim().toLowerCase()] ?? null;
}
