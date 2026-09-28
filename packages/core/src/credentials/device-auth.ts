import { randomUUID } from 'node:crypto';

export type DeviceAuthStatus = 'pending' | 'complete' | 'expired' | 'denied';

export interface DeviceAuthPollResult {
  status: 'pending' | 'complete' | 'denied';
  result?: unknown;
  reason?: string;
}

export interface DeviceAuthStartOptions {
  check: () => Promise<DeviceAuthPollResult>;
  expiresInMs?: number;
  meta?: Record<string, string>;
}

export interface DeviceAuthFlow {
  flowId: string;
  status: DeviceAuthStatus;
  expiresAt: number;
  meta?: Record<string, string>;
  result?: unknown;
  reason?: string;
}

export interface DeviceAuthManagerOptions {
  now?: () => number;
  ttlMs?: number;
  idFactory?: () => string;
  maxFlows?: number;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_MAX_FLOWS = 64;
const MAX_ID_ATTEMPTS = 3;

interface StoredFlow {
  flow: DeviceAuthFlow;
  check: () => Promise<DeviceAuthPollResult>;
}

export class DeviceAuthManager {
  private flows = new Map<string, StoredFlow>();

  constructor(private readonly options: DeviceAuthManagerOptions = {}) {}

  start(options: DeviceAuthStartOptions): DeviceAuthFlow {
    this.sweep();
    this.enforceLimit();
    let flowId = this.generateId();
    for (let attempt = 1; attempt < MAX_ID_ATTEMPTS && this.flows.has(flowId); attempt += 1) {
      flowId = this.generateId();
    }
    if (this.flows.has(flowId)) {
      throw new Error('device auth flow id collision');
    }
    const ttlMs = options.expiresInMs ?? this.options.ttlMs ?? DEFAULT_TTL_MS;
    const flow: DeviceAuthFlow = {
      flowId,
      status: 'pending',
      expiresAt: this.now() + ttlMs,
    };
    if (options.meta) flow.meta = options.meta;
    this.flows.set(flowId, { flow, check: options.check });
    return flow;
  }

  async poll(flowId: string): Promise<DeviceAuthFlow> {
    const stored = this.flows.get(flowId);
    if (!stored) return { flowId, status: 'expired', expiresAt: 0 };
    const flow = stored.flow;
    if (this.now() >= flow.expiresAt) {
      flow.status = 'expired';
      this.flows.delete(flowId);
      return flow;
    }
    let result: DeviceAuthPollResult;
    try {
      result = await stored.check();
    } catch {
      return flow;
    }
    if (result.status === 'complete') {
      flow.status = 'complete';
      flow.result = result.result;
      this.flows.delete(flowId);
    } else if (result.status === 'denied') {
      flow.status = 'denied';
      if (result.reason !== undefined) flow.reason = result.reason;
      this.flows.delete(flowId);
    }
    return flow;
  }

  private sweep(): void {
    const now = this.now();
    for (const [flowId, stored] of this.flows) {
      if (now >= stored.flow.expiresAt) this.flows.delete(flowId);
    }
  }

  private enforceLimit(): void {
    while (this.flows.size >= this.maxFlows()) {
      const oldest = this.flows.keys().next();
      if (oldest.done) break;
      this.flows.delete(oldest.value);
    }
  }

  private maxFlows(): number {
    return this.options.maxFlows ?? DEFAULT_MAX_FLOWS;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private generateId(): string {
    return (this.options.idFactory ?? randomUUID)();
  }
}
