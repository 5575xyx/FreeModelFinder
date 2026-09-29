import type { ZenHttpClient } from '../http.js';
import type { ProxySpec } from '../proxy/spec.js';
import {
  applyCooldown,
  cooldownActive,
  healthyProxy,
  proxyHealthy,
  resetCooldown,
  shouldCooldown,
  type ZenCooldownFields,
  type ZenProxyHealth,
} from './health.js';

const DEFAULT_COOLDOWN_BASE_MS = 15_000;

export interface ZenProxyTransport {
  name: string;
  spec: ProxySpec;
  client: ZenHttpClient;
  health: ZenProxyHealth;
}

export interface ZenKeyNode extends ZenCooldownFields {
  key: string;
  keyId: string;
  proxy: ZenProxyTransport;
}

export interface ZenKeyPoolOptions {
  cooldownBaseMs: number;
  maxAttempts: number;
}

export interface ZenAnonymousNode extends ZenCooldownFields {
  proxy: ZenProxyTransport;
}

export interface ZenAnonymousPoolOptions {
  cooldownBaseMs?: number;
}

interface ZenSelection<T> {
  node: T;
  nextIndex: number;
}

export function maskKey(key: string): string {
  const tail = key.length <= 4 ? key : key.slice(-4);
  return `key_...${tail}`;
}

export function createZenProxyTransport(spec: ProxySpec, client: ZenHttpClient): ZenProxyTransport {
  return { name: spec.label, spec, client, health: healthyProxy() };
}

function fnv1a64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function affinityStart(affinity: string, length: number, fallback: number): number {
  if (length === 0) return 0;
  if (affinity === '') return fallback;
  return Number(fnv1a64(affinity) % BigInt(length));
}

function selectNode<T extends ZenCooldownFields>(
  nodes: T[],
  start: number,
  nowMs: number,
): ZenSelection<T> | undefined {
  const count = nodes.length;
  if (count === 0) return undefined;
  let choice = -1;
  let earliest = 0;
  for (let offset = 0; offset < count; offset += 1) {
    const i = (start + offset) % count;
    const node = nodes[i]!;
    if (node.cooldownUntil <= nowMs) {
      choice = i;
      break;
    }
    if (choice === -1 || node.cooldownUntil < earliest) {
      choice = i;
      earliest = node.cooldownUntil;
    }
  }
  if (choice < 0) return undefined;
  return { node: nodes[choice]!, nextIndex: (choice + 1) % count };
}

export class ZenKeyCursor {
  private index: number;

  constructor(
    private readonly pool: ZenKeyPool,
    index: number,
  ) {
    this.index = index;
  }

  next(nowMs: number = Date.now()): ZenKeyNode | undefined {
    const selection = this.pool.select(this.index, nowMs);
    if (!selection) return undefined;
    this.index = selection.nextIndex;
    return selection.node;
  }
}

export class ZenKeyPool {
  readonly maxAttempts: number;

  private readonly nodes: ZenKeyNode[];

  private readonly cooldownBaseMs: number;

  private cursor = 0;

  constructor(
    keys: string[],
    proxies: ProxySpec[],
    client: ZenHttpClient,
    options: ZenKeyPoolOptions,
  ) {
    if (proxies.length === 0) {
      throw new Error('zen key pool requires at least one proxy');
    }
    this.cooldownBaseMs = options.cooldownBaseMs;
    this.maxAttempts = options.maxAttempts;
    const transports = proxies.map((spec) => createZenProxyTransport(spec, client));
    this.nodes = keys.map((key, i) => ({
      key,
      keyId: maskKey(key),
      proxy: transports[i % transports.length]!,
      failures: 0,
      cooldownUntil: 0,
    }));
  }

  len(): number {
    return this.nodes.length;
  }

  all(): ZenKeyNode[] {
    return this.nodes.slice();
  }

  cursorFor(affinity: string): ZenKeyCursor {
    const count = this.nodes.length;
    const fallback = count === 0 ? 0 : this.cursor % count;
    this.cursor += 1;
    return new ZenKeyCursor(this, affinityStart(affinity, count, fallback));
  }

  proxy(node: ZenKeyNode): ZenProxyTransport {
    return node.proxy;
  }

  markSuccess(node: ZenKeyNode): void {
    resetCooldown(node);
  }

  markFailure(node: ZenKeyNode, status?: number, error?: unknown, retryAfterMs?: number): void {
    if (!shouldCooldown(status, error)) return;
    applyCooldown(node, this.cooldownBaseMs, retryAfterMs);
  }

  inCooldown(node: ZenKeyNode, nowMs: number): boolean {
    return cooldownActive(node, nowMs);
  }

  earliestCooldown(nowMs: number): number | undefined {
    let earliest: number | undefined;
    for (const node of this.nodes) {
      if (node.cooldownUntil > nowMs && (earliest === undefined || node.cooldownUntil < earliest)) {
        earliest = node.cooldownUntil;
      }
    }
    return earliest;
  }

  select(start: number, nowMs: number): ZenSelection<ZenKeyNode> | undefined {
    return selectNode(this.nodes, start, nowMs);
  }
}

export class ZenAnonymousCursor {
  private offset = 0;

  constructor(
    private readonly pool: ZenAnonymousPool,
    private readonly start: number,
  ) {}

  next(nowMs: number = Date.now()): ZenAnonymousNode | undefined {
    const nodes = this.pool.nodes();
    while (this.offset < nodes.length) {
      const node = nodes[(this.start + this.offset) % nodes.length]!;
      this.offset += 1;
      if (proxyHealthy(node.proxy.health) && node.cooldownUntil <= nowMs) return node;
    }
    return undefined;
  }
}

export class ZenAnonymousPool {
  private readonly list: ZenAnonymousNode[];

  private readonly cooldownBaseMs: number;

  private cursor = 0;

  constructor(proxies: ProxySpec[], client: ZenHttpClient, options: ZenAnonymousPoolOptions = {}) {
    this.cooldownBaseMs = options.cooldownBaseMs ?? DEFAULT_COOLDOWN_BASE_MS;
    this.list = proxies.map((spec) => ({
      proxy: createZenProxyTransport(spec, client),
      failures: 0,
      cooldownUntil: 0,
    }));
  }

  len(): number {
    return this.list.length;
  }

  nodes(): ZenAnonymousNode[] {
    return this.list.slice();
  }

  cursorFor(affinity: string): ZenAnonymousCursor {
    const count = this.list.length;
    const fallback = count === 0 ? 0 : this.cursor % count;
    this.cursor += 1;
    return new ZenAnonymousCursor(this, affinityStart(affinity, count, fallback));
  }

  markSuccess(node: ZenAnonymousNode): void {
    resetCooldown(node);
  }

  markFailure(
    node: ZenAnonymousNode,
    status?: number,
    error?: unknown,
    retryAfterMs?: number,
  ): void {
    if (!shouldCooldown(status, error)) return;
    applyCooldown(node, this.cooldownBaseMs, retryAfterMs);
  }

  inCooldown(node: ZenAnonymousNode, nowMs: number): boolean {
    return cooldownActive(node, nowMs);
  }
}
