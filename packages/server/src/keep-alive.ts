import { normalizeKeepAliveMinutes, type CustomSource } from '@freemodelfinder/core';

export interface KeepAliveSource {
  id: string;
  baseUrl: string;
  apiKey?: string | string[];
  keepAlive?: boolean;
  keepAliveMinutes?: number;
}

/**
 * Periodically pings each enabled custom source's `/models` endpoint so a
 * Render free-tier instance is not spun down after 15 idle minutes. A single
 * 1-minute timer drives all sources; each is pinged only when its own
 * `keepAliveMinutes` has elapsed since its last ping. Failures are swallowed
 * — keep-alive is best-effort and must never disturb request handling.
 */
export class KeepAliveService {
  private readonly lastPingedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly getSources: () => KeepAliveSource[],
    private readonly tickMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Do not hold the process open on account of keep-alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    const now = this.now();
    let sources: KeepAliveSource[];
    try {
      sources = this.getSources();
    } catch {
      return;
    }
    await Promise.all(
      sources
        .filter((s) => s.keepAlive !== false && !!s.baseUrl)
        .map(async (source) => {
          const intervalMs = normalizeKeepAliveMinutes(source.keepAliveMinutes) * 60_000;
          const last = this.lastPingedAt.get(source.id) ?? 0;
          if (now - last < intervalMs) return;
          this.lastPingedAt.set(source.id, now);
          await this.ping(source);
        }),
    );
  }

  private async ping(source: KeepAliveSource): Promise<void> {
    const url = `${source.baseUrl.replace(/\/$/, '')}/models`;
    const key = Array.isArray(source.apiKey) ? source.apiKey[0] : source.apiKey;
    try {
      await fetch(url, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Best-effort: a sleeping or unreachable CPA is exactly what the next
      // tick is for. Swallow so keep-alive never throws into request handling.
    }
  }
}

/** Reads the enabled custom sources (decrypted) out of the live config. */
export function customSourcesFromConfig(config: {
  providers?: Partial<Record<string, { credentials?: { extra?: Record<string, unknown> } }>>;
}): KeepAliveSource[] {
  const extra = config.providers?.custom?.credentials?.extra as { sources?: unknown } | undefined;
  const raw = extra?.sources;
  if (!Array.isArray(raw)) return [];
  const out: KeepAliveSource[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const src = s as Partial<CustomSource> & Record<string, unknown>;
    if (typeof src.baseUrl !== 'string' || !src.baseUrl) continue;
    out.push({
      id: String(src.id ?? 'default'),
      baseUrl: src.baseUrl,
      apiKey: src.apiKey,
      keepAlive: typeof src.keepAlive === 'boolean' ? src.keepAlive : undefined,
      keepAliveMinutes: typeof src.keepAliveMinutes === 'number' ? src.keepAliveMinutes : undefined,
    });
  }
  return out;
}
