import type { FastifyBaseLogger } from 'fastify';
import {
  loadSnapshot,
  recordSnapshot,
  ProviderRegistry,
  type ModelSnapshot,
  type ModelSnapshotEntry,
} from '@freemodelfinder/core';

export interface ModelWatcherOptions {
  intervalMs?: number;
  getRegistry: () => ProviderRegistry;
  logger?: FastifyBaseLogger;
  onCatalogChange?: () => void;
  /**
   * Called after a tick that detected removed models (provider listing
   * succeeded and the model disappeared from the provider's listing). The
   * caller is expected to run any config-reference cleanup (gateway keys,
   * autoRoute pools, defaultModel, aliases) synchronously or fire-and-forget.
   * `removedModels` are the entries confirmed removed THIS round.
   */
  onModelsRemoved?: (removedModels: readonly ModelSnapshotEntry[]) => void;
}

export interface WatcherStatus {
  lastRunAt: number;
  lastError: string | null;
  intervalMs: number;
  running: boolean;
}

export class ModelWatcher {
  private timer: NodeJS.Timeout | null = null;
  private status: WatcherStatus;
  private latest: ModelSnapshot | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private opts: ModelWatcherOptions) {
    this.status = {
      lastRunAt: 0,
      lastError: null,
      intervalMs: opts.intervalMs ?? 60 * 60 * 1000,
      running: false,
    };
  }

  async init(): Promise<void> {
    this.latest = await loadSnapshot();
  }

  start(): void {
    if (this.timer) return;
    this.status.running = true;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.status.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status.running = false;
  }

  /**
   * Refresh the catalog and record a new snapshot.
   *
   * Passes `revalidate` so a stale catalog is awaited rather than served stale:
   * the registry's stale-while-revalidate path answers immediately and refreshes
   * in the background, and recording that older list as the new snapshot would
   * freeze change detection — worst case it would read it as "these models were
   * removed" and prune config references to models that are still live.
   */
  async tick(force = false): Promise<ModelSnapshot | null> {
    if (this.inflight) {
      await this.inflight;
      return this.latest;
    }
    const run = (async () => {
      const log = this.opts.logger;
      try {
        const reg = this.opts.getRegistry();
        const enabled = reg.listEnabledProviders();
        if (enabled.length === 0) {
          this.status.lastRunAt = Date.now();
          this.status.lastError = null;
          return;
        }
        const { models, succeededProviders, failedProviders } = await reg.listAllModels(force, {
          revalidate: true,
        });
        const { snapshot, diff, isInitial } = await recordSnapshot(
          models,
          Date.now(),
          succeededProviders,
        );
        this.latest = snapshot;
        if (isInitial || diff.added.length || diff.removed.length) {
          this.opts.onCatalogChange?.();
        }
        if (!isInitial && diff.removed.length) {
          this.opts.onModelsRemoved?.(diff.removed);
        }
        this.status.lastRunAt = snapshot.updatedAt;
        this.status.lastError = failedProviders.length
          ? `providers failed: ${failedProviders.map((f) => `${f.id} (${f.error})`).join('; ')}`
          : null;
        if (log) {
          if (failedProviders.length) {
            log.warn(
              { failed: failedProviders },
              '[model-watcher] some providers failed to list; their models are frozen (not marked as removed)',
            );
          }
          if (isInitial) {
            log.info({ total: models.length }, '[model-watcher] initial snapshot recorded');
          } else if (diff.added.length || diff.removed.length) {
            log.info(
              { added: diff.added.length, removed: diff.removed.length },
              '[model-watcher] model list changed',
            );
          } else {
            log.debug({ total: models.length }, '[model-watcher] no changes');
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.status.lastError = msg;
        this.status.lastRunAt = Date.now();
        if (log) log.warn({ err: msg }, '[model-watcher] tick failed');
      }
    })();
    this.inflight = run;
    try {
      await run;
    } finally {
      this.inflight = null;
    }
    return this.latest;
  }

  getSnapshot(): ModelSnapshot | null {
    return this.latest;
  }

  getStatus(): WatcherStatus {
    return { ...this.status };
  }
}
