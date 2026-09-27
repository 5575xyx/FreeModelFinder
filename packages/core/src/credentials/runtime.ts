import type { CredentialAccountEntry, CredentialPlatform, CredentialPoolConfig } from '../types.js';
import { AccountPool } from './account-pool.js';
import { CoolingMap } from './cooling-map.js';
import {
  loadPools,
  removeAccount as removeAccountFromStore,
  saveSettings as saveSettingsToStore,
  upsertAccount as upsertAccountToStore,
} from './credential-store.js';
import { UsageAggregator } from './usage-aggregator.js';

export interface CredentialRuntime {
  getPool(platform: CredentialPlatform): Promise<CredentialPoolConfig>;
  upsertAccount(platform: CredentialPlatform, entry: CredentialAccountEntry): Promise<void>;
  removeAccount(platform: CredentialPlatform, accountId: string): Promise<void>;
  saveSettings(
    platform: CredentialPlatform,
    settings: Partial<Omit<CredentialPoolConfig, 'accounts'>>,
  ): Promise<void>;
  hasActiveAccounts(platform: CredentialPlatform): boolean;
  nextAccount(platform: CredentialPlatform, model: string): CredentialAccountEntry | null;
  reportRateLimit(
    platform: CredentialPlatform,
    accountId: string,
    model: string,
    resetAt?: number,
  ): void;
  reportInvalid(platform: CredentialPlatform, accountId: string): void;
  reportSuccess(platform: CredentialPlatform, accountId: string): void;
  clearAccountCooldowns(platform: CredentialPlatform, accountId: string): number;
  listAccountCooldowns(
    platform: CredentialPlatform,
    accountId: string,
  ): Array<{ model: string; resetAt: number }>;
  recordUsage(
    platform: CredentialPlatform,
    accountId: string,
    model: string,
    usage: { promptTokens?: number; completionTokens?: number; requests?: number; error?: string },
  ): void;
  snapshotUsage(platform: CredentialPlatform): Array<{
    accountId: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    lastError?: string;
  }>;
}

export interface CredentialRuntimeOptions {
  throttleMs?: number;
  usageDir?: string;
}

export interface TestCredentialRuntime extends CredentialRuntime {
  waitForPersist(): Promise<void>;
}

const DEFAULT_META_THROTTLE_MS = 10_000;

function cloneEntry(entry: CredentialAccountEntry): CredentialAccountEntry {
  return { ...entry, payload: { ...entry.payload } };
}

class CredentialRuntimeImpl implements TestCredentialRuntime {
  private pools = new Map<CredentialPlatform, CredentialPoolConfig>();
  private coolings = new Map<CredentialPlatform, CoolingMap>();
  private readonly accountPool: AccountPool;
  private readonly usage: UsageAggregator;
  private initPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private metaTimer: NodeJS.Timeout | null = null;
  private metaDirty = new Map<CredentialPlatform, Set<string>>();

  constructor(private readonly options: CredentialRuntimeOptions = {}) {
    this.accountPool = new AccountPool({
      getPool: (platform) => this.pools.get(platform),
      cooling: (platform) => this.coolingFor(platform),
      onAccountChange: (platform, entry, kind) => this.onAccountChange(platform, entry, kind),
    });
    this.usage = new UsageAggregator({ dir: options.usageDir });
    void this.ensureInit();
  }

  getPool(platform: CredentialPlatform): Promise<CredentialPoolConfig> {
    return this.withInit(async () => {
      const pool = this.pools.get(platform);
      if (!pool) return { accounts: [] };
      return {
        ...pool,
        accounts: pool.accounts.map((entry) => ({ ...entry, payload: { ...entry.payload } })),
      };
    });
  }

  async upsertAccount(platform: CredentialPlatform, entry: CredentialAccountEntry): Promise<void> {
    await this.ensureInit();
    const stored = cloneEntry(entry);
    const pool = this.pools.get(platform);
    if (pool) {
      const index = pool.accounts.findIndex((account) => account.id === entry.id);
      if (index >= 0) {
        pool.accounts[index] = stored;
      } else {
        pool.accounts.push(stored);
      }
    } else {
      this.pools.set(platform, { accounts: [stored] });
    }
    this.metaDirty.get(platform)?.delete(entry.id);
    await this.enqueue(() => upsertAccountToStore(platform, stored));
  }

  async removeAccount(platform: CredentialPlatform, accountId: string): Promise<void> {
    await this.ensureInit();
    const pool = this.pools.get(platform);
    if (pool) {
      pool.accounts = pool.accounts.filter((account) => account.id !== accountId);
    }
    this.metaDirty.get(platform)?.delete(accountId);
    this.coolingFor(platform).clearAccount(accountId);
    await this.enqueue(() => removeAccountFromStore(platform, accountId));
  }

