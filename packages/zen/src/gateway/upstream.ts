import { Readable } from 'node:stream';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { ZenHttpRequest, ZenHttpResponse } from '../http.js';
import { openCodeUserAgent } from '../identity/client.js';
import type { ProxySpec } from '../proxy/spec.js';
import type { ZenRoute, ZenTier } from '../models/types.js';
import { prepareAnonymousBody, shapeKeyBody } from '../protocol/agent.js';
import { applyForcedEffort, resolveEffort, type ZenEffort } from '../protocol/effort.js';
import { prepareRequest } from '../protocol/request.js';
import { isStaleReasoningReference, stripStaleReasoningInputs } from '../protocol/stale.js';
import type { ZenProtocol, ZenRequest } from '../protocol/types.js';
import { parseRetryAfter, proxyHealthy, setProxyHealthy } from './health.js';
import type { ZenAttemptMonitor, ZenAttemptOutcome } from './monitor.js';
import type {
  ZenAnonymousNode,
  ZenAnonymousPool,
  ZenKeyNode,
  ZenKeyPool,
  ZenProxyTransport,
} from './pool.js';

const ANONYMOUS_KEY = 'public';
const BODY_LIMIT = 1 << 20;

export const PROXY_HEALTH_CHECK_URL = 'https://cloudflare.com/cdn-cgi/trace';
export const PROXY_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const PROXY_HEALTH_CHECK_TIMEOUT_MS = 10 * 1000;

export interface ZenRequestIds {
  request: string;
  session: string;
  project?: string;
  parentSession?: string;
  signal?: AbortSignal;
}

export interface ZenUpstreamLogger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface ZenUpstreamOptions {
  pools: Partial<Record<ZenTier, ZenKeyPool>>;
  anonymousPool?: ZenAnonymousPool;
  monitor?: ZenAttemptMonitor;
  retry: { maxAttempts: number };
  upstream: { zen: string; go: string };
  reasoning?: { effort?: ZenEffort; effortByModel?: Record<string, ZenEffort> };
  isFreeModel?: (model: string) => boolean;
  logger?: ZenUpstreamLogger;
  now?: () => number;
  verifyProxy?: (proxy: ZenProxyTransport) => void;
}

export interface ZenUpstreamResult {
  response?: ZenHttpResponse;
  effectiveRoute: ZenRoute;
  attempts: number;
  error?: unknown;
}

export interface ZenUpstreamStreamResult {
  body: IncomingMessage;
  status: number;
  headers: IncomingHttpHeaders;
  effectiveRoute: ZenRoute;
  attempts: number;
}

export interface ZenProxyHealthCheckResult {
  proxy: ZenProxyTransport;
  error?: unknown;
  failed: boolean;
  wasHealthy: boolean;
}

interface ZenUpstreamPhaseResult {
  response?: ZenHttpResponse;
  used: number;
  error?: unknown;
}

function nowOf(options: ZenUpstreamOptions): number {
  return (options.now ?? Date.now)();
}

function baseUrlFor(options: ZenUpstreamOptions, tier: ZenTier): string {
  return tier === 'go' ? options.upstream.go : options.upstream.zen;
}

function poolFor(options: ZenUpstreamOptions, tier: ZenTier): ZenKeyPool | undefined {
  return options.pools[tier];
}

function protocolForTier(route: ZenRoute, tier: ZenTier): ZenProtocol {
  return route.protocols[tier] ?? route.protocol;
}

