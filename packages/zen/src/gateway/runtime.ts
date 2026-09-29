import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { ZenConfig } from '../config/index.js';
import type { ZenHttpClient, ZenHttpRequest, ZenHttpResponse } from '../http.js';
import { createNodeHttpClient } from '../http.js';
import { canonicalSessionId } from '../identity/session.js';
import { ZenCatalog } from '../models/catalog.js';
import { ZenPricingStore, type PricingSnapshot } from '../models/pricing.js';
import type { CatalogSnapshot, ZenRoute, ZenTier } from '../models/types.js';
import { parseProxyList, type ProxySpec } from '../proxy/spec.js';
import { convertResponse } from '../protocol/response.js';
import {
  collapseChunks,
  parseAnthropicChunk,
  parseChatChunk,
  parseResponsesChunk,
  SseParser,
  type SseEvent,
} from '../protocol/stream.js';
import type {
  ZenChatResponse,
  ZenClientProtocol,
  ZenProtocol,
  ZenRequest,
  ZenStreamChunk,
} from '../protocol/types.js';
import { ZenAttemptMonitor } from './monitor.js';
import { ZenAnonymousPool, ZenKeyPool } from './pool.js';
import { ZenRefresher, type ZenRefreshResult } from './refresh.js';
import {
  doUpstream,
  doUpstreamStream,
  type ZenRequestIds,
  type ZenUpstreamLogger,
  type ZenUpstreamOptions,
} from './upstream.js';

// Mirrors the same-protocol shortcut in internal/gateway/gateway.go:206-210
// (and its stream twin in protocol/response.ts): when the client protocol maps
// to the upstream protocol the response/stream can be forwarded verbatim and
// keeps raw + rawProtocol.
const CLIENT_TO_PROTOCOL: Partial<Record<ZenClientProtocol, ZenProtocol>> = {
  openai: 'chat',
  anthropic: 'anthropic',
};

export interface ZenGatewayLogger extends ZenUpstreamLogger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface ZenGatewayOptions {
  config: ZenConfig;
  proxies?: ProxySpec[];
  proxyfileContent?: string;
  cachePaths?: { catalog?: string; pricing?: string };
  httpClient?: ZenHttpClient;
  fetchImpl?: typeof fetch;
  logger?: ZenGatewayLogger;
  now?: () => number;
}

export interface ZenGatewayKeyCounts {
  zen: number;
  go: number;
  anonymous: boolean;
}

export interface ZenGatewayProxyCounts {
  total: number;
  healthy: number;
}

export interface ZenGatewaySnapshot {
  models: CatalogSnapshot;
  pricing: PricingSnapshot;
  keys: ZenGatewayKeyCounts;
  proxies: ZenGatewayProxyCounts;
}

export interface ZenGateway {
  listRoutes(hasZenKeys: boolean, hasGoKeys: boolean, hasAnonymous: boolean): ZenRoute[];
  isFreeModel(model: string): boolean;
  snapshot(): ZenGatewaySnapshot;
  chat(request: ZenRequest): Promise<ZenChatResponse>;
  stream(request: ZenRequest): AsyncIterable<ZenStreamChunk>;
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<ZenRefreshResult>;
  loadCache(): Promise<{ catalog: boolean; pricing: boolean }>;
  monitor(): ZenAttemptMonitor;
}

// Mirrors newTransportPool(cfg.RuntimeProxies(), ...) in
// internal/gateway/gateway.go:41: the configured proxy list plus the optional
// proxy file. A caller may inject already-parsed specs (tests) or the contents.
function resolveProxies(options: ZenGatewayOptions): ProxySpec[] {
  if (options.proxies && options.proxies.length > 0) return options.proxies;
  let content = options.proxyfileContent;
  if (content === undefined && options.config.proxyfile) {
    try {
      content = readFileSync(options.config.proxyfile, 'utf8');
    } catch {
      content = undefined;
    }
  }
  return parseProxyList(options.config.proxies, content);
}

// Mirrors identity.DeriveRequestIDs in internal/identity/request.go:24: the
// gateway runtime owns no HTTP request, so it mints a fresh request/session
// pair per call. The session is canonicalized so the upstream sees a
// well-formed affinity value. P1-E may instead thread ids from the core layer.
function makeRequestIds(signal?: AbortSignal): ZenRequestIds {
  const request = `req_${randomUUID().replace(/-/g, '')}`;
  const ids: ZenRequestIds = { request, session: canonicalSessionId(request) };
  if (signal) ids.signal = signal;
  return ids;
}

// The request budget is the tighter of the caller cancellation, derived from
// request.signal, and the configured total deadline (retry.timeoutSeconds).
// AbortSignal.any keeps either edge able to stop the retry scan so a hung
// upstream or proxy cannot hold the call open forever.
function requestDeadline(request: ZenRequest, timeoutSeconds: number): AbortSignal {
  const milliseconds = Math.max(1, Math.trunc(timeoutSeconds * 1000));
  const deadline = AbortSignal.timeout(milliseconds);
  return request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
}

