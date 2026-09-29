export type ZenAttemptOutcome = 'success' | 'retryable_failure' | 'transport_error' | 'rejected';

export interface ZenAttemptRecord {
  time: number;
  requestId: string;
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
