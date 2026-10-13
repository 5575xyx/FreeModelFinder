import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  asModelList,
  chatResponseToOpenAI,
  composeModelId,
  estimateInputTokens,
  extractMaxTokensLimit,
  isContextLengthExceededError,
  isMaxTokensTooLargeError,
  isVisionCapable,
  openAIToChatRequest,
  parseModelUnavailableError,
  parseRateLimitError,
  retryAfterSeconds,
  scoreModel,
  sessionKeyOf,
  streamChunkToOpenAI,
  usageCaptureStore,
  type AutoRouter,
  type CallLogEntry,
  type CallLogger,
  type CallStatus,
  type ChatRequest,
  type ChatResponse,
  type GatewayKeyEntry,
  type ImageGenerationRequest,
  type ModelInfo,
  type OpenAIChatCompletionRequest,
  type ProviderId,
  type ProviderRegistry,
  type StreamChunk,
  type SwitchNotice,
  type VideoGenerationRequest,
} from '@freemodelfinder/core';

function extractBearer(req: FastifyRequest): string | null {
  // `req` can be a bare object without `headers` — route-level tests call the
  // handler directly. That means "no credentials presented", not a crash.
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xKey = headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.trim()) return xKey.trim();
  const googKey = headers['x-goog-api-key'];
  if (typeof googKey === 'string' && googKey.trim()) return googKey.trim();
  return null;
}

function keysEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.equals(right);
}

// Exported so the other gateway routes can resolve a caller's allowlist too.
export function resolveGatewayKey(
  reg: ProviderRegistry,
  req: FastifyRequest,
): GatewayKeyEntry | undefined {
  const provided = extractBearer(req);
  if (!provided) return undefined;
  const gw = reg.getConfig().gateway;
  const keys: GatewayKeyEntry[] = gw?.keys?.length
    ? gw.keys
    : gw?.apiKey
      ? [{ id: 'default', key: gw.apiKey, createdAt: 0 }]
      : [];
  const now = Date.now();
  for (const entry of keys) {
    // A malformed entry (a key that failed decryption and came back '' or
    // undefined) must be skipped, not compared: Buffer.from(undefined) throws
    // ERR_INVALID_ARG_TYPE. Mirrors findMatchingGatewayKey in server.ts so both
    // paths match the same entry — otherwise preHandler authorises the request
    // and the handler then 500s it.
    if (!entry.key) continue;
    if (entry.expiresAt && entry.expiresAt < now) continue;
    if (keysEqual(provided, entry.key)) return entry;
  }
  return undefined;
}

function resolveGatewayKeyId(reg: ProviderRegistry, req: FastifyRequest): string | undefined {
  return resolveGatewayKey(reg, req)?.id;
}

/**
 * Allowlist set for a gateway key, or null when the key is unrestricted.
 *
 * Missing, empty, or all-invalid allowlists all mean "no restriction" — that is
 * the documented default and the thing that must not regress.
 *
 * Entries are trimmed and lowercased: the router compares model ids in
 * lowercase everywhere, so a mixed-case entry would otherwise never match.
 */
export function keyModelAllowlist(key: GatewayKeyEntry | undefined): Set<string> | null {
  const list = key?.modelAllowlist;
  if (!list?.length) return null;
  const ids = list.filter((id): id is string => typeof id === 'string' && !!id.trim());
  return ids.length ? new Set(ids.map((id) => id.trim().toLowerCase())) : null;
}

/**
 * Returns a human-readable denial reason, or null when the model is permitted.
 *
 * Allowlists are keyed on the REAL composed id, so the request is resolved all
 * the way through the alias chain first.
 *
 * `auto` is permitted for restricted keys too: the automatic pick itself is
 * constrained to this allowlist downstream (`buildFallbackChain`,
 * `rankCandidates`, the modality pools), so `auto` can only ever land on a
 * listed model. Refusing it here would make `auto` unusable for every
 * allowlisted key, which is not what a model allowlist is for.
 *
 * `default` is NOT special-cased: it resolves to the configured default model,
 * which is then checked like any other concrete model. So a key may use
 * `default` when — and only when — the default model is on its list.
 *
 * `model` is used RAW, never trimmed, because the handler resolves and
 * dispatches the same raw value. Authorization and dispatch have to agree
 * byte-for-byte; trimming here would let a padded `" auto"` quietly become
 * automatic routing instead of an unknown model. Config values ARE trimmed,
 * because a hand-edited config is allowed to be sloppy where a request is not.
 */
export function modelAllowlistViolation(
  reg: ProviderRegistry,
  key: GatewayKeyEntry | undefined,
  model: string | null | undefined,
): string | null {
  const allowlist = keyModelAllowlist(key);
  if (!allowlist || !model) return null;
  // Do not trim `model`: the handler resolves and dispatches the raw value, so
  // authorization and dispatch must see byte-identical strings. A stray space is
  // reported as "not allowed" rather than silently forgiven — forgiving it would
  // make `model: " auto"` a working misspelling of automatic routing.
  if (model === 'auto') return null;
  let real: string;
  try {
    const resolved = reg.resolveModel(model);
    real = composeModelId(resolved.provider.id, resolved.modelId).toLowerCase();
  } catch {
    // The provider is not enabled or configured. Leave the error to the
    // handler, which reports it with its normal message.
    return null;
  }
  if (allowlist.has(real)) return null;
  return `This API key is not allowed to use model "${model}". Allowed models: ${[...allowlist].join(', ')}.`;
}

/**
 * Whether a model id — catalog-native (e.g. `"fx:fast"`, `"gpt-4o-mini"`) or
 * already composed (e.g. `"custom:fx:fast"`) — is inside the caller's
 * allowlist.
 *
 * Allowlists hold composed ids while the catalog keeps provider-native ids, so
 * the composed form has to be built before the comparison. An id that is not in
 * the catalog (e.g. an id configured straight into `autoRoute.visionModel`) is
 * compared as-is, which keeps hand-configured ids working.
 */
export function withinAllowlist(
  id: string,
  allowlist: Set<string> | null,
  catalog: ModelInfo[],
): boolean {
  if (!allowlist) return true;
  const match = catalog.find((m) => m.id === id);
  const composed = match ? composeModelId(match.provider, match.id) : id;
  return allowlist.has(composed.toLowerCase());
}

export function classifyStatus(err: unknown): { status: CallStatus; httpStatus?: number } {
  // Exhaustion summaries mention "rate-limited" counts, which would trip the
  // rate-limit detector below; they are hard failures (503), never 429.
  if (err instanceof CandidatesExhaustedError) return { status: 'error', httpStatus: 503 };
  const parsed = parseRateLimitError(err);
  if (parsed.isRateLimit) return { status: 'rate_limited', httpStatus: 429 };
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/failed\s+(\d{3})/i);
  const upstream = match ? Number(match[1]) : undefined;
  return { status: 'error', httpStatus: upstream };
}

