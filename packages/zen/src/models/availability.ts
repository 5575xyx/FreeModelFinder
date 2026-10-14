import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import type { ZenEffort } from '../protocol/effort.js';

/**
 * Re-check interval for free models that answered their last probe. Mirrors
 * `FreeModelCheckInterval` in upstream `internal/models/availability.go`.
 */
export const FREE_MODEL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Backoff applied after a probe established `model_unavailable`. Mirrors
 * `FailedModelCheckInterval`.
 */
export const FAILED_MODEL_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Backoff applied while a model sits under manual control. */
const MANUAL_RECHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const REASON_MODEL_UNAVAILABLE = 'model_unavailable';
const REASON_MANUAL_ENABLED = 'manually_enabled';
const REASON_LEGACY_PROBE_RECHECK = 'legacy_probe_recheck';
const REASON_AUTO_PROBE = 'auto_probe';

/** Best effort level a probe confirmed, plus the protocol it was taken on. */
export interface ZenEffortProbe {
  effort?: ZenEffort;
  protocol?: string;
  /**
   * A higher level was rejected and the follow-up recheck was inconclusive, so
   * the previous ceiling must not survive. Consumed by the store on write and
   * never persisted (upstream `Reset` is `json:"-"`).
   */
  reset?: boolean;
}

/** In-memory availability record for one model (upstream `Availability`). */
export interface ZenAvailabilityItem {
  model: string;
  disabled: boolean;
  /** Epoch ms of the last recorded probe, 0 when never probed. */
  checkedAt: number;
  /** Epoch ms of the next scheduled probe, 0 when a check is due now. */
  nextCheck: number;
  reason: string;
  channel: string;
  manual: boolean;
  /** Guards against a superseded probe overwriting a newer observation. */
  generation: number;
  probeVersion: number;
  autoEffort?: ZenEffortProbe;
  effortCheckedAt?: number;
}

/** On-disk entry, keyed by model (upstream `map[string]Availability`). */
interface ZenAvailabilityFileEntry {
  model?: string;
  disabled?: boolean;
  checked_at?: string;
  next_check?: string;
  reason?: string;
  channel?: string;
  manual?: boolean;
  probe_version?: number;
  auto_effort?: { effort?: ZenEffort; protocol?: string };
  effort_checked_at?: string;
}

type ZenAvailabilityFile = Record<string, ZenAvailabilityFileEntry>;

function toItem(model: string, entry: ZenAvailabilityFileEntry | undefined): ZenAvailabilityItem {
  if (!entry || typeof entry !== 'object') {
    return {
      model,
      disabled: false,
      checkedAt: 0,
      nextCheck: 0,
      reason: '',
      channel: '',
      manual: false,
      generation: 0,
      probeVersion: 0,
    };
  }
  const effort = entry.auto_effort;
  const item: ZenAvailabilityItem = {
    model,
    disabled: entry.disabled === true,
    checkedAt: parseTime(entry.checked_at),
    nextCheck: parseTime(entry.next_check),
    reason: typeof entry.reason === 'string' ? entry.reason : '',
    channel: typeof entry.channel === 'string' ? entry.channel : '',
    manual: entry.manual === true,
    generation: 0,
    probeVersion: typeof entry.probe_version === 'number' ? entry.probe_version : 0,
  };
  const level = normalizeLevel(effort?.effort);
  if (level !== undefined) {
    item.autoEffort = { effort: level, protocol: effort?.protocol ?? '' };
    item.effortCheckedAt = parseTime(entry.effort_checked_at);
  }
  return item;
}

// The file is untrusted input: an unknown or empty level must read as "no
// confirmed effort" instead of being cast into the union blindly.
function normalizeLevel(value: unknown): ZenEffort | undefined {
  return typeof value === 'string' && value !== '' ? (value as ZenEffort) : undefined;
}

