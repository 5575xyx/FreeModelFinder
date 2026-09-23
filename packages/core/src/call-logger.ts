import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config/store.js';
import type { CallLogEntry, CallStatus, ChatResponse } from './types.js';

/**
 * Per-request usage capture. The registry's `onUsage` callback fires for both
 * streaming and non-streaming calls; wrapping a request in this store lets the
 * route attribute the final usage to the correct in-flight request.
 */
export type UsageCapture = (usage: ChatResponse['usage']) => void;
export const usageCaptureStore = new AsyncLocalStorage<UsageCapture>();

export function emitUsageCapture(usage?: ChatResponse['usage']): void {
  usageCaptureStore.getStore()?.(usage);
}

const MEMORY_BUFFER = 1000;
const RETENTION_DAYS = 30;
const FILE_PREFIX = 'calls-';

export interface CallLogFilter {
  limit?: number;
  model?: string;
  provider?: string;
  status?: CallStatus;
  kind?: CallLogEntry['kind'];
  /** Epoch ms; entries with ts >= since. */
  since?: number;
  gatewayKeyId?: string;
}

export interface CallStatsModelRow {
  provider: string;
  model: string;
  calls: number;
  errors: number;
  rateLimited: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** cachedTokens / promptTokens, 0..1. 0 when promptTokens is 0. */
  cacheHitRate: number;
}

