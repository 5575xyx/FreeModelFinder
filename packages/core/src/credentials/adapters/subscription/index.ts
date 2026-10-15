import type { ParsedSubscription, RefreshResult, SubscriptionAdapter } from './types.js';
import { SubscriptionImportError } from './types.js';
import { codexAdapter } from './codex.js';

export * from './types.js';
export * from './helpers.js';
export * from './codex.js';

/**
 * 占位适配器：Task 6/8 将逐个替换 claude/google 条目。
 * parseImport/refresh 均抛 SubscriptionImportError('not implemented')。
 */
function placeholderAdapter(platform: SubscriptionAdapter['platform']): SubscriptionAdapter {
  return {
    platform,
    parseImport(): ParsedSubscription {
      throw new SubscriptionImportError('not implemented');
    },
    async refresh(): Promise<RefreshResult> {
      throw new SubscriptionImportError('not implemented');
    },
    isFatalRefreshError(): boolean {
      return false;
    },
    accountIdOf(): string {
      return `placeholder:${platform}`;
    },
  };
}

export const SUBSCRIPTION_ADAPTERS: Record<'codex' | 'claude' | 'google', SubscriptionAdapter> = {
  codex: codexAdapter,
  claude: placeholderAdapter('claude'),
  google: placeholderAdapter('google'),
};
