import type { SubscriptionAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { googleAdapter } from './google.js';

export * from './types.js';
export * from './helpers.js';
export * from './claude.js';
export * from './codex.js';
export * from './google.js';

/** 三家订阅平台均已接入真实适配器（codex / claude / google）。 */
export const SUBSCRIPTION_ADAPTERS: Record<'codex' | 'claude' | 'google', SubscriptionAdapter> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  google: googleAdapter,
};