export type FailureKind = 'unavailable' | 'rate-limit' | 'context' | 'request' | 'upstream';

/**
 * The outgoing status line and error type for a dispatch failure.
 *
 * Shared by every protocol so that "the pool is exhausted" and "one upstream
 * rate-limited me" read identically on each route. Before this existed each
 * protocol had its own mapping, and an exhausted pool on `/v1/messages` came
 * back looking exactly like a single rate limit.
 */
export function dispatchFailureShape(err: unknown): {
  httpStatus: number;
  type: 'model_unavailable' | 'upstream_error';
  retryAfter: number | null;
} {
  if (err instanceof CandidatesExhaustedError) {
    return { httpStatus: 503, type: 'model_unavailable', retryAfter: err.retryAfter };
  }
  const retryAfter = retryAfterSeconds(err);
  return {
    httpStatus: retryAfter !== null ? 429 : 502,
    type: 'upstream_error',
    retryAfter,
  };
}

export function classifyFailure(err: unknown): { kind: FailureKind; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (parseRateLimitError(err).isRateLimit) return { kind: 'rate-limit', message };
  const unavailable = parseModelUnavailableError(err);
  if (unavailable.isModelUnavailable) {
    return { kind: 'unavailable', message: unavailable.message };
  }
  if (isContextLengthExceededError(err)) return { kind: 'context', message };
  const match = message.match(/failed\s+(\d{3})/i);
  const status = match ? Number(match[1]) : undefined;
  if (status !== undefined && status >= 400 && status < 500) return { kind: 'request', message };
  return { kind: 'upstream', message };
}

export class CandidatesExhaustedError extends Error {
  constructor(
    readonly tried: number,
    readonly counts: { unavailable: number; rateLimit: number; upstream: number },
    readonly triedIds: string[],
    /**
     * The last candidate's failure. Kept so its back-off hint survives the walk:
     * the composed message names every candidate but carries no timing of its own.
     */
    readonly lastError?: unknown,
  ) {
    super(
      `tried ${tried} models: ${counts.unavailable} unavailable, ${counts.rateLimit} rate-limited, ${counts.upstream} upstream errors (attempted: ${triedIds.join(', ')})`,
    );
    this.name = 'CandidatesExhaustedError';
  }

  /**
   * The last rate-limited candidate's back-off hint, or null.
   *
   * Without it a caller whose entire pool is cooling gets a 503 and no idea
   * when to try again — the very information the router already computed.
   */
  get retryAfter(): number | null {
    return retryAfterSeconds(this.lastError);
  }
}

export type FailoverSeq = {
  ranked: ModelInfo[] | null;
  attempts: number;
  counts: { unavailable: number; rateLimit: number; upstream: number };
  triedIds: string[];
};

export function newFailoverSeq(): FailoverSeq {
  return {
    ranked: null,
    attempts: 0,
    counts: { unavailable: 0, rateLimit: 0, upstream: 0 },
    triedIds: [],
  };
}

/**
 * Snapshot the healthy ranked pool (BEFORE marking the current failure so
 * the failed model stays findable for ring positioning), record the failure,
 * apply the mark, then return the next candidate walking the ring. Returns
 * null once every candidate has been attempted.
 *
 * Shared by all three gateway protocols so that "the pool is exhausted" means
 * the same thing on every route. A restricted key can reach here, so the walk
 * has to be given the allowlist — otherwise it would step onto a model the key
 * is not entitled to.
 */
export async function advanceFailover(
  router: AutoRouter,
  seq: FailoverSeq,
  failedKey: string,
  kind: FailureKind,
  mark: () => void,
  allowed?: Set<string> | null,
): Promise<ModelInfo | null> {
  seq.ranked ??= await router.rankCandidates(allowed);
  seq.attempts++;
  seq.triedIds.push(failedKey);
  if (kind === 'unavailable') seq.counts.unavailable++;
  else if (kind === 'rate-limit') seq.counts.rateLimit++;
  else seq.counts.upstream++;
  mark();
  if (seq.attempts >= seq.ranked.length) return null;
  const idx = seq.ranked.findIndex((m) => composeModelId(m.provider, m.id) === failedKey);
  return seq.ranked[(idx + 1) % seq.ranked.length] ?? null;
}

export function buildFailoverNotice(
  router: AutoRouter,
  kind: FailureKind,
  failedKey: string,
  next: ModelInfo,
): SwitchNotice {
  const to = composeModelId(next.provider, next.id);
  const cause =
    kind === 'unavailable' || kind === 'rate-limit' || kind === 'context' ? kind : 'upstream';
  const reason =
    kind === 'rate-limit'
      ? `⚠️ 模型 "${failedKey}" 已被限流（冷却中），已自动切换到：${to}`
      : kind === 'unavailable'
        ? `⚠️ 模型 "${failedKey}" 上游不可用，已永久剔除并自动切换到：${to}`
        : kind === 'context'
          ? `⚠️ 模型 "${failedKey}" 上下文超出窗口，已自动切换到：${to}`
          : `⚠️ 模型 "${failedKey}" 上游请求失败，已自动切换到：${to}`;
  return {
    type: 'switch-away',
    from: failedKey,
    to,
    strategy: router.getStrategy(),
    reason,
    cause,
  };
}

