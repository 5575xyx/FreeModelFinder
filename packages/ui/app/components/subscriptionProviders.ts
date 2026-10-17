/**
 * 订阅 provider 的「逐家差异」元数据 —— 弹窗与磁贴都从这里取，避免三处各写一份。
 *
 * ⚠️ 端口 / 回调路径 / PKCE / 默认文件路径必须与 core 的 `SUBSCRIPTION_OAUTH`
 * （`packages/core/src/credentials/adapters/subscription/oauth-config.ts`）以及三家适配器
 * 保持一致。UI 包不依赖 core（那会把 `node:fs` 一类服务端代码拖进浏览器 bundle），
 * 所以这里是一份**有意为之的副本**：改一侧必须同步改另一侧。
 */

export type SubscriptionProvider = 'codex' | 'claude' | 'google';

export const SUBSCRIPTION_PROVIDERS: SubscriptionProvider[] = ['codex', 'claude', 'google'];

/** 登录成功后自动读取并展示的账号字段（对应各 adapter 的 `profile`）。 */
export type SubscriptionProfileField =
  'email' | 'plan' | 'accountId' | 'organization' | 'accountUuid' | 'gcpProject';

export interface SubscriptionProviderMeta {
  /** 本机回环回调端口。三家各不相同，且上游对 redirect_uri 做精确匹配。 */
  callbackPort: number;
  /** 回调路径。 */
  callbackPath: string;
  /** OAuth 是否走 PKCE S256 —— Google 的授权码流不带 PKCE。 */
  usesPkce: boolean;
  /** 官方 CLI 的凭据文件位置，作为「自动探测」的默认值。 */
  defaultPath: string;
  /** 登录后自动读取的字段（展示顺序即阅读顺序）。 */
  autoReadFields: SubscriptionProfileField[];
  /** 该家特有的补充说明（i18n key），没有则 undefined。 */
  autoReadNoteKey?: string;
}

export const SUBSCRIPTION_PROVIDER_META: Record<SubscriptionProvider, SubscriptionProviderMeta> = {
  codex: {
    callbackPort: 1455,
    callbackPath: '/auth/callback',
    usesPkce: true,
    defaultPath: '~/.codex/auth.json',
    autoReadFields: ['email', 'plan', 'accountId'],
  },
  claude: {
    callbackPort: 54545,
    callbackPath: '/callback',
    usesPkce: true,
    defaultPath: '~/.claude/.credentials.json',
    autoReadFields: ['email', 'organization', 'accountUuid'],
  },
  google: {
    callbackPort: 51121,
    callbackPath: '/oauth-callback',
    usesPkce: false,
    defaultPath: '~/.gemini/oauth_creds.json',
    autoReadFields: ['email', 'gcpProject'],
    // GCP 项目不在登录响应里，而是首次调用时由 loadCodeAssist 探测后写回账号。
    autoReadNoteKey: 'settings.subscription.dialog.gcpNote',
  },
};

export const SUBSCRIPTION_DEFAULT_PATHS: Record<SubscriptionProvider, string> = {
  codex: SUBSCRIPTION_PROVIDER_META.codex.defaultPath,
  claude: SUBSCRIPTION_PROVIDER_META.claude.defaultPath,
  google: SUBSCRIPTION_PROVIDER_META.google.defaultPath,
};
