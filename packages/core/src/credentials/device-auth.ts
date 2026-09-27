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
}

const DEFAULT_TTL_MS = 600_000;

interface StoredFlow {
  flow: DeviceAuthFlow;
  check: () => Promise<DeviceAuthPollResult>;
}

export class DeviceAuthManager {
  private flows = new Map<string, StoredFlow>();

  constructor(private readonly options: DeviceAuthManagerOptions = {}) {}

  start(options: DeviceAuthStartOptions): DeviceAuthFlow {
    const flowId = (this.options.idFactory ?? randomUUID)();
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
    if (flow.status === 'complete' || flow.status === 'denied') return flow;
    if (this.now() >= flow.expiresAt) {
      flow.status = 'expired';
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
    } else if (result.status === 'denied') {
      flow.status = 'denied';
      if (result.reason !== undefined) flow.reason = result.reason;
    }
    return flow;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
