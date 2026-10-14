import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { ZenHttpClient, ZenHttpRequest, ZenHttpResponse } from '../http.js';
import { canonicalSessionId } from '../identity/session.js';
import {
  FREE_MODEL_CHECK_INTERVAL_MS,
  type ZenAvailabilityStore,
  type ZenEffortProbe,
} from '../models/availability.js';
import type { ZenCatalog } from '../models/catalog.js';
import type { ZenTier } from '../models/types.js';
import { prepareAnonymousBody } from '../protocol/agent.js';
import { applyForcedEffort } from '../protocol/effort.js';
import { prepareRequest } from '../protocol/request.js';
import {
  collapseChunks,
  parseAnthropicChunk,
  parseChatChunk,
  parseResponsesChunk,
  SseParser,
} from '../protocol/stream.js';
import type { ZenProtocol, ZenRequest, ZenStreamChunk } from '../protocol/types.js';
import type { ZenAnonymousPool, ZenKeyPool, ZenProxyTransport } from './pool.js';
import { buildUpstreamRequest, type ZenRequestIds } from './upstream.js';

/** Budget for one probe attempt. Mirrors the 60s timeout in upstream probe.go. */
export const PROBE_TIMEOUT_MS = 60_000;

const ANONYMOUS_KEY = 'public';
const ERROR_BODY_LIMIT = 64 * 1024;
const RESPONSE_BODY_LIMIT = 1024 * 1024;
// Highest reasoning level first; the baseline (no effort field) is probed
// before the ladder, so the last entry never needs an extra request.
const EFFORT_LADDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'] as const;

export interface ZenProbeResult {
  success: boolean;
  attempted: boolean;
  effortRejected: boolean;
  reason: string;
  channel: string;
  effort: ZenEffortProbe;
}

export interface ZenProbeOptions {
  catalog: ZenCatalog;
  pools: Partial<Record<ZenTier, ZenKeyPool>>;
  anonymousPool?: ZenAnonymousPool;
  anonymous: boolean;
  upstream: { zen: string; go: string };
  forcedEffort: (model: string) => string;
  now?: () => number;
}

export interface ZenEffortResolution {
  forcedEffort: (model: string) => string;
  availability: ZenAvailabilityStore;
  catalog: ZenCatalog;
  now: () => number;
}

export interface ZenAvailabilityCheckerOptions {
  store: ZenAvailabilityStore;
  catalog: ZenCatalog;
  probe: (model: string) => Promise<ZenProbeResult>;
  now?: () => number;
  /** Scheduler tick, mirroring the one-minute ticker in upstream availability.go. */
  intervalMs?: number;
}

interface ProbeLane {
  key: string;
  name: string;
  client: ZenHttpClient;
  proxy: ZenProxyTransport;
}

function emptyResult(reason: string): ZenProbeResult {
  return {
    success: false,
    attempted: false,
    effortRejected: false,
    reason,
    channel: '',
    effort: {},
  };
}

function headerText(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Mirrors isModelUnavailable in internal/gateway/probe.go: only these statuses
// can carry evidence that the model itself is gone from the upstream catalog.
export function isModelUnavailable(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 410 && status !== 422) return false;
  const text = body.toLowerCase();
  const markers = [
    'model_not_found',
    'model_not_available',
    'model_retired',
    'model_deprecated',
    'unknown model',
    'model does not exist',
    'model has been retired',
    'model is no longer available',
  ];
  return markers.some((marker) => text.includes(marker));
}

// Mirrors isEffortRejection: a 4xx that talks about effort/thinking/reasoning
// and rejects it proves the requested level, not the model, is unavailable.
export function isEffortRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const text = body.toLowerCase();
  if (!text.includes('effort') && !text.includes('thinking') && !text.includes('reasoning')) {
    return false;
  }
  const markers = [
    'invalid',
    'unsupported',
    'not support',
    'not allowed',
    'must be',
    'allowed values',
  ];
  return markers.some((marker) => text.includes(marker));
}

async function readLimitedBody(body: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    const remaining = limit - size;
    if (buffer.length >= remaining) {
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      break;
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  if (typeof body.resume === 'function') body.resume();
  return Buffer.concat(chunks).toString('utf8');
}

function parseChunk(protocol: ZenProtocol, payload: unknown): ZenStreamChunk {
  switch (protocol) {
    case 'anthropic':
      return parseAnthropicChunk(payload);
    case 'responses':
      return parseResponsesChunk(payload);
    default:
      return parseChatChunk(payload);
  }
}

// A 2xx SSE body must carry parseable frames and a termination marker; our SSE
// parser is protocol-agnostic, so both the chat `[DONE]` sentinel and the
// anthropic `message_stop` event count as the end of the stream.
function validateSse(protocol: ZenProtocol, text: string): Error | undefined {
  const parser = new SseParser();
  const chunks: ZenStreamChunk[] = [];
  let terminated = false;
  for (const event of parser.push(text)) {
    if (event.data === '[DONE]') {
      terminated = true;
      continue;
    }
    if (event.event === 'message_stop') terminated = true;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return new Error(`upstream stream sent malformed JSON: ${event.data}`);
    }
    chunks.push(parseChunk(protocol, payload));
  }
  if (!terminated && chunks.length === 0) {
    return new Error('upstream stream carried no frames');
  }
  collapseChunks(chunks);
  return undefined;
}

