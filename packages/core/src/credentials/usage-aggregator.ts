import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../config/store.js';
import type { CredentialPlatform } from '../types.js';

export interface UsageRecordInput {
  promptTokens?: number;
  completionTokens?: number;
  requests?: number;
  error?: string;
}

export interface UsageSnapshotEntry {
  accountId: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  lastError?: string;
}

export interface UsageAggregatorOptions {
  dir?: string;
  throttleMs?: number;
}

interface UsageRecord {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  lastError?: string;
}

type UsageFileShape = Record<string, Record<string, UsageRecord>>;

const DEFAULT_THROTTLE_MS = 5_000;

function redactError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(refresh_token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRecord(value: unknown): UsageRecord | null {
  if (!isRecord(value)) return null;
  const record: UsageRecord = {
    requests: typeof value.requests === 'number' ? value.requests : 0,
    promptTokens: typeof value.promptTokens === 'number' ? value.promptTokens : 0,
    completionTokens: typeof value.completionTokens === 'number' ? value.completionTokens : 0,
  };
  if (typeof value.lastError === 'string') record.lastError = value.lastError;
  return record;
}

export class UsageAggregator {
  private data: UsageFileShape = {};
  private timer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  readonly file: string;

  constructor(private readonly options: UsageAggregatorOptions = {}) {
    this.file = join(options.dir ?? CONFIG_DIR, 'credentials-usage.json');
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    for (const [platform, accounts] of Object.entries(parsed)) {
      if (!isRecord(accounts)) continue;
      const platformData = (this.data[platform] ??= {});
      for (const [accountId, record] of Object.entries(accounts)) {
        const normalized = normalizeRecord(record);
        if (!normalized) continue;
        const existing = platformData[accountId];
        if (!existing) {
          platformData[accountId] = normalized;
          continue;
        }
        existing.requests += normalized.requests;
        existing.promptTokens += normalized.promptTokens;
        existing.completionTokens += normalized.completionTokens;
        if (existing.lastError === undefined && normalized.lastError !== undefined) {
          existing.lastError = normalized.lastError;
        }
      }
    }
  }

  record(platform: CredentialPlatform, accountId: string, usage: UsageRecordInput): void {
    const platformData = (this.data[platform] ??= {});
    const record = (platformData[accountId] ??= {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
    record.requests += usage.requests ?? 1;
    record.promptTokens += usage.promptTokens ?? 0;
    record.completionTokens += usage.completionTokens ?? 0;
    if (usage.error !== undefined) record.lastError = redactError(usage.error);
    this.schedule();
  }

  snapshot(platform: CredentialPlatform): UsageSnapshotEntry[] {
    const platformData = this.data[platform] ?? {};
    return Object.entries(platformData)
      .map(([accountId, record]) => ({
        accountId,
        requests: record.requests,
        promptTokens: record.promptTokens,
        completionTokens: record.completionTokens,
        ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
      }))
      .sort((a, b) => a.accountId.localeCompare(b.accountId));
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const payload = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file, payload, { mode: 0o600 });
      });
    await this.writeChain;
  }

  private schedule(): void {
    if (this.timer) return;
    const throttleMs = this.options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, throttleMs);
    this.timer.unref?.();
  }
}