// Applies performance.connectTimeoutSeconds/attemptTimeoutSeconds to every
// outbound request without binding to a concrete transport: the optional
// per-request deadline fields are honored by the node http client and can be
// overridden by an injected ZenHttpClient that sets its own values.
function withConfiguredTimeouts(
  client: ZenHttpClient,
  performance: ZenConfig['performance'],
): ZenHttpClient {
  const connectTimeoutMs = performance.connectTimeoutSeconds * 1000;
  const attemptTimeoutMs = performance.attemptTimeoutSeconds * 1000;
  return {
    send(request: ZenHttpRequest): Promise<ZenHttpResponse> {
      const enriched: ZenHttpRequest = { ...request };
      if (connectTimeoutMs > 0 && enriched.connectTimeoutMs === undefined) {
        enriched.connectTimeoutMs = connectTimeoutMs;
      }
      if (attemptTimeoutMs > 0 && enriched.attemptTimeoutMs === undefined) {
        enriched.attemptTimeoutMs = attemptTimeoutMs;
      }
      return client.send(enriched);
    },
  };
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readBodyText(body: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseStreamChunk(protocol: ZenProtocol, payload: unknown): ZenStreamChunk {
  switch (protocol) {
    case 'anthropic':
      return parseAnthropicChunk(payload);
    case 'responses':
      return parseResponsesChunk(payload);
    default:
      return parseChatChunk(payload);
  }
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

// Mirrors wire.CollapseStream in internal/protocol/collapse.go:17 as used by
// gateway.go:230-243: replay the upstream SSE frames through the protocol chunk
// parser and collapse them into the single document a non-streaming client
// asked for. The parsed frames are returned too so the caller can backfill raw.
function collapseSseText(
  protocol: ZenProtocol,
  text: string,
): { response: ZenChatResponse; events: SseEvent[] } {
  const parser = new SseParser();
  const chunks: ZenStreamChunk[] = [];
  const events: SseEvent[] = [];
  for (const event of parser.push(text)) {
    if (event.data === '[DONE]') continue;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      throw new Error(`upstream stream sent malformed JSON: ${event.data}`);
    }
    events.push(event);
    chunks.push(parseStreamChunk(protocol, payload));
  }
  return { response: collapseChunks(chunks), events };
}

// Mirrors NewRuntimeManager + Gateway.New in internal/gateway/runtime.go:52-112
// and gateway.go:40-66: assemble the proxies, key/anonymous pools, catalog,
// pricing store, refresher and attempt monitor behind one facade.
export function createZenGateway(options: ZenGatewayOptions): ZenGateway {
  const config = options.config;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? {};
  const proxies = resolveProxies(options);
  const rawHttpClient = options.httpClient ?? createNodeHttpClient();
  const httpClient = withConfiguredTimeouts(rawHttpClient, config.performance);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const monitor = new ZenAttemptMonitor();

  const cooldownBaseMs = Math.max(0, config.performance.failureCooldownSeconds) * 1000;
  const pools: Partial<Record<ZenTier, ZenKeyPool>> = {
    zen: new ZenKeyPool(config.zenKeys, proxies, httpClient, {
      cooldownBaseMs,
      maxAttempts: config.retry.maxAttempts,
    }),
    go: new ZenKeyPool(config.goKeys, proxies, httpClient, {
      cooldownBaseMs,
      maxAttempts: config.retry.maxAttempts,
    }),
  };
  const anonymousPool = new ZenAnonymousPool(proxies, httpClient, { cooldownBaseMs });
  const catalog = new ZenCatalog(config.prefer, config.models.protocols);
  const pricing = new ZenPricingStore();
  catalog.setPricing(pricing);
  const refresher = new ZenRefresher({
    config,
    catalog,
    pricing,
    fetchImpl,
    cachePaths: options.cachePaths,
    monitor,
    logger,
    now,
  });

  const upstreamOptions: ZenUpstreamOptions = {
    pools,
    anonymousPool,
    monitor,
    retry: { maxAttempts: config.retry.maxAttempts },
    upstream: { zen: config.upstream.zen, go: config.upstream.go },
    reasoning: config.reasoning,
    isFreeModel: (model) => catalog.isFreeModel(model),
    logger,
    now,
  };

  const hasZenKeys = (): boolean => (pools.zen?.len() ?? 0) > 0;
  const hasGoKeys = (): boolean => (pools.go?.len() ?? 0) > 0;

  const routeFor = (request: ZenRequest): ZenRoute =>
    catalog.route(request.model, hasZenKeys(), hasGoKeys(), config.anonymous);

  // Mirrors Catalog.AvailableModels in internal/models/catalog.go:406-424: every
  // supported model that the supplied channel flags can route to.
  function listRoutes(hasZen: boolean, hasGo: boolean, hasAnonymous: boolean): ZenRoute[] {
    const routes: ZenRoute[] = [];
    for (const model of catalog.list()) {
      try {
        routes.push(catalog.route(model, hasZen, hasGo, hasAnonymous));
      } catch {
        // A model advertised by one channel may be unroutable under the
        // supplied flags; AvailableModels skips those rather than failing.
      }
    }
    return routes;
  }

  async function chat(request: ZenRequest): Promise<ZenChatResponse> {
    const route = routeFor(request);
    const ids = makeRequestIds(requestDeadline(request, config.retry.timeoutSeconds));
    const result = await doUpstream(upstreamOptions, route, request, ids);
    if (result.error !== undefined || result.response === undefined) {
      throw result.error ?? new Error('upstream request failed');
    }
    const response = result.response;
    const text = await readBodyText(response.body);
    if (Math.floor(response.status / 100) !== 2) {
      throw new Error(`upstream returned HTTP ${response.status}: ${text}`);
    }
    const clientProtocol = request.rawProtocol ?? 'openai';
    const upstreamProtocol = result.effectiveRoute.protocol;
    const sameProtocol = CLIENT_TO_PROTOCOL[clientProtocol] === upstreamProtocol;
    // Mirrors gateway.go:230-243: the anonymous lane (and a shaped free key
    // body) is forced to stream, so a non-streaming client must have the SSE
    // events collapsed back into one document. The response content type is
    // authoritative when present.
    const contentType = headerText(response.headers['content-type']);
    const shaped = result.effectiveRoute.anonymous || catalog.isFreeModel(result.effectiveRoute.id);
    const streamed = shaped || (contentType?.includes('text/event-stream') ?? false);
    if (streamed) {
      const collapsed = collapseSseText(upstreamProtocol, text);
      // A shaped route whose body turned out to be a plain JSON document (or an
      // empty stream) has no SSE frames to collapse; keep the single-JSON path.
      if (collapsed.events.length > 0) {
        return sameProtocol
          ? { ...collapsed.response, raw: collapsed.events, rawProtocol: clientProtocol }
          : collapsed.response;
      }
    }
    return convertResponse(parseJsonBody(text), upstreamProtocol, clientProtocol);
  }

  // Mirrors the streamed branch of handleInference in internal/gateway/gateway.go:
  // 192-224 plus the P1-C2 handoff: a same-protocol stream keeps the raw SSE
  // frame on each chunk. The frame is the parsed SseEvent (event + data);
  // byte-exact passthrough is not retained by SseParser and is recorded lossy.
  async function* stream(request: ZenRequest): AsyncGenerator<ZenStreamChunk> {
    const route = routeFor(request);
    const ids = makeRequestIds(requestDeadline(request, config.retry.timeoutSeconds));
    const clientProtocol = request.rawProtocol ?? 'openai';
    const streamed = await doUpstreamStream(upstreamOptions, route, request, ids);
    const upstreamProtocol = streamed.effectiveRoute.protocol;
    const sameProtocol = CLIENT_TO_PROTOCOL[clientProtocol] === upstreamProtocol;
    const parser = new SseParser();
    for await (const chunk of streamed.body) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const event of parser.push(text)) {
        if (event.data === '[DONE]') continue;
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          throw new Error(`upstream stream sent malformed JSON: ${event.data}`);
        }
        const parsed = parseStreamChunk(upstreamProtocol, payload);
        if (sameProtocol) {
          parsed.raw = event;
          parsed.rawProtocol = clientProtocol;
        }
        yield parsed;
      }
    }
  }

  function snapshot(): ZenGatewaySnapshot {
    const transports = anonymousPool.nodes().map((node) => node.proxy);
    const healthy = transports.filter((proxy) => proxy.health.healthy).length;
    return {
      models: catalog.snapshot(),
      pricing: pricing.snapshot(now()),
      keys: {
        zen: pools.zen?.len() ?? 0,
        go: pools.go?.len() ?? 0,
        anonymous: config.anonymous,
      },
      proxies: { total: transports.length, healthy },
    };
  }

  async function start(): Promise<void> {
    await refresher.loadCache();
    refresher.start();
  }

  function stop(): void {
    refresher.stop();
    const closable = rawHttpClient as { close?: () => void };
    if (typeof closable.close === 'function') closable.close();
  }

  function refresh(): Promise<ZenRefreshResult> {
    return refresher.refreshOnce();
  }

  function loadCache(): Promise<{ catalog: boolean; pricing: boolean }> {
    return refresher.loadCache();
  }

  return {
    listRoutes,
    isFreeModel: (model: string) => catalog.isFreeModel(model),
    snapshot,
    chat,
    stream,
    start,
    stop,
    refresh,
    loadCache,
    monitor: () => monitor,
  };
}