function validateJson(protocol: ZenProtocol, text: string): Error | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return new Error('upstream returned a malformed JSON document');
  }
  if (!isPlainRecord(document) || document['error'] !== undefined) {
    const detail = isPlainRecord(document) ? document['error'] : document;
    return new Error(`upstream error envelope: ${JSON.stringify(detail ?? null)}`);
  }
  const field =
    protocol === 'anthropic' ? 'content' : protocol === 'responses' ? 'output' : 'choices';
  if (!Array.isArray(document[field])) return new Error('invalid response schema');
  return undefined;
}

// Mirrors probePayload: a chat-shaped request converted to the lane protocol,
// optionally carrying a trial effort, then normalized to anonymous shape.
function probeBody(model: string, protocol: ZenProtocol, effort: string): Record<string, unknown> {
  const request: ZenRequest = {
    model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    max_tokens: 64,
    stream: true,
  };
  const converted = prepareRequest(request, protocol);
  if (effort !== '') applyForcedEffort(converted, protocol, effort);
  return prepareAnonymousBody(converted, protocol);
}

async function probeAttempt(
  lane: ProbeLane,
  model: string,
  protocol: ZenProtocol,
  session: string,
  effort: string,
  options: ZenProbeOptions,
): Promise<ZenProbeResult> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const ids: ZenRequestIds = {
    request: `req_${randomUUID().replace(/-/g, '')}`,
    session,
    project: 'prj_opencode2api_default',
    signal,
  };
  const request: ZenHttpRequest = buildUpstreamRequest(
    options.upstream.zen,
    protocol,
    probeBody(model, protocol, effort),
    ids,
    lane.key,
    lane.proxy.spec,
  );
  let response: ZenHttpResponse;
  try {
    response = await lane.client.send(request);
  } catch (error) {
    const timedOut =
      signal.aborted || (error as { name?: string } | undefined)?.name === 'TimeoutError';
    return emptyResult(timedOut ? 'probe_timeout' : 'transport_error');
  }
  const result: ZenProbeResult = { ...emptyResult(''), attempted: true };
  if (Math.floor(response.status / 100) !== 2) {
    const text = await readLimitedBody(response.body, ERROR_BODY_LIMIT);
    result.reason = `http_${response.status}`;
    result.effortRejected = isEffortRejection(response.status, text);
    if (isModelUnavailable(response.status, text)) result.reason = 'model_unavailable';
    return result;
  }
  const text = await readLimitedBody(response.body, RESPONSE_BODY_LIMIT);
  const contentType = headerText(response.headers['content-type']).toLowerCase();
  const invalid = contentType.includes('text/event-stream')
    ? validateSse(protocol, text)
    : validateJson(protocol, text);
  result.success = invalid === undefined && !signal.aborted;
  result.reason = 'probe_succeeded';
  if (!result.success) {
    result.reason = 'invalid_or_incomplete_response';
    if (invalid) {
      result.effortRejected = isEffortRejection(400, invalid.message);
      if (isModelUnavailable(400, invalid.message)) result.reason = 'model_unavailable';
    }
    if (signal.aborted) result.reason = 'probe_timeout';
  }
  return result;
}

// Mirrors the lane assembly in probeFreeModel: the anonymous lane first, then
// one zen key lane, each pinned to the model's canonical availability session.
function lanesFor(options: ZenProbeOptions, session: string, now: number): ProbeLane[] {
  const lanes: ProbeLane[] = [];
  if (options.anonymous && options.anonymousPool) {
    const node = options.anonymousPool.cursorFor(session).next(now);
    if (node) {
      lanes.push({
        key: ANONYMOUS_KEY,
        name: 'anonymous',
        client: node.proxy.client,
        proxy: node.proxy,
      });
    }
  }
  const pool = options.pools.zen;
  if (pool && pool.len() > 0) {
    const node = pool.cursorFor(session).next(now);
    const proxy = node ? pool.proxy(node) : undefined;
    if (node && proxy) lanes.push({ key: node.key, name: 'zen', client: proxy.client, proxy });
  }
  return lanes;
}

