// Outcome label for one attempt. Matches Go's UpstreamAttempt.Outcome, which
// is a free-form string. Values written by recordUpstreamAttempt:
//   - 'success'         2xx response
//   - 'rejected'        non-retryable 4xx (bad request, invalid auth, ...)
//   - 'retryable_failure' 5xx / other retryable server responses
//   - classifyAttemptError(error) for transport/timeout failures, e.g.
//     'transport_dial', 'timeout_headers', 'attempt_timeout_write', 'first_event'.
export type ZenAttemptOutcome = string;

export interface ZenAttemptRecord {
  time: number;
  requestId: string;
  session?: string;
  model: string;
  tier: string;
  attempt: number;
  keyId: string;
  channel: 'anonymous' | 'key';
  anonymous: boolean;
  proxy: string;
  status: number;
  durationMs: number;
  success: boolean;
  outcome: ZenAttemptOutcome;
}

export class ZenAttemptMonitor {
  private records: ZenAttemptRecord[] = [];

  constructor(private readonly capacity = 2000) {}

  record(entry: ZenAttemptRecord): void {
    this.records.push(entry);
    const overflow = this.records.length - this.capacity;
    if (overflow > 0) this.records.splice(0, overflow);
  }

  list(): ZenAttemptRecord[] {
    return this.records.slice();
  }

  reset(): void {
    this.records = [];
  }
}