function protocolPath(protocol: ZenProtocol): string {
  switch (protocol) {
    case 'responses':
      return '/v1/responses';
    case 'anthropic':
      return '/v1/messages';
    default:
      return '/v1/chat/completions';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSuccess(status: number): boolean {
  return Math.floor(status / 100) === 2;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function abortError(): Error {
  const error = new Error('upstream request aborted');
  error.name = 'AbortError';
  return error;
}

function headerString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function drainBody(body: IncomingMessage): void {
  if (typeof body.resume === 'function') body.resume();
}

function drain(response: ZenHttpResponse): void {
  drainBody(response.body);
}

function bodyAsIncoming(data: Buffer): IncomingMessage {
  return Readable.from([data]) as unknown as IncomingMessage;
}

async function readLimitedBody(response: ZenHttpResponse, limit = BODY_LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    const remaining = limit - size;
    if (buffer.length >= remaining) {
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      drain(response);
      break;
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  return Buffer.concat(chunks);
}

function retryAfterMs(response: ZenHttpResponse | undefined, options: ZenUpstreamOptions): number {
  if (!response) return 0;
  return parseRetryAfter(headerString(response.headers, 'retry-after'), nowOf(options));
}

// Mirrors isProxyFailure in internal/gateway/pool.go:244-256: only failures that
// say the proxy route itself is unavailable may evict a proxy. HTTP responses
// and request cancellations must not.
export function isProxyFailure(error: unknown): boolean {
  if (error === undefined || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return true;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return false;
    if (error.name === 'TimeoutError') return true;
    if (/timeout/i.test(error.message)) return true;
  }
  return false;
}

// Mirrors syncProxyResult in internal/gateway/refresh.go:23-47. Only a proxy
// route failure flips health to unhealthy; any 2xx/3xx flips it healthy. Every
// other error and every 4xx/5xx response triggers the neutral out-of-band URL
// recheck (verifyProxyAfterError) without changing health on its own.
function syncProxyResult(
  options: ZenUpstreamOptions,
  proxy: ZenProxyTransport,
  status: number,
  error: unknown,
): boolean {
  if (isProxyFailure(error)) {
    setProxyHealthy(proxy.health, false);
    options.verifyProxy?.(proxy);
    return true;
  }
  if (status >= 200 && status < 400) {
    setProxyHealthy(proxy.health, true);
    return false;
  }
  if (error !== undefined && error !== null) {
    options.verifyProxy?.(proxy);
    return false;
  }
  if (status >= 400 && status < 600) {
    options.verifyProxy?.(proxy);
  }
  return false;
}

export function isNonRetryableClientResponse(status: number | undefined, error?: unknown): boolean {
  if (error !== undefined && error !== null) return false;
  if (status === undefined) return false;
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

// A Responses-native upstream is reached either by converting a message-shaped
// request or by forwarding a payload the client already expressed in Responses
// form. ZenClientProtocol has no responses member yet, so the shape is honored
// directly to keep same-protocol passthrough (and its stale-reasoning repair)
// reachable. request.go:945-950 only replays reasoning the upstream issued, so
// the same rule applies here: a converted body never fabricates reasoning items.
function isResponsesRaw(request: ZenRequest): boolean {
  const raw = request.raw;
  if (!isPlainRecord(raw)) return false;
  const rawProtocol = request.rawProtocol as string | undefined;
  if (rawProtocol !== undefined && rawProtocol !== 'responses') return false;
  return Array.isArray(raw['input']) || 'previous_response_id' in raw;
}

function prepareUpstreamBody(request: ZenRequest, protocol: ZenProtocol): Record<string, unknown> {
  if (protocol === 'responses' && isResponsesRaw(request) && isPlainRecord(request.raw)) {
    const cloned = structuredClone(request.raw) as Record<string, unknown>;
    cloned['model'] = request.model;
    return cloned;
  }
  return prepareRequest(request, protocol);
}

function applyEffort(
  options: ZenUpstreamOptions,
  body: Record<string, unknown>,
  protocol: ZenProtocol,
  model: string,
): void {
  const reasoning = options.reasoning;
  if (!reasoning) return;
  const effort = resolveEffort(model, reasoning.effort, reasoning.effortByModel ?? {});
  if (effort !== undefined) applyForcedEffort(body, protocol, effort);
}

// Mirrors newUpstreamRequest in internal/gateway/upstream.go:785-814.
function buildUpstreamRequest(
  baseUrl: string,
  protocol: ZenProtocol,
  body: Record<string, unknown>,
  ids: ZenRequestIds,
  key: string,
  proxy: ProxySpec,
): ZenHttpRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': openCodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'x-session-id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project ?? '',
  };
  if (ids.parentSession) headers['x-parent-session-id'] = ids.parentSession;
  if (protocol === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-beta'] =
      'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
  } else {
    headers['authorization'] = `Bearer ${key}`;
  }
  const request: ZenHttpRequest = {
    url: `${baseUrl.replace(/\/+$/, '')}${protocolPath(protocol)}`,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    proxy,
  };
  if (ids.signal) request.signal = ids.signal;
  return request;
}

// Mirrors recordUpstreamAttempt in internal/gateway/upstream.go:756-783.
function recordUpstreamAttempt(
  options: ZenUpstreamOptions,
  route: ZenRoute,
  ids: ZenRequestIds,
  attempt: number,
  keyId: string,
  channel: 'anonymous' | 'key',
  anonymous: boolean,
  proxy: ZenProxyTransport,
  response: ZenHttpResponse | undefined,
  error: unknown,
  durationMs: number,
): void {
  const monitor = options.monitor;
  if (!monitor) return;
  const status = response?.status ?? 0;
  const success = error === undefined && status >= 200 && status < 300;
  let outcome: ZenAttemptOutcome = 'retryable_failure';
  if (success) outcome = 'success';
  else if (error !== undefined) outcome = 'transport_error';
  else if (isNonRetryableClientResponse(status, undefined)) outcome = 'rejected';
  monitor.record({
    time: nowOf(options),
    requestId: ids.request,
    model: route.id,
    tier: route.tier,
    attempt,
    keyId,
    channel,
    anonymous,
    proxy: proxy.name,
    status,
    durationMs: Math.max(Math.trunc(durationMs), 0),
    success,
    outcome,
  });
}

function observeAnonymousResult(
  options: ZenUpstreamOptions,
  pool: ZenAnonymousPool,
  node: ZenAnonymousNode,
  response: ZenHttpResponse | undefined,
  error: unknown,
): void {
  const status = response?.status ?? 0;
  syncProxyResult(options, node.proxy, status, error);
  if (error === undefined && isSuccess(status)) pool.markSuccess(node);
  else pool.markFailure(node, status, error, retryAfterMs(response, options));
}

// Mirrors observeKeyResult in internal/gateway/upstream.go:696-711. Key/proxy
// rebinding on proxy failure is not part of this port: nodes never change their
// proxy binding, so the "only mark when still bound" guard is always true.
function observeKeyResult(
  options: ZenUpstreamOptions,
  pool: ZenKeyPool,
  node: ZenKeyNode,
  proxy: ZenProxyTransport,
  response: ZenHttpResponse | undefined,
  error: unknown,
): void {
  const status = response?.status ?? 0;
  const proxyFailed = syncProxyResult(options, proxy, status, error);
  if ((error === undefined && isSuccess(status)) || isNonRetryableClientResponse(status, error)) {
    pool.markSuccess(node);
    return;
  }
  if (!proxyFailed || pool.proxy(node) === proxy) {
    pool.markFailure(node, status, error, retryAfterMs(response, options));
  }
}

// Mirrors doAnonymousUpstream in internal/gateway/upstream.go:243-325. Every
// available proxy is tried at most once; the phase ignores retry.maxAttempts and
// only a 2xx ends it. The body is normalized to anonymous agent shape first.
export async function doAnonymousUpstream(
  options: ZenUpstreamOptions,
  route: ZenRoute,
  request: ZenRequest,
  ids: ZenRequestIds,
  attemptOffset: number,
  bodyOverride?: Record<string, unknown>,
): Promise<ZenUpstreamPhaseResult> {
  const pool = options.anonymousPool;
  if (!pool || pool.len() === 0) {
    return {
      response: undefined,
      used: 0,
      error: new Error('no healthy anonymous proxies available'),
    };
  }
  let lastResponse: ZenHttpResponse | undefined;
  let lastError: unknown;
  let attempts = 0;
  const limit = pool.len();
  const cursor = pool.cursorFor(ids.session);
  const protocol = protocolForTier(route, 'zen');
  const base = bodyOverride ?? prepareUpstreamBody(request, protocol);
  applyEffort(options, base, protocol, route.id);
  const body = prepareAnonymousBody(base, protocol);
  const baseUrl = baseUrlFor(options, 'zen');

  while (attempts < limit) {
    if (isAborted(ids.signal)) {
      if (lastError === undefined) lastError = abortError();
      break;
    }
    const node = cursor.next(nowOf(options));
    if (!node) break;
    attempts += 1;
    if (lastResponse) {
      drain(lastResponse);
      lastResponse = undefined;
    }
    const proxy = node.proxy;
    const upstreamRequest = buildUpstreamRequest(
      baseUrl,
      protocol,
      body,
      ids,
      ANONYMOUS_KEY,
      proxy.spec,
    );
    const started = nowOf(options);
    let response: ZenHttpResponse | undefined;
    let error: unknown;
    try {
      response = await proxy.client.send(upstreamRequest);
    } catch (caught) {
      error = caught;
    }
    const duration = nowOf(options) - started;
    if (isAborted(ids.signal)) {
      lastResponse = response;
      lastError = error ?? (response ? undefined : abortError());
      break;
    }
    observeAnonymousResult(options, pool, node, response, error);
    recordUpstreamAttempt(
      options,
      route,
      ids,
      attemptOffset + attempts,
      'anonymous',
      'anonymous',
      true,
      proxy,
      response,
      error,
      duration,
    );
    if (error === undefined && response && isSuccess(response.status)) {
      return { response, used: attempts, error: undefined };
    }
    lastResponse = response;
    lastError = error;
  }

  if (lastResponse) return { response: lastResponse, used: attempts, error: undefined };
  if (lastError === undefined && attempts === 0) {
    return {
      response: undefined,
      used: 0,
      error: new Error('no available anonymous proxy (all proxies are cooling or unhealthy)'),
    };
  }
  return {
    response: undefined,
    used: attempts,
    error: lastError ?? new Error('no healthy anonymous proxies available'),
  };
}

// Mirrors doKeyUpstream in internal/gateway/upstream.go:595-694. The tier body is
// re-encoded from the logical request (prepareRequest + forced effort), then up
// to retry.maxAttempts keys are rotated. A non-retryable 4xx ends the tier
// without trying another key; the outer route may still try the next tier.
export async function doKeyUpstream(
  options: ZenUpstreamOptions,
  route: ZenRoute,
  request: ZenRequest,
  ids: ZenRequestIds,
  attemptOffset: number,
  bodyOverride?: Record<string, unknown>,
): Promise<ZenUpstreamPhaseResult> {
  const pool = poolFor(options, route.tier);
  if (!pool || pool.len() === 0) {
    return { response: undefined, used: 0, error: new Error(`no ${route.tier} nodes configured`) };
  }
  let lastResponse: ZenHttpResponse | undefined;
  let lastError: unknown;
  let attempts = 0;
  const protocol = route.protocol;
  let body: Record<string, unknown>;
  if (bodyOverride) {
    body = bodyOverride;
  } else {
    body = prepareUpstreamBody(request, protocol);
    applyEffort(options, body, protocol, route.id);
  }
  if (options.isFreeModel?.(route.id) === true) {
    body = shapeKeyBody(body, protocol, true).body;
  }
  const cursor = pool.cursorFor(ids.session);
  const baseUrl = baseUrlFor(options, route.tier);
  const maxAttempts = Math.max(1, options.retry.maxAttempts);

  while (attempts < maxAttempts) {
    if (isAborted(ids.signal)) {
      if (lastError === undefined) lastError = abortError();
      break;
    }
    const node = cursor.next(nowOf(options));
    if (!node) break;
    attempts += 1;
    if (lastResponse) {
      drain(lastResponse);
      lastResponse = undefined;
    }
    const proxy = pool.proxy(node);
    if (!proxy) {
      lastError = new Error('upstream key has no proxy binding');
      break;
    }
    const upstreamRequest = buildUpstreamRequest(
      baseUrl,
      protocol,
      body,
      ids,
      node.key,
      proxy.spec,
    );
    const started = nowOf(options);
    let response: ZenHttpResponse | undefined;
    let error: unknown;
    try {
      response = await proxy.client.send(upstreamRequest);
    } catch (caught) {
      error = caught;
    }
    const duration = nowOf(options) - started;
    if (isAborted(ids.signal)) {
      lastResponse = response;
      lastError = error ?? (response ? undefined : abortError());
      break;
    }
    observeKeyResult(options, pool, node, proxy, response, error);
    recordUpstreamAttempt(
      options,
      route,
      ids,
      attemptOffset + attempts,
      node.keyId,
      'key',
      false,
      proxy,
      response,
      error,
      duration,
    );
    if (error === undefined && response && isSuccess(response.status)) {
      return { response, used: attempts, error: undefined };
    }
    if (isNonRetryableClientResponse(response?.status, error)) {
      return { response, used: attempts, error: undefined };
    }
    lastResponse = response;
    lastError = error;
  }

  if (lastResponse) return { response: lastResponse, used: attempts, error: undefined };
  return {
    response: undefined,
    used: attempts,
    error: lastError ?? new Error('no usable upstream nodes'),
  };
}

// Mirrors doUpstreamTiers in internal/gateway/upstream.go:179-241. The anonymous
// phase runs first when the route allows it, then the preferred key tiers. Every
// phase shares the request signal, and an exhausted budget stops the scan
// before firing attempts that could not succeed.
async function runTiers(
  options: ZenUpstreamOptions,
  route: ZenRoute,
  request: ZenRequest,
  ids: ZenRequestIds,
  attemptOffset: number,
  overrides?: Partial<Record<ZenTier, Record<string, unknown>>>,
): Promise<ZenUpstreamResult> {
  let lastResponse: ZenHttpResponse | undefined;
  let lastError: unknown;
  let effectiveRoute = route;
  let attempts = attemptOffset;

  if (route.anonymous && options.anonymousPool) {
    const anonymous = await doAnonymousUpstream(
      options,
      route,
      request,
      ids,
      attempts,
      overrides?.['zen'],
    );
    attempts += anonymous.used;
    if (
      anonymous.error === undefined &&
      anonymous.response &&
      isSuccess(anonymous.response.status)
    ) {
      return { response: anonymous.response, effectiveRoute: route, attempts };
    }
    lastResponse = anonymous.response;
    lastError = anonymous.error;
  }

  if (isAborted(ids.signal)) {
    if (lastResponse) return { response: lastResponse, effectiveRoute, attempts };
    return { response: undefined, effectiveRoute, attempts, error: lastError ?? abortError() };
  }

  const keyTiers = resolveKeyTiers(route);
  for (const tier of keyTiers) {
    if (lastResponse) {
      drain(lastResponse);
      lastResponse = undefined;
    }
    const keyRoute: ZenRoute = {
      ...route,
      tier,
      anonymous: false,
      protocol: protocolForTier(route, tier),
    };
    effectiveRoute = keyRoute;
    const result = await doKeyUpstream(
      options,
      keyRoute,
      request,
      ids,
      attempts,
      overrides?.[tier],
    );
    attempts += result.used;
    if (result.error === undefined && result.response && isSuccess(result.response.status)) {
      return { response: result.response, effectiveRoute: keyRoute, attempts };
    }
    lastResponse = result.response;
    lastError = result.error;
  }

  if (lastResponse) return { response: lastResponse, effectiveRoute, attempts };
  return {
    response: undefined,
    effectiveRoute,
    attempts,
    error: lastError ?? new Error('no usable upstream route'),
  };
}

// Mirrors the keyTiers default in internal/gateway/upstream.go:213-216.
function resolveKeyTiers(route: ZenRoute): ZenTier[] {
  if (
    !route.anonymous &&
    route.keyTiers.length === 0 &&
    (route.tier === 'zen' || route.tier === 'go')
  ) {
    return [route.tier];
  }
  return route.keyTiers;
}

// Mirrors stripStaleReasoningInputs gating in internal/gateway/upstream.go:133-177:
// only Responses bodies carry reasoning references that can be stripped.
function stripTierBodies(
  options: ZenUpstreamOptions,
  route: ZenRoute,
  request: ZenRequest,
): { overrides: Partial<Record<ZenTier, Record<string, unknown>>>; changed: boolean } {
  const overrides: Partial<Record<ZenTier, Record<string, unknown>>> = {};
  let changed = false;
  const tiers = new Set<ZenTier>();
  if (route.anonymous) tiers.add('zen');
  for (const tier of resolveKeyTiers(route)) tiers.add(tier);
  for (const tier of tiers) {
    const protocol = protocolForTier(route, tier);
    if (protocol !== 'responses') continue;
    const body = prepareUpstreamBody(request, protocol);
    applyEffort(options, body, protocol, route.id);
    const stripped = stripStaleReasoningInputs(body);
    if (!stripped.changed) continue;
    overrides[tier] = stripped.body;
    changed = true;
  }
  return { overrides, changed };
}

// Mirrors doUpstream in internal/gateway/upstream.go:55-108: one stale-reasoning
// replay, sharing the request signal and continuing attempt numbering.
export async function doUpstream(
  options: ZenUpstreamOptions,
  route: ZenRoute,
  request: ZenRequest,
  ids: ZenRequestIds,
): Promise<ZenUpstreamResult> {
  const initial = await runTiers(options, route, request, ids, 0);
  const response = initial.response;
  if (!response || response.status !== 400) return initial;

  const errorBody = await readLimitedBody(response);
  response.body = bodyAsIncoming(errorBody);
  if (!isStaleReasoningReference(errorBody.toString('utf8'))) return initial;

  const stripped = stripTierBodies(options, route, request);
  if (!stripped.changed) return initial;

  options.logger?.info?.('retrying upstream without stale reasoning references', {
    component: 'upstream',
    event: 'reasoning_reference_retry',
    request_id: ids.request,
    model: route.id,
    tier: initial.effectiveRoute.tier,
    attempt_offset: initial.attempts,
  });

  const replay = await runTiers(
    options,
    initial.effectiveRoute,
    request,
    ids,
    initial.attempts,
    stripped.overrides,
  );
  if (replay.error !== undefined || !replay.response || !isSuccess(replay.response.status)) {
    if (replay.response) drain(replay.response);
    options.logger?.warn?.('reasoning reference retry failed; returning original error', {
      component: 'upstream',
      event: 'reasoning_reference_retry_failed',
      request_id: ids.request,
      model: route.id,
      tier: initial.effectiveRoute.tier,
    });
    return { response, effectiveRoute: initial.effectiveRoute, attempts: initial.attempts };
  }
  return replay;
}

// Streamed execution uses the same routing state machine. On success the caller
// receives the raw upstream body for SSE parsing; the protocol-appropriate raw
// chunk backfill (StreamChunk.raw) is performed by the gateway runtime in G4,
// which is the layer that knows the client protocol.
export async function doUpstreamStream(
  options: ZenUpstreamOptions,
  route: ZenRoute,
  request: ZenRequest,
  ids: ZenRequestIds,
): Promise<ZenUpstreamStreamResult> {
  const result = await doUpstream(options, route, request, ids);
  if (result.error === undefined && result.response && isSuccess(result.response.status)) {
    return {
      body: result.response.body,
      status: result.response.status,
      headers: result.response.headers,
      effectiveRoute: result.effectiveRoute,
      attempts: result.attempts,
    };
  }
  if (result.response) drain(result.response);
  throw result.error ?? new Error('upstream request failed');
}

// Minimal port of transportPool.CheckHealth in internal/gateway/pool.go:190-242.
// Only unhealthy proxies are rechecked; any HTTP response proves reachability,
// while a proxy route failure keeps the proxy unhealthy.
export async function checkHealth(
  proxies: ZenProxyTransport[],
  target: string,
  timeoutMs: number,
): Promise<ZenProxyHealthCheckResult[]> {
  const pending = proxies.filter((proxy) => !proxyHealthy(proxy.health));
  return Promise.all(pending.map((proxy) => checkOneProxy(proxy, target, timeoutMs)));
}

// Mirrors checkClaimedProxy in internal/gateway/pool.go:214-238 for one proxy,
// regardless of its current health. checkHealth only visits unhealthy proxies;
// this entrypoint lets the per-request verification recheck the exact proxy that
// just failed, and is also safe to call while it still reads as healthy.
export function checkProxy(
  proxy: ZenProxyTransport,
  target: string,
  timeoutMs: number,
): Promise<ZenProxyHealthCheckResult> {
  return checkOneProxy(proxy, target, timeoutMs);
}

async function checkOneProxy(
  proxy: ZenProxyTransport,
  target: string,
  timeoutMs: number,
): Promise<ZenProxyHealthCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1));
  let error: unknown;
  try {
    const response = await proxy.client.send({
      url: target,
      method: 'GET',
      headers: { 'user-agent': openCodeUserAgent() },
      proxy: proxy.spec,
      signal: controller.signal,
    });
    drainBody(response.body);
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timer);
  }
  const wasHealthy = proxyHealthy(proxy.health);
  if (error === undefined) {
    return { proxy, error, failed: false, wasHealthy: setProxyHealthy(proxy.health, true) };
  }
  if (isProxyFailure(error)) {
    return { proxy, error, failed: true, wasHealthy: setProxyHealthy(proxy.health, false) };
  }
  return { proxy, error, failed: false, wasHealthy };
}