async function dispatchWithAutoRoute(
  reg: ProviderRegistry,
  chatReq: ChatRequest,
  scope: { requestedModel: string; poolWalk: boolean },
  /**
   * Restricted composed model ids for the caller's gateway key, or null for an
   * unrestricted caller. Failover must stay inside it: `preflight` and the
   * post-429 switch both replace `chatReq.model`, and a swap outside the list
   * would bypass the allowlist with a 200.
   */
  allowed?: Set<string> | null,
): Promise<{
  finalModel: string;
  finalProviderId: string;
  response: ChatResponse;
  notices: SwitchNotice[];
  sticky: boolean;
  pool: string[];
}> {
  const router = reg.getAutoRouter();
  const notices: SwitchNotice[] = [];
  const originalRequested = chatReq.model;
  // Walk the pool only when the CLIENT asked for auto (modality rewrites such
  // as vision/tier picks must not turn a concrete model into an auto request)
  // and no modality-specific dispatch owns the request.
  const isAutoRequest = scope.requestedModel === 'auto' || scope.requestedModel === 'default';
  const allowPoolWalk = scope.poolWalk && isAutoRequest;
  const seq = newFailoverSeq();
  let stickyHit = false;
  let routePool: string[] = [];
  const routeOpts = isAutoRequest
    ? {
        inputTokens: estimateInputTokens(chatReq),
        sessionKey: sessionKeyOf(chatReq.messages),
        allowed,
        onPick: (info: { sticky: boolean; pool: string[] }) => {
          stickyHit = info.sticky;
          routePool = info.pool;
        },
      }
    : undefined;

  // 1. Pre-flight: honor existing cooldowns before we even try upstream.
  const pre = await router.preflight(chatReq.model, allowed);
  if (pre.switched) {
    // The substitute must be re-composed with ITS provider prefix: a bare
    // catalog id (e.g. "agnes-3.0-flash") matches no resolveModel heuristic
    // and would silently fall through to the openrouter default.
    chatReq.model = composeModelId(pre.model.provider, pre.model.id);
    notices.push(pre.notice);
  }

  // 2. Resolve provider & dispatch. Auto requests keep walking the scored
  //    pool until every candidate has been tried; explicit requests fail
  //    fast (the original one-shot rate-limit switch still applies).
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resolved = reg.resolveModel(chatReq.model, routeOpts);
    const provider = resolved.provider;
    const realModelId = resolved.modelId;
    const dispatchReq: ChatRequest = { ...chatReq, model: realModelId };

    try {
      const res = await provider.chat(dispatchReq);
      const switchBack = await router.maybeSwitchBack(chatReq.model);
      if (switchBack) notices.push(switchBack);
      return {
        finalModel: `${provider.id}:${realModelId}`,
        finalProviderId: provider.id,
        response: res,
        notices,
        sticky: stickyHit,
        pool: routePool,
      };
    } catch (err) {
      const failure = classifyFailure(err);
      const failedKey = `${provider.id}:${realModelId}`;
      const mark = () => {
        if (failure.kind === 'unavailable') {
          router.markModelUnavailable(realModelId, provider.id, failure.message);
        } else if (failure.kind === 'rate-limit') {
          router.markRateLimited(realModelId, provider.id, parseRateLimitError(err));
        } else if (failure.kind === 'context') {
          router.markContextOverflow(realModelId, provider.id, failure.message);
        }
      };

      if (allowPoolWalk && router.isEnabled() && failure.kind !== 'request') {
        const next = await advanceFailover(router, seq, failedKey, failure.kind, mark, allowed);
        if (next) {
          router.rememberPreference(originalRequested);
          const notice = buildFailoverNotice(router, failure.kind, failedKey, next);
          router.notify(notice);
          notices.push(notice);
          chatReq.model = composeModelId(next.provider, next.id);
          if (routeOpts) router.setSticky(routeOpts.sessionKey, next.provider, next.id);
          continue;
        }
        // Pin the last attempted key before leaving: the handler catch records
        // this call via resolvePM(chatReq.model), and a leftover `auto` would
        // consume a fresh pool pick while merely logging the failure.
        chatReq.model = failedKey;
        throw new CandidatesExhaustedError(seq.attempts, seq.counts, seq.triedIds, err);
      }

      // Explicit (or router disabled / request-shape errors): mark, then the
      // legacy one-shot rate-limit switch for explicit models still applies.
      mark();
      const parsed = parseRateLimitError(err);
      if (parsed.isRateLimit && router.isEnabled() && attempt === 0) {
        const fallback = await router.pickFallback(failedKey, allowed);
        if (fallback) {
          router.rememberPreference(originalRequested);
          const notice: SwitchNotice = {
            type: 'switch-away',
            from: failedKey,
            to: composeModelId(fallback.provider, fallback.id),
            strategy: router.getStrategy(),
            reason: router.buildSwitchAwayMessage(
              {
                model: failedKey,
                provider: provider.id,
                hitAt: Date.now(),
                resetAt: parsed.resetAt ?? Date.now() + 60_000,
                message: parsed.message,
              },
              fallback,
            ),
            resetAt: parsed.resetAt,
            cause: 'rate-limit',
          };
          router.notify(notice);
          notices.push(notice);
          chatReq.model = composeModelId(fallback.provider, fallback.id);
          attempt++;
          continue;
        }
      }
      // Same pin as the exhaustion throw above: a request-shape or router
      // disabled failure leaves `auto` in chatReq.model, and the handler catch
      // would resolve it again (re-rolling the pool) just to log the call.
      chatReq.model = failedKey;
      throw err;
    }
  }
}

type RequestModality = 'text' | 'image' | 'video' | 'vision';

export function detectRequestModality(
  messages: OpenAIChatCompletionRequest['messages'],
): RequestModality {
  const VIDEO_KEYWORDS =
    /(生成|制作|创建|做一段?|来一段?|画一段?)[^。\n]{0,12}?(视频|动画|短片|影片|动态|视频片段)/i;
  const IMAGE_TEXT =
    /((生成|绘制|画|创作|做|来一张|来个|帮我画|给我画)[^。\n]{0,12}(图片|图像|照片|插画|插图|壁纸|头像|海报|图画|画像))|((画|做|生成|绘制|创作|来|帮我画|给我画)一?[张幅][^。\n]{0,6}(?<!地)图(?!形))|(generate|draw|create|make)\s+(an?\s+)?[\w\s-]{0,20}(image|picture|photo|illustration|wallpaper|avatar|poster)/i;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'image_url' || part.type === 'image') return 'vision';
      }
      const text = content
        .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
        .join('\n')
        .trim();
      if (!text) continue;
      if (VIDEO_KEYWORDS.test(text)) return 'video';
      if (IMAGE_TEXT.test(text)) return 'image';
      return 'text';
    }
    if (typeof content === 'string') {
      const text = content.trim();
      if (!text) continue;
      if (VIDEO_KEYWORDS.test(text)) return 'video';
      if (IMAGE_TEXT.test(text)) return 'image';
      return 'text';
    }
  }
  return 'text';
}

/**
 * Image/video providers reject prompts above a hard character limit
 * (Agnes: 10000). External tools send the full chat history, so joining
 * every message overflows the limit even though the latest user message
 * alone is a valid prompt. Extract only the latest non-empty user turn.
 */
export function extractGenerationPrompt(messages: ChatRequest['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'user') continue;
    const text = msg.content.trim();
    if (text) return text;
  }
  return '';
}

type TextTier = 'simple' | 'medium' | 'complex';

