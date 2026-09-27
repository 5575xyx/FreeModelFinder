export interface CoolingEnterOptions {
  resetAt?: number;
  message?: string;
  fallbackMinutes?: number;
}

export interface CoolingEntry {
  model: string;
  resetAt: number;
}

export const DEFAULT_COOLDOWN_MINUTES = 5;

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  msec: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

function unitToMs(unit: string): number | undefined {
  return DURATION_UNIT_MS[unit.toLowerCase()];
}

function parseTextDurationMs(text: string): number | undefined {
  const qualified = text.match(/(?:\bin|\bafter|\bwait\b)\s+(\d+(?:\.\d+)?)\s*([a-z]+)\b/i);
  const bare = qualified ?? text.match(/(\d+(?:\.\d+)?)\s*([a-z]+)\b/i);
  if (!bare) return undefined;
  const value = Number(bare[1]);
  const unit = unitToMs(bare[2] ?? '');
  if (!unit || !Number.isFinite(value)) return undefined;
  return value * unit;
}

function keyOf(accountId: string, model: string): string {
  return `${accountId}\u0000${model}`;
}

export class CoolingMap {
  private entries = new Map<string, { accountId: string; model: string; resetAt: number }>();

  enter(accountId: string, model: string, options: CoolingEnterOptions = {}): number {
    const now = Date.now();
    let resetAt: number;
    if (typeof options.resetAt === 'number') {
      resetAt = options.resetAt;
    } else {
      const parsed = options.message ? parseTextDurationMs(options.message) : undefined;
      if (parsed !== undefined) {
        resetAt = now + parsed;
      } else {
        const minutes = options.fallbackMinutes ?? DEFAULT_COOLDOWN_MINUTES;
        resetAt = now + minutes * 60_000;
      }
    }
    if (resetAt <= now) return resetAt;
    this.entries.set(keyOf(accountId, model), { accountId, model, resetAt });
    return resetAt;
  }

  active(accountId: string, model: string, now: number = Date.now()): boolean {
    this.sweep(now);
    return this.has(keyOf(accountId, model), now) || this.has(keyOf(accountId, '*'), now);
  }

  clearAccount(accountId: string): number {
    let cleared = 0;
    for (const [key, entry] of this.entries) {
      if (entry.accountId === accountId) {
        this.entries.delete(key);
        cleared += 1;
      }
    }
    return cleared;
  }

  clearAll(): void {
    this.entries.clear();
  }

  listForAccount(accountId: string, now: number = Date.now()): CoolingEntry[] {
    this.sweep(now);
    const out: CoolingEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.accountId === accountId) out.push({ model: entry.model, resetAt: entry.resetAt });
    }
    return out;
  }

  private has(key: string, now: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}