export interface CallStatsResult {
  range: 'today' | '7d' | '30d' | 'all';
  since: number;
  totals: {
    calls: number;
    errors: number;
    rateLimited: number;
    success: number;
    successRate: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cacheHitRate: number;
  };
  byModel: CallStatsModelRow[];
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseLine(line: string): CallLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<CallLogEntry>;
    if (typeof parsed.ts !== 'number' || typeof parsed.model !== 'string') return null;
    return {
      ts: parsed.ts,
      kind: (parsed.kind ?? 'chat') as CallLogEntry['kind'],
      provider: String(parsed.provider ?? 'unknown'),
      model: parsed.model,
      status: (parsed.status ?? 'success') as CallStatus,
      httpStatus: typeof parsed.httpStatus === 'number' ? parsed.httpStatus : undefined,
      latencyMs: typeof parsed.latencyMs === 'number' ? parsed.latencyMs : 0,
      promptTokens: typeof parsed.promptTokens === 'number' ? parsed.promptTokens : undefined,
      completionTokens:
        typeof parsed.completionTokens === 'number' ? parsed.completionTokens : undefined,
      cachedTokens: typeof parsed.cachedTokens === 'number' ? parsed.cachedTokens : undefined,
      gatewayKeyId: typeof parsed.gatewayKeyId === 'string' ? parsed.gatewayKeyId : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Append-only call log. Recent entries are kept in a memory ring buffer;
 * full history lives in per-day JSONL files under `<CONFIG_DIR>/logs`.
 */
export class CallLogger {
  private buffer: CallLogEntry[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private loadedDays = new Set<string>();
  readonly logsDir: string;

  constructor(baseDir: string = CONFIG_DIR) {
    this.logsDir = join(baseDir, 'logs');
  }

  record(entry: CallLogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > MEMORY_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MEMORY_BUFFER);
    }
    this.writeChain = this.writeChain
      .then(() => this.append(entry))
      .catch(() => {
        /* logging must never break request handling */
      });
  }

  private async append(entry: CallLogEntry): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    const file = join(this.logsDir, `${FILE_PREFIX}${dayKey(entry.ts)}.jsonl`);
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Await pending writes (used by tests and shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  async list(filter: CallLogFilter = {}): Promise<CallLogEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const collected = await this.collect(filter);
    collected.sort((a, b) => b.ts - a.ts);
    return collected.slice(0, limit);
  }

  async aggregate(range: CallStatsResult['range'] = 'today'): Promise<CallStatsResult> {
    const now = Date.now();
    const since =
      range === 'today'
        ? startOfToday(now)
        : range === '7d'
          ? now - 7 * 86_400_000
          : range === '30d'
            ? now - 30 * 86_400_000
            : 0;

    const entries = await this.collect({ since });
    const byModel = new Map<string, CallStatsModelRow>();
    const totals = {
      calls: 0,
      errors: 0,
      rateLimited: 0,
      success: 0,
      successRate: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheHitRate: 0,
    };

    for (const e of entries) {
      totals.calls += 1;
      if (e.status === 'success') totals.success += 1;
      else if (e.status === 'rate_limited') totals.rateLimited += 1;
      else totals.errors += 1;
      const prompt = e.promptTokens ?? 0;
      const completion = e.completionTokens ?? 0;
      const cached = e.cachedTokens ?? 0;
      totals.promptTokens += prompt;
      totals.completionTokens += completion;
      totals.totalTokens += prompt + completion;
      totals.cachedTokens += cached;

      const key = `${e.provider}:${e.model}`;
      let row = byModel.get(key);
      if (!row) {
        row = {
          provider: e.provider,
          model: e.model,
          calls: 0,
          errors: 0,
          rateLimited: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          cacheHitRate: 0,
        };
        byModel.set(key, row);
      }
      row.calls += 1;
      if (e.status === 'success') {
        /* counted via totals only */
      } else if (e.status === 'rate_limited') row.rateLimited += 1;
      else row.errors += 1;
      row.promptTokens += prompt;
      row.completionTokens += completion;
      row.totalTokens += prompt + completion;
      row.cachedTokens += cached;
    }

    totals.successRate = totals.calls > 0 ? totals.success / totals.calls : 0;
    totals.cacheHitRate = totals.promptTokens > 0 ? totals.cachedTokens / totals.promptTokens : 0;
    for (const row of byModel.values()) {
      row.cacheHitRate = row.promptTokens > 0 ? row.cachedTokens / row.promptTokens : 0;
    }

    const rows = [...byModel.values()].sort((a, b) => b.calls - a.calls);
    return { range, since, totals, byModel: rows };
  }

  /** Today's usage attributed to one gateway key (for limit enforcement). */
  async usageForGatewayKey(gatewayKeyId: string): Promise<{ requests: number; tokens: number }> {
    const since = startOfToday(Date.now());
    const entries = await this.collect({ since, gatewayKeyId });
    let requests = 0;
    let tokens = 0;
    for (const e of entries) {
      requests += 1;
      tokens += (e.promptTokens ?? 0) + (e.completionTokens ?? 0);
    }
    return { requests, tokens };
  }

  private async collect(filter: CallLogFilter): Promise<CallLogEntry[]> {
    await this.flush();
    const out: CallLogEntry[] = [];
    const push = (e: CallLogEntry) => {
      if (filter.since !== undefined && e.ts < filter.since) return;
      if (filter.model && e.model !== filter.model) return;
      if (filter.provider && e.provider !== filter.provider) return;
      if (filter.status && e.status !== filter.status) return;
      if (filter.kind && e.kind !== filter.kind) return;
      if (filter.gatewayKeyId && e.gatewayKeyId !== filter.gatewayKeyId) return;
      out.push(e);
    };

    for (const e of this.buffer) push(e);

    let files: string[] = [];
    try {
      files = (await readdir(this.logsDir)).filter((f) => f.startsWith(FILE_PREFIX));
    } catch {
      return out;
    }
    files.sort();
    const seen = new Set<number>();
    for (const e of this.buffer) seen.add(e.ts);
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(join(this.logsDir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        const entry = parseLine(line);
        if (!entry) continue;
        // Buffer holds the most recent entries; skip duplicates from today's file.
        if (seen.has(entry.ts)) continue;
        push(entry);
      }
    }
    return out;
  }

  /** Delete JSONL files older than the retention window. */
  async cleanup(now: number = Date.now()): Promise<number> {
    let files: string[] = [];
    try {
      files = (await readdir(this.logsDir)).filter((f) => f.startsWith(FILE_PREFIX));
    } catch {
      return 0;
    }
    const cutoff = now - RETENTION_DAYS * 86_400_000;
    let removed = 0;
    for (const file of files) {
      const dateStr = file.slice(FILE_PREFIX.length, FILE_PREFIX.length + 10);
      const parsed = Date.parse(`${dateStr}T00:00:00`);
      if (!Number.isNaN(parsed) && parsed < cutoff) {
        try {
          await unlink(join(this.logsDir, file));
          removed += 1;
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }
}