function classifyTextComplexity(text: string): TextTier {
  let score = 0;
  if (text.length > 500) score += 20;
  if (text.length > 2000) score += 10;
  if (/```[\s\S]*?```/.test(text)) score += 25;
  if (/\b(逐步|一步一步|推理|思考链|chain.of.thought|step.by.step|think\s+through)\b/i.test(text))
    score += 20;
  const questionMarks = (text.match(/[?？]/g) ?? []).length;
  if (questionMarks >= 3) score += 15;
  else if (questionMarks >= 2) score += 8;
  if (/\b(算法|架构|优化|重构|设计模式|复杂度|并发|分布式|数据结构)\b/i.test(text)) score += 10;
  if (/\b(证明|推导|公式|方程|微积分|线性代数|矩阵)\b/i.test(text)) score += 15;
  if (/\b(写一篇|分析.*报告|对比.*优劣|评估|设计方案|技术选型)\b/i.test(text)) score += 10;
  if (score >= 70) return 'complex';
  if (score >= 30) return 'medium';
  return 'simple';
}

async function findImageModelId(reg: ProviderRegistry): Promise<string | null> {
  try {
    const { models } = await reg.listAllModels();
    const byId = models.find((m) => /image/i.test(m.id.split(':').pop() ?? m.id));
    if (byId) return byId.id;
    const byCap = models.find((m) => m.capabilities?.includes('image'));
    return byCap ? byCap.id : null;
  } catch {
    return null;
  }
}

const modalityCursor = new Map<string, number>();

function nextFromPool(slot: string, pool: string[]): string | undefined {
  if (!pool.length) return undefined;
  const cursor = modalityCursor.get(slot) ?? 0;
  const pick = pool[cursor % pool.length]!;
  modalityCursor.set(slot, (cursor + 1) % pool.length);
  return pick;
}

/** Full pool rotated from the shared cursor (for vision failover order). */
function rotatePool(slot: string, pool: string[]): string[] {
  if (!pool.length) return [];
  const cursor = modalityCursor.get(slot) ?? 0;
  const start = cursor % pool.length;
  modalityCursor.set(slot, (start + 1) % pool.length);
  return [...pool.slice(start), ...pool.slice(0, start)];
}

async function withMaxTokensRetry<T>(chatReq: ChatRequest, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMaxTokensTooLargeError(err) && chatReq.max_tokens != null) {
      chatReq.max_tokens = extractMaxTokensLimit(err);
      return await fn();
    }
    throw err;
  }
}

function streamErrorType(msg: string, err: unknown): string {
  if (msg.includes('does not support image input')) return 'vision_input_error';
  if (isMaxTokensTooLargeError(err)) return 'invalid_request_error';
  if (msg.match(/failed\s+\d{3}/i)) return 'upstream_error';
  return 'server_error';
}

/**
 * The `retry_after` field for a streaming error event, or nothing.
 *
 * A stream cannot change the status line after the first byte is out, so the
 * back-off hint has to travel inside the event body instead. Shared with the
 * Anthropic and Gemini routes, which write their own event shapes.
 */
export function streamRetryAfter(err: unknown): { retry_after: number } | Record<string, never> {
  // An exhausted pool is not itself a rate limit, but it remembers the hint the
  // last rate-limited candidate carried.
  const seconds =
    err instanceof CandidatesExhaustedError ? err.retryAfter : retryAfterSeconds(err);
  return seconds === null ? {} : { retry_after: seconds };
}

export function resetModalityCursors(): void {
  modalityCursor.clear();
}

