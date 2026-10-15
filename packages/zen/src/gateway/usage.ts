// Per-session lifetime token accounting.
//
// Mirrors addLifetimeSessionLocked in internal/telemetry/metrics.go:597-613.
// Session IDs are high-cardinality (one per conversation), so an unbounded map
// would grow forever. When full, the least recently seen session is evicted:
// evicting the smallest total would drop the newest conversation first, so
// every new session would push out the previous one.
//
// The ServerKeys dimension and the 60-bucket ring window are intentionally
// not ported here: FMF tracks quota at the gateway-key level through the
// callLogger, and this tracker is only the lifetime per-session burn view.

export interface TokenCounts {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
}

/** Upper bound on the tracked sessions, matching maxLifetimeSessions in Go. */
export const DEFAULT_SESSION_CAPACITY = 500;

function normalize(tokens: TokenCounts | number): TokenCounts {
  if (typeof tokens === 'number') {
    return { input: 0, output: 0, cached: 0, reasoning: 0, total: tokens };
  }
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cached: tokens.cached ?? 0,
    reasoning: tokens.reasoning ?? 0,
    total: tokens.total ?? 0,
  };
}

function accumulate(target: TokenCounts, source: TokenCounts): TokenCounts {
  return {
    input: target.input + source.input,
    output: target.output + source.output,
    cached: target.cached + source.cached,
    reasoning: target.reasoning + source.reasoning,
    total: target.total + source.total,
  };
}

/**
 * Lifetime token counts keyed by canonical session id, bounded by an LRU
 * eviction at `capacity`. `record` treats the session as most recently seen,
 * so a session that keeps accumulating tokens survives the eviction.
 */
export class SessionUsageTracker {
  private readonly capacity: number;
  private readonly sessions: Map<string, TokenCounts> = new Map();

  constructor(capacity: number = DEFAULT_SESSION_CAPACITY) {
    this.capacity = Math.max(1, Math.trunc(capacity));
  }

  record(session: string, tokens: TokenCounts | number): void {
    if (!session) return;
    const normalized = normalize(tokens);

    let existing: TokenCounts | undefined;
    if (this.sessions.has(session)) {
      // Move the entry to the end of the insertion order (most recent).
      existing = this.sessions.get(session);
      this.sessions.delete(session);
    } else if (this.sessions.size >= this.capacity) {
      // Evict the least recently seen session (the first in insertion order).
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }

    const counts = existing
      ? accumulate(existing, normalized)
      : {
          input: normalized.input,
          output: normalized.output,
          cached: normalized.cached,
          reasoning: normalized.reasoning,
          total: normalized.total,
        };
    this.sessions.set(session, counts);
  }

  snapshot(): Map<string, TokenCounts> {
    return new Map(this.sessions);
  }
}