  async saveSettings(
    platform: CredentialPlatform,
    settings: Partial<Omit<CredentialPoolConfig, 'accounts'>>,
  ): Promise<void> {
    await this.ensureInit();
    const pool = this.pools.get(platform);
    if (pool) {
      if (settings.strategy !== undefined) pool.strategy = settings.strategy;
      if (settings.cooldownFallbackMinutes !== undefined) {
        pool.cooldownFallbackMinutes = settings.cooldownFallbackMinutes;
      }
    }
    await this.enqueue(() => saveSettingsToStore(platform, settings));
  }

  hasActiveAccounts(platform: CredentialPlatform): boolean {
    return (
      this.pools.get(platform)?.accounts.some((account) => account.status === 'active') ?? false
    );
  }

  nextAccount(platform: CredentialPlatform, model: string): CredentialAccountEntry | null {
    return this.accountPool.next(platform, model);
  }

  reportRateLimit(
    platform: CredentialPlatform,
    accountId: string,
    model: string,
    resetAt?: number,
  ): void {
    this.accountPool.reportRateLimit(platform, accountId, model, { resetAt });
  }

  reportInvalid(platform: CredentialPlatform, accountId: string): void {
    this.accountPool.reportInvalid(platform, accountId);
  }

  reportSuccess(platform: CredentialPlatform, accountId: string): void {
    this.accountPool.reportSuccess(platform, accountId);
  }

  clearAccountCooldowns(platform: CredentialPlatform, accountId: string): number {
    return this.coolingFor(platform).clearAccount(accountId);
  }

  listAccountCooldowns(
    platform: CredentialPlatform,
    accountId: string,
  ): Array<{ model: string; resetAt: number }> {
    return this.coolingFor(platform).listForAccount(accountId);
  }

  recordUsage(
    platform: CredentialPlatform,
    accountId: string,
    _model: string,
    usage: { promptTokens?: number; completionTokens?: number; requests?: number; error?: string },
  ): void {
    this.usage.record(platform, accountId, usage);
  }

  snapshotUsage(platform: CredentialPlatform) {
    return this.usage.snapshot(platform);
  }

  async waitForPersist(): Promise<void> {
    await this.ensureInit();
    if (this.metaTimer) {
      clearTimeout(this.metaTimer);
      this.metaTimer = null;
    }
    await this.flushMeta();
    await this.writeChain;
    await this.usage.flush();
  }

  private coolingFor(platform: CredentialPlatform): CoolingMap {
    let cooling = this.coolings.get(platform);
    if (!cooling) {
      cooling = new CoolingMap();
      this.coolings.set(platform, cooling);
    }
    return cooling;
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const pools = await loadPools();
    for (const [platform, pool] of Object.entries(pools)) {
      if (!this.pools.has(platform as CredentialPlatform)) {
        this.pools.set(platform as CredentialPlatform, pool);
      }
    }
    await this.usage.load();
  }

  private async withInit<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureInit();
    return fn();
  }

  private onAccountChange(
    platform: CredentialPlatform,
    entry: CredentialAccountEntry,
    kind: 'meta' | 'status',
  ): void {
    if (kind === 'status') {
      void this.enqueue(() => upsertAccountToStore(platform, entry)).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[credentials] persisting invalid account failed: ${reason}`);
      });
      return;
    }
    let dirty = this.metaDirty.get(platform);
    if (!dirty) {
      dirty = new Set();
      this.metaDirty.set(platform, dirty);
    }
    dirty.add(entry.id);
    this.scheduleMetaFlush();
  }

  private scheduleMetaFlush(): void {
    if (this.metaTimer) return;
    const throttleMs = this.options.throttleMs ?? DEFAULT_META_THROTTLE_MS;
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null;
      void this.flushMeta();
    }, throttleMs);
    this.metaTimer.unref?.();
  }

  private async flushMeta(): Promise<void> {
    const dirty = this.metaDirty;
    this.metaDirty = new Map();
    for (const [platform, ids] of dirty) {
      for (const accountId of ids) {
        const entry = this.pools
          .get(platform)
          ?.accounts.find((account) => account.id === accountId);
        if (!entry) continue;
        try {
          await upsertAccountToStore(platform, entry);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[credentials] persisting account metadata failed: ${reason}`);
        }
      }
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(op, op);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

let singleton: CredentialRuntimeImpl | null = null;

export function getCredentialRuntime(): CredentialRuntime {
  if (!singleton) {
    singleton = new CredentialRuntimeImpl();
  }
  return singleton;
}

export function createTestRuntime(options?: CredentialRuntimeOptions): TestCredentialRuntime {
  return new CredentialRuntimeImpl(options);
}
