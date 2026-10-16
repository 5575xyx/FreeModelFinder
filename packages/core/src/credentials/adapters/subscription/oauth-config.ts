import type { SubscriptionProviderId } from '../../oauth/types.js';

export interface SubscriptionOAuthConfig {
  /** 0 = 由 OS 分配端口（参考项目里 Google 那家就是 0）。 */
  callbackPort: number;
  callbackPath: string;
  /** Google 的 authorize / token 不需要 PKCE（参考项目同样如此）。 */
  usesPkce: boolean;
}

/**
 * 三家的回调端点常量。
 *
 * Codex / Claude 的端口被各自官方 OAuth 应用写死，不能改；Google 走 OS 动态分配。
 * 这些值必须与各家控制台注册的 redirect_uri 完全一致，否则授权页直接报错。
 */
export const SUBSCRIPTION_OAUTH: Record<SubscriptionProviderId, SubscriptionOAuthConfig> = {
  codex: { callbackPort: 1455, callbackPath: '/auth/callback', usesPkce: true },
  claude: { callbackPort: 54545, callbackPath: '/callback', usesPkce: true },
  google: { callbackPort: 0, callbackPath: '/oauth-callback', usesPkce: false },
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