// The effort ladder walks down from the highest level; a trial that is
// explicitly rejected proves a lower level is required, while an inconclusive
// trial (rate limit, 5xx) proves nothing and stops the ladder.
async function probeEffortLadder(
  run: (effort: string) => Promise<ZenProbeResult>,
  catalog: ZenCatalog,
  model: string,
  protocol: ZenProtocol,
): Promise<ZenEffortProbe> {
  if (!catalog.metadataForTier(model, 'zen')?.reasoning) {
    // Without reasoning metadata there is nothing to discover: the baseline
    // already proved the model answers without an effort field.
    return { effort: 'none', protocol };
  }
  let effort: ZenEffortProbe = {};
  for (const level of EFFORT_LADDER) {
    const trial = await run(level);
    if (trial.success) return { effort: level, protocol };
    // A rate limit or timeout gives no evidence that a lower level is needed.
    if (!trial.effortRejected) return effort;
    effort = { reset: true };
  }
  // Every real level was rejected: the model only accepts the baseline.
  return { effort: 'none', protocol };
}

/**
 * Probe one free model once and report what the upstream said. Port of
 * `Gateway.probeFreeModel` in internal/gateway/probe.go.
 */
export async function probeFreeModel(
  options: ZenProbeOptions,
  model: string,
): Promise<ZenProbeResult> {
  if (!options.catalog.isFreeModel(model)) return emptyResult('not_free');
  if (!options.catalog.advertisedOn(model, 'zen') || !options.catalog.supported(model)) {
    return emptyResult('unsupported_probe');
  }
  const protocol = options.catalog.protocolFor(model, 'zen');
  const session = canonicalSessionId(`availability:${model}`);
  const now = (options.now ?? Date.now)();
  let result = emptyResult('no_probe_channel');
  let inconclusive = '';
  for (const lane of lanesFor(options, session, now)) {
    const run = (effort: string): Promise<ZenProbeResult> =>
      probeAttempt(lane, model, protocol, session, effort, options);
    result = await run('');
    result.channel = lane.name;
    if (result.success && options.forcedEffort(model) === 'auto') {
      result.effort = await probeEffortLadder(run, options.catalog, model, protocol);
    }
    // One lane's auth or transient failure cannot establish global
    // unavailability, so only an unanimous `model_unavailable` survives.
    if (result.reason !== 'model_unavailable') inconclusive = result.reason;
  }
  if (inconclusive !== '') result.reason = inconclusive;
  return result;
}

/**
 * Resolve the effort actually sent upstream. A configured non-auto effort is
 * returned verbatim; `auto` transfers the level a probe confirmed, and only
 * when every guard (tier, protocol, freshness, availability) still holds.
 */
export function resolvedEffort(
  deps: ZenEffortResolution,
  model: string,
  tier: ZenTier,
  protocol: ZenProtocol,
): string {
  const configured = deps.forcedEffort(model);
  if (configured !== 'auto') return configured;
  // Only the free zen lane is actively probed. Never transfer observations to
  // a different protocol/tier, or guess a level for an unprobed model.
  if (tier !== 'zen' || !deps.catalog.isFreeModel(model)) return '';
  if (!deps.catalog.metadataForTier(model, tier)?.reasoning) return '';
  const item = deps.availability.get(model);
  const effort = item.autoEffort?.effort;
  if (effort === undefined || effort === 'none') return '';
  if (item.disabled || item.autoEffort?.protocol !== protocol) return '';
  if (deps.now() - (item.effortCheckedAt ?? 0) > 2 * FREE_MODEL_CHECK_INTERVAL_MS) return '';
  return effort;
}

/**
 * Scheduled sweep over the free models, ported from `checkFreeModels` in
 * internal/gateway/availability.go: manual and not-yet-due models are skipped,
 * and an unattempted probe leaves the previous schedule untouched.
 */
export class ZenAvailabilityChecker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly store: ZenAvailabilityStore;
  private readonly catalog: ZenCatalog;
  private readonly probe: (model: string) => Promise<ZenProbeResult>;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(options: ZenAvailabilityCheckerOptions) {
    this.store = options.store;
    this.catalog = options.catalog;
    this.probe = options.probe;
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = Math.max(1, options.intervalMs ?? 60_000);
  }

  async checkOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const model of this.catalog.list()) {
        if (!this.catalog.isFreeModel(model)) continue;
        const item = this.store.get(model);
        if (item.manual) continue;
        const now = this.now();
        if (item.nextCheck > now) continue;
        let result: ZenProbeResult;
        try {
          result = await this.probe(model);
        } catch {
          continue;
        }
        if (!result.attempted) continue;
        await this.store.record(
          model,
          item.generation,
          result.success,
          result.reason,
          result.channel,
          this.now(),
          result.effort,
        );
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.checkOnce();
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.intervalMs);
    // The scheduler must never be the reason a process stays alive.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