export function registerOpenAIRoutes(
  app: FastifyInstance,
  getRegistry: () => ProviderRegistry,
  options: { includeManagement?: boolean; callLogger?: CallLogger } = {},
) {
  const callLogger = options.callLogger;

  const record = (
    req: FastifyRequest,
    t0: number,
    fields: Omit<CallLogEntry, 'ts' | 'latencyMs' | 'gatewayKeyId'> &
      Partial<Pick<CallLogEntry, 'gatewayKeyId'>>,
  ): void => {
    if (!callLogger) return;
    callLogger.record({
      ...fields,
      ts: Date.now(),
      latencyMs: Date.now() - t0,
      gatewayKeyId: fields.gatewayKeyId ?? resolveGatewayKeyId(getRegistry(), req),
    });
  };

  const resolvePM = (reg: ProviderRegistry, model: string): { provider: string; model: string } => {
    try {
      return { provider: reg.resolveModel(model).provider.id, model };
    } catch {
      return { provider: 'unknown', model };
    }
  };

  app.get('/v1/models', async (_req, reply) => {
    const reg = getRegistry();
    const { models, succeededProviders, failedProviders } = await reg.listAllModels();
    const router = reg.getAutoRouter();
    // Allowlists hold composed ids but the catalog keeps provider-native ids
    // (bare "gpt-4o-mini" for OpenAI-compatible providers, "fx:fast" for custom
    // sources), so the composed form has to be built for the comparison. Both
    // sides are lowercase to match keyModelAllowlist.
    const allowlist = keyModelAllowlist(resolveGatewayKey(reg, _req));
    const visibleModels = allowlist
      ? models.filter((m) => allowlist.has(composeModelId(m.provider, m.id).toLowerCase()))
      : models;
    return reply.send({
      object: 'list',
      data: visibleModels.map((m) => {
        // Externally the client only knows the alias; the real id travels along as
        // alias_of so clients (e.g. the dashboard) can still dispatch the model.
        const clientFacingId = reg.toClientFacingModel(m.id);
        const aliased = clientFacingId !== m.id;
        return {
          id: clientFacingId,
          ...(aliased ? { alias_of: m.id } : {}),
          object: 'model',
          owned_by: m.provider,
          created: Math.floor(Date.now() / 1000),
          display_name: m.displayName,
          context_window: m.contextWindow,
          provider: m.provider,
          free: m.free,
          description: m.description,
          capabilities: m.capabilities,
          capability_score: scoreModel(m, 'capability', router.getProfile(m.id)),
          quota: reg.getModelQuota(m.provider, m.id),
        };
      }),
      fmf: {
        enabled_providers: reg.listEnabledProviders(),
        succeeded_providers: succeededProviders,
        failed_providers: failedProviders,
      },
    });
  });

  if (options.includeManagement !== false) {
    app.get('/api/model-quotas', async () => {
      const reg = getRegistry();
      const { models } = await reg.listAllModels();
      return { data: reg.listModelQuotas(models) };
    });

    app.post(
      '/api/model-quotas/probe',
      async (req: FastifyRequest<{ Body: { model?: string } }>, reply: FastifyReply) => {
        const model = req.body?.model?.trim();
        if (!model) return reply.code(400).send({ error: 'model required' });
        try {
          const reg = getRegistry();
          const quota = await reg.probeModel(model);
          const { models } = await reg.listAllModels();
          const affected = models.filter((item) => item.provider === quota.provider);
          return reply.send({ quota, data: reg.listModelQuotas(affected) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return reply.code(400).send({ error: message });
        }
      },
    );
  }

  app.post(
    '/v1/chat/completions',
    async (req: FastifyRequest<{ Body: OpenAIChatCompletionRequest }>, reply: FastifyReply) => {
      const body = req.body;
      if (!body?.model || !Array.isArray(body?.messages)) {
        return reply.code(400).send({ error: 'model and messages are required' });
      }
      const t0 = Date.now();
      const reg = getRegistry();
      const chatReq = openAIToChatRequest(body);
      // Captured before auto modality rewrites (vision/image/video/text-tier)
      // replace chatReq.model: the pool-walk gate must look at what the client
      // asked for, not at the rewritten model.
      const requestedModel = String(body.model);
      // Resolve an external alias to its target BEFORE preflight so cooldown
      // lookups and markRateLimited are keyed by the resolved model rather than
      // the external name.
      chatReq.model = reg.resolveAlias(chatReq.model);
      // The caller's allowlist, resolved once here. Every failover point below
      // (preflight, the post-429 switch) must stay inside it, or a 200 from a
      // different model would silently bypass the restriction.
      const allowedModels = keyModelAllowlist(resolveGatewayKey(reg, req));

      // Auto-route: detect modality from request content
      let forcedImageModality = false;
      let visionCandidates: string[] = [];
      const cfg = reg.getConfig();
      const ar = cfg.autoRoute;
      const detectedModality = detectRequestModality(body.messages);
      if (chatReq.model === 'auto' || chatReq.model === 'default') {
        if (detectedModality === 'vision') {
          const forced = asModelList(ar?.visionModel);
          const { models } = await reg.listAllModels();
          let pool = forced;
          if (!pool.length) {
            const visionModels = models.filter((m) => isVisionCapable(m, forced));
            if (!visionModels.length) {
              return reply.code(400).send({
                error: {
                  message:
                    'No vision-capable model available. Configure autoRoute.visionModel or enable a model with image input.',
                  type: 'no_vision_model',
                },
              });
            }
            pool = visionModels.map((m) => m.id);
          }
          // A restricted key may only be handed a model on its own list.
          pool = pool.filter((id) => withinAllowlist(id, allowedModels, models));
          visionCandidates = rotatePool('vision', pool);
          if (!visionCandidates.length) {
            return reply.code(400).send({
              error: {
                message:
                  'No vision-capable model available. Configure autoRoute.visionModel or enable a model with image input.',
                type: 'no_vision_model',
              },
            });
          }
          chatReq.model = visionCandidates[0]!;
        } else if (detectedModality === 'image') {
          const { models } = await reg.listAllModels();
          const pool = asModelList(ar?.imageModel).filter((id) =>
            withinAllowlist(id, allowedModels, models),
          );
          const picked = nextFromPool('image', pool);
          if (picked) {
            chatReq.model = picked;
            forcedImageModality = true;
          } else {
            const discovered = await findImageModelId(reg);
            if (discovered && withinAllowlist(discovered, allowedModels, models)) {
              chatReq.model = discovered;
              forcedImageModality = true;
            }
            // 未发现（或不在白名单内）则保持 auto → 原文本链路
          }
        } else if (detectedModality === 'video') {
          const { models } = await reg.listAllModels();
          const pool = asModelList(ar?.videoModel).filter((id) =>
            withinAllowlist(id, allowedModels, models),
          );
          const picked = nextFromPool('video', pool);
          if (picked) chatReq.model = picked;
        } else if (detectedModality === 'text' && ar?.textTiers) {
          const tierText = chatReq.messages.map((m) => m.content).join('\n');
          const tier = classifyTextComplexity(tierText);
          const { models } = await reg.listAllModels();
          const pool = asModelList(ar.textTiers[tier]).filter((id) =>
            withinAllowlist(id, allowedModels, models),
          );
          const picked = nextFromPool(`text:${tier}`, pool);
          if (picked) chatReq.model = picked;
        }
      } else if (detectedModality === 'vision') {
        // A specific model was named but the request carries images that model
        // cannot see. Mirror the auto route instead of letting a text-only model
        // swallow the images: hand the request to the vision pool.
        //
        // Capability is judged on positive evidence only. `isVisionCapable`
        // falls back to an id heuristic when a provider ships no metadata, and
        // that heuristic misses real vision models such as gpt-4o-mini — so a
        // model that merely fails the heuristic is kept. Listing it in
        // autoRoute.visionModel declares it a vision model and exempts it.
        const forced = asModelList(ar?.visionModel);
        const { models } = await reg.listAllModels();
        const named = models.find((m) => m.id === chatReq.model);
        const canSee =
          forced.includes(chatReq.model) || (named ? isVisionCapable(named, forced) : true);
        if (!canSee) {
          const discovered = models.filter((m) => isVisionCapable(m, forced));
          // Allowlists hold composed ids while the catalog keeps provider-native
          // ones, so the composed form must be built before comparing.
          const pool = (forced.length ? forced : discovered.map((m) => m.id)).filter((id) =>
            withinAllowlist(id, allowedModels, models),
          );
          visionCandidates = rotatePool('vision', pool);
          if (visionCandidates.length) chatReq.model = visionCandidates[0]!;
          // Nothing that can see: keep the model the caller named rather than
          // failing. Auto-route 400s here because it owns the choice; a named
          // model is the caller's.
        }
      }

      // Fast-path: infer capabilities from model ID without async calls
      const rawModelId = chatReq.model.split(':').pop() ?? chatReq.model;
      const inferredCaps: ('text' | 'image' | 'video')[] = /vid(eo)?/i.test(rawModelId)
        ? ['video']
        : /image/i.test(rawModelId) || forcedImageModality
          ? ['image']
          : [];

      const prompt = extractGenerationPrompt(chatReq.messages);

      if (inferredCaps.includes('image')) {
        const imageReq: ImageGenerationRequest = {
          model: chatReq.model,
          prompt,
          size: '1024x1024',
          n: 1,
          response_format: 'url',
        };
        try {
          const { response } = await reg.generateImage(imageReq);
          const content = response.data.map((d) => d.url ?? d.b64_json ?? '[image]').join('\n');
          record(req, t0, {
            kind: 'image',
            ...resolvePM(reg, chatReq.model),
            status: 'success',
            httpStatus: 200,
          });
          const payload = {
            id: `chatcmpl-img-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: reg.toClientFacingModel(chatReq.model),
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            fmf_image_response: response,
          };

          if (body.stream) {
            reply.hijack();
            const origin = req.headers.origin;
            reply.raw.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
              ...(origin
                ? {
                    'access-control-allow-origin': origin,
                    'access-control-allow-credentials': 'true',
                    vary: 'Origin',
                  }
                : { 'access-control-allow-origin': '*' }),
            });
            reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
            return;
          }

          return reply.send(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const { status, httpStatus } = classifyStatus(err);
          record(req, t0, {
            kind: 'image',
            ...resolvePM(reg, chatReq.model),
            status,
            httpStatus,
            error: msg,
          });
          return reply.code(502).send({ error: { message: msg, type: 'image_generation_error' } });
        }
      }

      if (inferredCaps.includes('video')) {
        const videoReq: VideoGenerationRequest = {
          model: chatReq.model,
          prompt,
          width: 1152,
          height: 768,
          num_frames: 121,
          frame_rate: 24,
        };
        try {
          const { response } = await reg.generateVideo(videoReq);
          const content = response.video_id
            ? `视频任务已提交，video_id: ${response.video_id}，状态: ${response.status}。请使用 GET /v1/videos/${response.video_id}?provider=${chatReq.model.split(':')[0]} 查询进度。`
            : '视频任务提交失败';
          record(req, t0, {
            kind: 'video',
            ...resolvePM(reg, chatReq.model),
            status: 'success',
            httpStatus: 200,
          });
          const payload = {
            id: `chatcmpl-vid-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: reg.toClientFacingModel(chatReq.model),
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            fmf_video_response: { ...response, provider: chatReq.model.split(':')[0] },
          };

          if (body.stream) {
            reply.hijack();
            const origin = req.headers.origin;
            reply.raw.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
              ...(origin
                ? {
                    'access-control-allow-origin': origin,
                    'access-control-allow-credentials': 'true',
                    vary: 'Origin',
                  }
                : { 'access-control-allow-origin': '*' }),
            });
            reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
            return;
          }

          return reply.send(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const { status, httpStatus } = classifyStatus(err);
          record(req, t0, {
            kind: 'video',
            ...resolvePM(reg, chatReq.model),
            status,
            httpStatus,
            error: msg,
          });
          return reply.code(502).send({ error: { message: msg, type: 'video_generation_error' } });
        }
      }

      if (!chatReq.stream) {
        let usage: ChatResponse['usage'] | undefined;
        try {
          const dispatchOnce = () =>
            usageCaptureStore.run(
              (u) => {
                usage = u;
              },
              async () =>
                dispatchWithAutoRoute(
                  reg,
                  chatReq,
                  {
                    requestedModel,
                    // The vision loop below owns vision requests; let it pick
                    // the next vision candidate instead of the generic pool.
                    poolWalk: visionCandidates.length === 0,
                  },
                  allowedModels,
                ),
            );
          let result;
          if (visionCandidates.length) {
            let lastErr: unknown;
            for (let i = 0; i < visionCandidates.length; i++) {
              chatReq.model = visionCandidates[i]!;
              try {
                result = await withMaxTokensRetry(chatReq, dispatchOnce);
                break;
              } catch (err) {
                lastErr = err;
                if (i < visionCandidates.length - 1) continue;
              }
            }
            if (!result) throw lastErr;
          } else {
            result = await withMaxTokensRetry(chatReq, dispatchOnce);
          }
          const { response, notices, finalModel, sticky, pool } = result;
          const payload = chatResponseToOpenAI(response) as Record<string, unknown> & {
            model?: string;
          };
          payload.model = reg.toClientFacingModel(finalModel);
          if (notices.length > 0) {
            (payload as Record<string, unknown>).fmf_route_notices = notices;
          }
          if (body.model === 'auto') {
            const autoRoute: Record<string, unknown> = {
              picked: finalModel,
              strategy: reg.getAutoRouter().getStrategy(),
            };
            if (pool.length > 0) {
              autoRoute.sticky = sticky;
              autoRoute.pool = pool;
            }
            (payload as Record<string, unknown>).fmf_auto_route = autoRoute;
          }
          const finalUsage = usage ?? response.usage;
          record(req, t0, {
            kind: 'chat',
            ...resolvePM(reg, finalModel),
            status: 'success',
            httpStatus: 200,
            promptTokens: finalUsage?.prompt_tokens,
            completionTokens: finalUsage?.completion_tokens,
            cachedTokens: finalUsage?.prompt_tokens_details?.cached_tokens,
          });
          return reply.send(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (err instanceof CandidatesExhaustedError) {
            record(req, t0, {
              kind: 'chat',
              ...resolvePM(reg, chatReq.model),
              status: 'error',
              httpStatus: 503,
              error: msg,
            });
            // Every candidate was down. When that is rate-limit driven the caller
            // still needs to know when to come back — otherwise it cannot time a
            // retry at all.
            const exhaustedAfter = err.retryAfter;
            if (exhaustedAfter !== null) reply.header('retry-after', String(exhaustedAfter));
            return reply.code(503).send({ error: { message: msg, type: 'model_unavailable' } });
          }
          const match = msg.match(/failed\s+(\d{3})/i);
          const upstream = match ? Number(match[1]) : undefined;
          const { status, httpStatus } = classifyStatus(err);
          const retryAfter = retryAfterSeconds(err);
          record(req, t0, {
            kind: 'chat',
            ...resolvePM(reg, chatReq.model),
            status,
            httpStatus: httpStatus ?? upstream,
            error: msg,
          });
          if (msg.includes('does not support image input')) {
            return reply.code(400).send({
              error: { message: msg, type: 'vision_input_error' },
            });
          }
          // A rate limit is 429 even when the upstream never stated the number,
          // so the header below has something meaningful to attach itself to.
          const code =
            status === 'rate_limited'
              ? 429
              : upstream && upstream >= 400 && upstream < 600
                ? upstream
                : 502;
          if (retryAfter !== null) reply.header('retry-after', String(retryAfter));
          return reply.code(code).send({ error: { message: msg, type: 'upstream_error', upstream } });
        }
      }

      // Streaming path: never interrupt an active stream. Auto requests walk
      // the whole pool only while nothing has been written yet; once the first
      // chunk is out the failure surfaces as an error event instead.
      const origin = req.headers.origin;
      const corsHeaders: Record<string, string> = origin
        ? {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            vary: 'Origin',
          }
        : { 'access-control-allow-origin': '*' };

      const router = reg.getAutoRouter();
      const routeIsAuto = requestedModel === 'auto' || requestedModel === 'default';
      let stickyHit = false;
      let routePool: string[] = [];
      const routeOpts = routeIsAuto
        ? {
            inputTokens: estimateInputTokens(chatReq),
            sessionKey: sessionKeyOf(chatReq.messages),
            allowed: allowedModels,
            onPick: (info: { sticky: boolean; pool: string[] }) => {
              stickyHit = info.sticky;
              routePool = info.pool;
            },
          }
        : undefined;
      const originalRequested = chatReq.model;
      const preNotices: SwitchNotice[] = [];
      const pre = await router.preflight(chatReq.model, allowedModels);
      if (pre.switched) {
        // The substitute must be re-composed with ITS provider prefix: a bare
        // catalog id (e.g. "agnes-3.0-flash") matches no resolveModel heuristic
        // and would silently fall through to the openrouter default.
        chatReq.model = composeModelId(pre.model.provider, pre.model.id);
        preNotices.push(pre.notice);
      }

      let provider: { id: ProviderId; stream(req: ChatRequest): AsyncIterable<StreamChunk> };
      let realModelId: string;
      try {
        const resolved = reg.resolveModel(chatReq.model, routeOpts);
        provider = resolved.provider;
        realModelId = resolved.modelId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        record(req, t0, {
          kind: 'chat',
          provider: 'unknown',
          model: chatReq.model,
          status: 'error',
          error: msg,
        });
        return reply.code(400).send({ error: { message: msg, type: 'resolve_error' } });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...corsHeaders,
      });

      for (const notice of preNotices) {
        reply.raw.write(
          `data: ${JSON.stringify({ fmf_route_notice: notice, id: 'fmf', object: 'chat.completion.chunk', choices: [] })}\n\n`,
        );
      }

      let streamUsage: ChatResponse['usage'] | undefined;
      let lastChunkUsage: StreamChunk['usage'];
      let wroteChunk = false;
      let maxTokensRetried = false;
      let visionIndex = 0;
      const seq = newFailoverSeq();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const dispatchReq: ChatRequest = { ...chatReq, model: realModelId };
            await usageCaptureStore.run(
              (u) => {
                streamUsage = u;
              },
              async () => {
                for await (const chunk of provider.stream(dispatchReq)) {
                  wroteChunk = true;
                  // The final chunk usually carries usage, and the AsyncLocalStorage
                  // store does not always survive the provider's own async boundary
                  // (a proxy-backed upstream reliably loses it). The usage is already
                  // flowing past on the chunk, so remember the last one seen and fall
                  // back to it: same value the store would have held, without depending
                  // on context propagation across a network read.
                  if (chunk.usage) lastChunkUsage = chunk.usage;
                  const payload = streamChunkToOpenAI(chunk);
                  // Always name the model the gateway served. Some upstreams are
                  // routers in their own right and report the underlying model they
                  // used, which would make a client believe the request went to a
                  // provider it never asked for — while the very same frame's
                  // fmf_auto_route says otherwise.
                  const chunkComposed = `${provider.id}:${realModelId}`;
                  (payload as Record<string, unknown>).model =
                    reg.toClientFacingModel(chunkComposed);
                  if (chunk.model && chunk.model !== chunkComposed) {
                    // The upstream's own report, kept rather than silently dropped.
                    (payload as Record<string, unknown>).fmf_upstream_model = chunk.model;
                  }
                  if (body.model === 'auto') {
                    const autoRoute: Record<string, unknown> = {
                      picked: `${provider.id}:${realModelId}`,
                      strategy: router.getStrategy(),
                    };
                    if (routePool.length > 0) {
                      autoRoute.sticky = stickyHit;
                      autoRoute.pool = routePool;
                    }
                    (payload as Record<string, unknown>).fmf_auto_route = autoRoute;
                  }
                  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
                }
              },
            );
            // Post-stream: if we were on a fallback and preferred is free again,
            // emit a switch-back notice (applied on the NEXT request).
            const switchBack = await router.maybeSwitchBack(chatReq.model);
            if (switchBack) {
              reply.raw.write(
                `data: ${JSON.stringify({ fmf_route_notice: switchBack, id: 'fmf', object: 'chat.completion.chunk', choices: [] })}\n\n`,
              );
            }
            reply.raw.write('data: [DONE]\n\n');
            // Prefer the captured store value; fall back to the usage that came
            // through on the stream itself when the AsyncLocalStorage context was
            // lost across the upstream's async boundary.
            const recordedUsage = streamUsage ?? lastChunkUsage;
            record(req, t0, {
              kind: 'chat',
              // Never resolve `auto` here: that would re-roll the pool cursor
              // and record a model that never served this request.
              ...resolvePM(reg, `${provider.id}:${realModelId}`),
              status: 'success',
              httpStatus: 200,
              promptTokens: recordedUsage?.prompt_tokens,
              completionTokens: recordedUsage?.completion_tokens,
              cachedTokens: recordedUsage?.prompt_tokens_details?.cached_tokens,
            });
            break;
          } catch (err) {
            if (isMaxTokensTooLargeError(err) && !maxTokensRetried && chatReq.max_tokens != null) {
              chatReq.max_tokens = extractMaxTokensLimit(err);
              maxTokensRetried = true;
              continue;
            }
            if (
              !wroteChunk &&
              visionCandidates.length > 0 &&
              visionIndex + 1 < visionCandidates.length
            ) {
              visionIndex++;
              chatReq.model = visionCandidates[visionIndex]!;
              try {
                const resolved = reg.resolveModel(chatReq.model, routeOpts);
                provider = resolved.provider;
                realModelId = resolved.modelId;
                maxTokensRetried = false;
                continue;
              } catch {
                // fall through to error reporting
              }
            }
            const failure = classifyFailure(err);
            const failedKey = `${provider.id}:${realModelId}`;
            // Gate on the model the CLIENT asked for: a modality rewrite
            // (vision/tier/image/video) must not unlock the generic pool walk.
            const mark = () => {
              if (failure.kind === 'unavailable') {
                router.markModelUnavailable(realModelId, provider.id, failure.message);
              } else if (failure.kind === 'rate-limit') {
                router.markRateLimited(realModelId, provider.id, parseRateLimitError(err));
              } else if (failure.kind === 'context') {
                router.markContextOverflow(realModelId, provider.id, failure.message);
              }
            };

            let reportErr: unknown = err;
            if (
              routeIsAuto &&
              visionCandidates.length === 0 &&
              router.isEnabled() &&
              !wroteChunk &&
              failure.kind !== 'request'
            ) {
              const next = await advanceFailover(router, seq, failedKey, failure.kind, mark, allowedModels);
              if (next) {
                router.rememberPreference(originalRequested);
                const notice = buildFailoverNotice(router, failure.kind, failedKey, next);
                router.notify(notice);
                reply.raw.write(
                  `data: ${JSON.stringify({ fmf_route_notice: notice, id: 'fmf', object: 'chat.completion.chunk', choices: [] })}\n\n`,
                );
                chatReq.model = composeModelId(next.provider, next.id);
                if (routeOpts) router.setSticky(routeOpts.sessionKey, next.provider, next.id);
                try {
                  const resolved = reg.resolveModel(chatReq.model, routeOpts);
                  provider = resolved.provider;
                  realModelId = resolved.modelId;
                  maxTokensRetried = false;
                  continue;
                } catch {
                  // fall through to error reporting below
                }
              } else {
                reportErr = new CandidatesExhaustedError(
                  seq.attempts,
                  seq.counts,
                  seq.triedIds,
                  err,
                );
              }
            } else {
              mark();
            }

            const msg = reportErr instanceof Error ? reportErr.message : String(reportErr);
            const { status, httpStatus } = classifyStatus(reportErr);
            record(req, t0, {
              kind: 'chat',
              ...resolvePM(reg, `${provider.id}:${realModelId}`),
              status,
              httpStatus,
              error: msg,
            });
            reply.raw.write(
              `data: ${JSON.stringify({
                error: {
                  message: msg,
                  type:
                    reportErr instanceof CandidatesExhaustedError
                      ? 'model_unavailable'
                      : streamErrorType(msg, reportErr),
                  // The status line is already gone here, so the hint travels
                  // in the body or the client has no way to back off at all.
                  ...streamRetryAfter(reportErr),
                },
              })}\n\n`,
            );
            break;
          }
        }
      } finally {
        reply.raw.end();
      }
    },
  );

  app.post<{ Body: ImageGenerationRequest }>(
    '/v1/images/generations',
    async (req: FastifyRequest<{ Body: ImageGenerationRequest }>, reply: FastifyReply) => {
      const body = req.body;
      if (!body?.model || !body?.prompt) {
        return reply.code(400).send({ error: { message: 'model and prompt are required' } });
      }
      const t0 = Date.now();
      const reg = getRegistry();
      try {
        const { response } = await reg.generateImage(body);
        record(req, t0, {
          kind: 'image',
          ...resolvePM(reg, body.model),
          status: 'success',
          httpStatus: 200,
        });
        return reply.send({
          ...response,
          model: body.model,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const { status, httpStatus } = classifyStatus(err);
        record(req, t0, {
          kind: 'image',
          ...resolvePM(reg, body.model),
          status,
          httpStatus,
          error: message,
        });
        return reply.code(500).send({ error: { message } });
      }
    },
  );

  app.post<{ Body: VideoGenerationRequest }>(
    '/v1/videos',
    async (req: FastifyRequest<{ Body: VideoGenerationRequest }>, reply: FastifyReply) => {
      const body = req.body;
      if (!body?.model || !body?.prompt) {
        return reply.code(400).send({ error: { message: 'model and prompt are required' } });
      }
      const t0 = Date.now();
      const reg = getRegistry();
      try {
        const { response } = await reg.generateVideo(body);
        record(req, t0, {
          kind: 'video',
          ...resolvePM(reg, body.model),
          status: 'success',
          httpStatus: 200,
        });
        return reply.send({
          ...response,
          model: body.model,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const { status, httpStatus } = classifyStatus(err);
        record(req, t0, {
          kind: 'video',
          ...resolvePM(reg, body.model),
          status,
          httpStatus,
          error: message,
        });
        return reply.code(500).send({ error: { message } });
      }
    },
  );

  app.post<{ Body: { video_id: string; provider: string } }>(
    '/v1/videos/status',
    async (
      req: FastifyRequest<{ Body: { video_id: string; provider: string } }>,
      reply: FastifyReply,
    ) => {
      const { video_id, provider: providerId } = req.body ?? {};
      if (!video_id) {
        return reply.code(400).send({ error: { message: 'video_id is required' } });
      }
      if (!providerId) {
        return reply.code(400).send({ error: { message: 'provider is required' } });
      }
      const reg = getRegistry();
      try {
        const { response } = await reg.queryVideoStatus(video_id, providerId);
        return reply.send(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: { message } });
      }
    },
  );

  app.get<{ Params: { video_id: string } }>(
    '/v1/videos/:video_id',
    async (req: FastifyRequest<{ Params: { video_id: string } }>, reply: FastifyReply) => {
      const { video_id } = req.params;
      if (!video_id) {
        return reply.code(400).send({ error: { message: 'video_id is required' } });
      }
      const providerId = (req.query as Record<string, string>).provider;
      if (!providerId) {
        return reply.code(400).send({ error: { message: 'provider query parameter is required' } });
      }
      const reg = getRegistry();
      try {
        const { response } = await reg.queryVideoStatus(video_id, providerId);
        return reply.send(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: { message } });
      }
    },
  );

  app.post<{ Body: { url: string; provider: string } }>(
    '/v1/videos/proxy',
    async (
      req: FastifyRequest<{ Body: { url: string; provider: string } }>,
      reply: FastifyReply,
    ) => {
      const { url: videoUrl, provider: providerId } = req.body ?? {};
      if (!videoUrl) {
        return reply.code(400).send({ error: { message: 'url is required' } });
      }
      if (!providerId) {
        return reply.code(400).send({ error: { message: 'provider is required' } });
      }
      try {
        const reg = getRegistry();
        const provider = reg.getProvider(providerId as ProviderId);
        const apiKey =
          (provider as unknown as { ctx?: { credentials?: { apiKey?: string } } }).ctx?.credentials
            ?.apiKey ?? '';
        const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        const upstream = await fetch(videoUrl, {
          headers,
          signal: AbortSignal.timeout(300_000),
        });
        if (!upstream.ok) {
          return reply
            .code(502)
            .send({ error: { message: `upstream download failed ${upstream.status}` } });
        }
        const contentType = upstream.headers.get('content-type') ?? 'video/mp4';
        const contentLength = upstream.headers.get('content-length');
        reply.raw.writeHead(200, {
          'Content-Type': contentType,
          ...(contentLength ? { 'Content-Length': contentLength } : {}),
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        });
        const body = upstream.body as unknown as {
          pipe: (w: NodeJS.WritableStream) => void;
        } | null;
        if (body && typeof body.pipe === 'function') {
          body.pipe(reply.raw);
        } else {
          const reader = (upstream.body as ReadableStream).getReader();
          const pump = async (): Promise<void> => {
            const { done, value } = await reader.read();
            if (done) {
              reply.raw.end();
              return;
            }
            if (!reply.raw.destroyed) {
              reply.raw.write(value);
              return pump();
            }
          };
          await pump();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: { message } });
      }
    },
  );
}