function parseTime(value: string | undefined): number {
  if (typeof value !== 'string' || value === '') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatTime(value: number): string {
  return new Date(value).toISOString();
}

function toFileEntry(item: ZenAvailabilityItem): ZenAvailabilityFileEntry {
  const entry: ZenAvailabilityFileEntry = {
    model: item.model,
    disabled: item.disabled,
    next_check: formatTime(item.nextCheck),
  };
  if (item.checkedAt > 0) entry.checked_at = formatTime(item.checkedAt);
  if (item.reason !== '') entry.reason = item.reason;
  if (item.channel !== '') entry.channel = item.channel;
  if (item.manual) entry.manual = true;
  if (item.probeVersion !== 0) entry.probe_version = item.probeVersion;
  if (item.autoEffort?.effort) {
    entry.auto_effort = {
      effort: item.autoEffort.effort,
      protocol: item.autoEffort.protocol ?? '',
    };
    entry.effort_checked_at = formatTime(item.effortCheckedAt ?? 0);
  }
  return entry;
}

/**
 * Persistent per-model availability state shared by the probe scheduler and the
 * request path (routing rejects disabled models). Port of upstream
 * `models.AvailabilityStore`; timestamps are kept as epoch ms in memory and
 * rendered as RFC 3339 strings on disk.
 */
export class ZenAvailabilityStore {
  private readonly items = new Map<string, ZenAvailabilityItem>();
  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
  }

  /** Restore persisted records and apply the legacy migrations. Returns `true` when a file was read. */
  async load(): Promise<boolean> {
    this.items.clear();
    if (!this.path) return false;
    let parsed: ZenAvailabilityFile | undefined;
    try {
      parsed = JSON.parse(await fs.readFile(this.path, 'utf8')) as ZenAvailabilityFile;
    } catch {
      return false; // A missing or unreadable file behaves like an empty store.
    }
    if (!parsed || typeof parsed !== 'object') return false;
    for (const [model, entry] of Object.entries(parsed)) {
      this.items.set(model, toItem(model, entry));
    }
    await this.migrate();
    return true;
  }

  // Legacy probes used invalid session ids and treated temporary errors as
  // permanent failures, so their disabled records cannot establish model
  // unavailability and must be re-probed once.
  private async migrate(): Promise<void> {
    let changed = false;
    for (const item of this.items.values()) {
      if (item.probeVersion === 0 && item.disabled) {
        item.disabled = false;
        item.nextCheck = 0;
        item.reason = REASON_LEGACY_PROBE_RECHECK;
        changed = true;
      }
      // Manual restores predate the manual lock flag: keep the operator's
      // intent instead of handing the model back to automatic probing.
      if (!item.disabled && !item.manual && item.reason === REASON_MANUAL_ENABLED) {
        item.manual = true;
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  private async save(): Promise<void> {
    if (!this.path) return;
    const payload: ZenAvailabilityFile = {};
    for (const [model, item] of this.items) payload[model] = toFileEntry(item);
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(temp, this.path);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private ensure(model: string): ZenAvailabilityItem {
    let item = this.items.get(model);
    if (!item) {
      item = toItem(model, undefined);
      this.items.set(model, item);
    }
    return item;
  }

  /** Copy of a record; unknown models read as a zero-valued entry. */
  get(model: string): ZenAvailabilityItem {
    const item = this.items.get(model);
    if (!item) return toItem(model, undefined);
    return {
      ...item,
      autoEffort: item.autoEffort ? { ...item.autoEffort } : undefined,
    };
  }

  /** `true` when the model must not be served (failed probe, not manual). */
  disabled(model: string): boolean {
    return this.items.get(model)?.disabled === true;
  }

  /**
   * Record a probe outcome. Stale generations and manual records are ignored;
   * only `model_unavailable` disables the model. A still-disabled model whose
   * recheck stayed inconclusive keeps the previous reason and backoff.
   */
  async record(
    model: string,
    generation: number,
    success: boolean,
    reason: string,
    channel: string,
    now: number,
    effort: ZenEffortProbe = {},
  ): Promise<void> {
    const item = this.ensure(model);
    if (item.generation !== generation) return;
    if (item.manual) return;
    if (success) {
      item.disabled = false;
    } else if (reason === REASON_MODEL_UNAVAILABLE) {
      item.disabled = true;
    } else if (item.disabled) {
      // An inconclusive recheck of a still-disabled model carries no new
      // evidence: keep the previous disable reason, and only advance the
      // schedule when the previous window already elapsed.
      item.checkedAt = now;
      item.probeVersion = 1;
      if (item.nextCheck <= now) item.nextCheck = now + FAILED_MODEL_CHECK_INTERVAL_MS;
      await this.save();
      return;
    }
    item.checkedAt = now;
    item.reason = reason;
    item.channel = channel;
    item.probeVersion = 1;
    if (success && effort.effort) {
      item.autoEffort = { effort: effort.effort, protocol: effort.protocol ?? '' };
      item.effortCheckedAt = now;
    } else if (success && effort.reset) {
      delete item.autoEffort;
      delete item.effortCheckedAt;
    }
    const interval =
      !success && reason === REASON_MODEL_UNAVAILABLE
        ? FAILED_MODEL_CHECK_INTERVAL_MS
        : FREE_MODEL_CHECK_INTERVAL_MS;
    item.nextCheck = now + interval;
    await this.save();
  }

  /**
   * Switch a model between manual and automatic control. Manual mode keeps the
   * model enabled and excludes it from probing; switching back schedules a
   * probe on the next check. Returns the new generation, or -1 when the state
   * could not be persisted (the change is rolled back).
   */
  async setManual(model: string, manual: boolean, now: number): Promise<number> {
    const item = this.ensure(model);
    // Retried requests must not erase disable evidence or reset the schedule.
    if (item.manual === manual) return item.generation;
    const previous: ZenAvailabilityItem = { ...item };
    item.manual = manual;
    item.generation += 1;
    item.probeVersion = 1;
    if (manual) {
      item.disabled = false;
      item.reason = REASON_MANUAL_ENABLED;
      item.nextCheck = now + MANUAL_RECHECK_INTERVAL_MS;
    } else {
      item.reason = REASON_AUTO_PROBE;
      item.nextCheck = 0;
    }
    try {
      await this.save();
    } catch (error) {
      this.items.set(model, previous);
      throw error;
    }
    return item.generation;
  }

  /** A manual restore takes the model under manual control. */
  async restore(model: string, now: number): Promise<number> {
    return this.setManual(model, true, now);
  }
}
