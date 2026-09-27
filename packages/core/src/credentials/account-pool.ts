import type { CredentialAccountEntry, CredentialPlatform, CredentialPoolConfig } from '../types.js';
import type { CoolingMap } from './cooling-map.js';

export interface AccountPoolOptions {
  getPool(platform: CredentialPlatform): CredentialPoolConfig | undefined;
  cooling(platform: CredentialPlatform): CoolingMap;
  onAccountChange?(
    platform: CredentialPlatform,
    entry: CredentialAccountEntry,
    kind: 'meta' | 'status',
  ): void;
  random?: () => number;
  now?: () => number;
}

export interface ReportRateLimitOptions {
  resetAt?: number;
  message?: string;
}

export class AccountPool {
  private cursors = new Map<CredentialPlatform, number>();

  constructor(private readonly options: AccountPoolOptions) {}

  next(platform: CredentialPlatform, model: string): CredentialAccountEntry | null {
    const config = this.options.getPool(platform);
    const accounts = config?.accounts ?? [];
    if (accounts.length === 0) return null;
    const cooling = this.options.cooling(platform);
    const now = this.now();
    const available = accounts.filter(
      (entry) => entry.status === 'active' && !cooling.active(entry.id, model, now),
    );
    if (available.length === 0) return null;

    const strategy = config?.strategy ?? 'round_robin';
    let picked: CredentialAccountEntry | null;
    if (strategy === 'random') {
      const random = this.options.random ?? Math.random;
      picked = available[Math.floor(random() * available.length)] ?? null;
    } else if (strategy === 'fill') {
      picked = available.reduce((best, entry) =>
        (entry.lastUsedAt ?? 0) > (best.lastUsedAt ?? 0) ? entry : best,
      );
    } else {
      picked = this.pickRoundRobin(platform, accounts, model, cooling, now);
    }
    if (!picked) return null;

    picked.lastUsedAt = this.now();
    this.cursors.set(platform, accounts.indexOf(picked));
    this.options.onAccountChange?.(platform, picked, 'meta');
    return picked;
  }

  reportRateLimit(
    platform: CredentialPlatform,
    accountId: string,
    model: string,
    options: ReportRateLimitOptions = {},
  ): void {
    const config = this.options.getPool(platform);
    this.options.cooling(platform).enter(accountId, model, {
      resetAt: options.resetAt,
      message: options.message,
      fallbackMinutes: config?.cooldownFallbackMinutes,
    });
  }

  reportInvalid(platform: CredentialPlatform, accountId: string): void {
    const entry = this.findAccount(platform, accountId);
    if (!entry || entry.status === 'invalid') return;
    entry.status = 'invalid';
    this.options.onAccountChange?.(platform, entry, 'status');
  }

  reportSuccess(platform: CredentialPlatform, accountId: string): void {
    const entry = this.findAccount(platform, accountId);
    if (!entry) return;
    entry.lastUsedAt = this.now();
    this.options.onAccountChange?.(platform, entry, 'meta');
  }

  private pickRoundRobin(
    platform: CredentialPlatform,
    accounts: CredentialAccountEntry[],
    model: string,
    cooling: CoolingMap,
    now: number,
  ): CredentialAccountEntry | null {
    const size = accounts.length;
    const cursor = this.cursors.get(platform) ?? -1;
    for (let step = 1; step <= size; step += 1) {
      const index = (cursor + step) % size;
      const entry = accounts[index];
      if (entry && entry.status === 'active' && !cooling.active(entry.id, model, now)) {
        return entry;
      }
    }
    return null;
  }

  private findAccount(
    platform: CredentialPlatform,
    accountId: string,
  ): CredentialAccountEntry | undefined {
    return this.options.getPool(platform)?.accounts.find((entry) => entry.id === accountId);
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
