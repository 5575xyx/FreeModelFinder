import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  chatResponseToGemini,
  composeModelId,
  geminiToChatRequest,
  parseRateLimitError,
  type BaseProvider,
  type ChatRequest,
  type GeminiHttpRequest,
  type ProviderId,
  type ProviderRegistry,
  type StreamChunk,
  type SwitchNotice,
} from '@freemodelfinder/core';
import {
  advanceFailover,
  buildFailoverNotice,
  CandidatesExhaustedError,
  classifyFailure,
  dispatchFailureShape,
  keyModelAllowlist,
  newFailoverSeq,
  resolveGatewayKey,
  streamRetryAfter,
} from './openai.js';

type GeminiRouteParams = { modelAction: string };
type GeminiRouteRequest = FastifyRequest<{
  Params: GeminiRouteParams;
  Body: GeminiHttpRequest;
}>;

function parseModelAction(modelAction: string): { model: string; action: string } | null {
  const idx = modelAction.lastIndexOf(':');
  if (idx <= 0 || idx === modelAction.length - 1) return null;
  return {
    model: modelAction.slice(0, idx),
    action: modelAction.slice(idx + 1),
  };
}

async function handleGenerate(
  req: GeminiRouteRequest,
  reply: FastifyReply,
  getRegistry: () => ProviderRegistry,
  model: string,
) {
  const reg = getRegistry();
  const chatReq = geminiToChatRequest(model, req.body, false);
  // Resolve an external alias to its target BEFORE preflight so cooldown
  // lookups and markRateLimited are keyed by the resolved model rather than
  // the external name.
  chatReq.model = reg.resolveAlias(chatReq.model);
  // The caller's allowlist: preflight and the post-429 switch must stay inside it.
  const allowedModels = keyModelAllowlist(resolveGatewayKey(reg, req));
  const router = reg.getAutoRouter();
  const originalRequested = chatReq.model;
  // Only `auto` walks the whole pool: a concrete model gets at most one hop,
  // so an explicit request is never silently served by a different model.
  const allowPoolWalk = model === 'auto' || model === 'default';

  const pre = await router.preflight(chatReq.model, allowedModels);
  const notices: SwitchNotice[] = [];
  if (pre.switched) {
    // The substitute must be re-composed with ITS provider prefix: a bare
    // catalog id (e.g. "agnes-3.0-flash") matches no resolveModel heuristic
    // and would silently fall through to the openrouter default.
    chatReq.model = composeModelId(pre.model.provider, pre.model.id);
    notices.push(pre.notice);
  }

  const seq = newFailoverSeq();
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { provider, modelId } = reg.resolveModel(chatReq.model, { allowed: allowedModels });
    const dispatchReq: ChatRequest = { ...chatReq, model: modelId };
    try {
      const res = await provider.chat(dispatchReq);
      const back = await router.maybeSwitchBack(chatReq.model);
      if (back) notices.push(back);
      const payload = chatResponseToGemini(res) as Record<string, unknown>;
      if (notices.length > 0) payload.fmf_route_notices = notices;
      return reply.send(payload);
    } catch (err) {
      const failure = classifyFailure(err);
      const failedKey = `${provider.id}:${modelId}`;
      const mark = () => {
        if (failure.kind === 'unavailable') {
          router.markModelUnavailable(chatReq.model, provider.id as ProviderId, failure.message);
        } else if (failure.kind === 'rate-limit') {
          router.markRateLimited(
            chatReq.model,
            provider.id as ProviderId,
            parseRateLimitError(err),
          );
        } else if (failure.kind === 'context') {
          router.markContextOverflow(chatReq.model, provider.id as ProviderId, failure.message);
        }
      };

      if (allowPoolWalk && router.isEnabled() && failure.kind !== 'request') {
        const next = await advanceFailover(
          router,
          seq,
          failedKey,
          failure.kind,
          mark,
          allowedModels,
        );
        if (next) {
          router.rememberPreference(originalRequested);
          const notice = buildFailoverNotice(router, failure.kind, failedKey, next);
          router.notify(notice);
          notices.push(notice);
          chatReq.model = composeModelId(next.provider, next.id);
          continue;
        }
        // Every candidate was tried. Report the exhaustion, never the first
        // failure: the two read the same but mean very different things.
        throw new CandidatesExhaustedError(seq.attempts, seq.counts, seq.triedIds, err);
      }

      mark();
      // Explicit model: the legacy one-shot rate-limit switch still applies.
      const parsed = parseRateLimitError(err);
      if (parsed.isRateLimit && router.isEnabled() && attempt === 0) {
        const fallback = await router.pickFallback(failedKey, allowedModels);
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
          };
          router.notify(notice);
          notices.push(notice);
          chatReq.model = composeModelId(fallback.provider, fallback.id);
          attempt++;
          continue;
        }
      }
      throw err;
    }
  }
}

async function handleStream(
  req: GeminiRouteRequest,
  reply: FastifyReply,
  getRegistry: () => ProviderRegistry,
  model: string,
) {
  const reg = getRegistry();
  const chatReq = geminiToChatRequest(model, req.body, true);
  // Resolve an external alias to its target BEFORE preflight so cooldown
  // lookups and markRateLimited are keyed by the resolved model rather than
  // the external name.
  chatReq.model = reg.resolveAlias(chatReq.model);
  // The caller's allowlist: preflight must stay inside it.
  const allowedModels = keyModelAllowlist(resolveGatewayKey(reg, req));
  const router = reg.getAutoRouter();
  const originalRequested = chatReq.model;

  const pre = await router.preflight(chatReq.model, allowedModels);
  const preNotices: SwitchNotice[] = [];
  if (pre.switched) {
    chatReq.model = composeModelId(pre.model.provider, pre.model.id);
    preNotices.push(pre.notice);
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // Open the upstream stream BEFORE writing anything, so the pool walk cannot
  // leave the client with route notices and no content.
  const allowPoolWalk = model === 'auto' || model === 'default';
  const seq = newFailoverSeq();
  let provider: BaseProvider;
  let iterator: AsyncIterator<StreamChunk>;
  let firstChunk: StreamChunk | null = null;
  for (;;) {
    const resolved = reg.resolveModel(chatReq.model, { allowed: allowedModels });
    const it = resolved.provider
      .stream({ ...chatReq, model: resolved.modelId })
      [Symbol.asyncIterator]();
    try {
      const head = await it.next();
      provider = resolved.provider;
      iterator = it;
      firstChunk = head.done ? null : head.value;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failure = classifyFailure(err);
      const failedKey = `${resolved.provider.id}:${resolved.modelId}`;
      const mark = () => {
        if (failure.kind === 'unavailable') {
          router.markModelUnavailable(chatReq.model, resolved.provider.id, failure.message);
        } else if (failure.kind === 'rate-limit') {
          router.markRateLimited(chatReq.model, resolved.provider.id, parseRateLimitError(err));
        } else if (failure.kind === 'context') {
          router.markContextOverflow(chatReq.model, resolved.provider.id, failure.message);
        }
      };

      // A concrete model gets no walk: report that one candidate's failure.
      if (!allowPoolWalk || !router.isEnabled() || failure.kind === 'request') {
        const parsed = parseRateLimitError(err);
        if (parsed.isRateLimit && router.isEnabled()) {
          router.markRateLimited(chatReq.model, resolved.provider.id, parsed);
          router.rememberPreference(originalRequested);
        }
        reply.raw.write(
          `data: ${JSON.stringify({
            error: { message: msg, type: 'server_error', ...streamRetryAfter(err) },
          })}\n\n`,
        );
        reply.raw.end();
        return;
      }

      const next = await advanceFailover(router, seq, failedKey, failure.kind, mark, allowedModels);
      if (next) {
        router.rememberPreference(originalRequested);
        const notice = buildFailoverNotice(router, failure.kind, failedKey, next);
        router.notify(notice);
        preNotices.push(notice);
        chatReq.model = composeModelId(next.provider, next.id);
        continue;
      }
      const exhausted = new CandidatesExhaustedError(seq.attempts, seq.counts, seq.triedIds, err);
      reply.raw.write(
        `data: ${JSON.stringify({
          error: {
            message: exhausted.message,
            type: 'model_unavailable',
            ...streamRetryAfter(exhausted),
          },
        })}\n\n`,
      );
      reply.raw.end();
      return;
    }
  }

  for (const n of preNotices) {
    reply.raw.write(`data: ${JSON.stringify({ fmf_route_notice: n })}\n\n`);
  }

  try {
    const chunks = (async function* (): AsyncGenerator<StreamChunk> {
      if (firstChunk) yield firstChunk;
      for (;;) {
        const r = await iterator.next();
        if (r.done) return;
        yield r.value;
      }
    })();
    for await (const chunk of chunks) {
      const parts: Array<Record<string, unknown>> = [];
      if (chunk.tool_calls && chunk.tool_calls.length > 0) {
        for (const call of chunk.tool_calls) {
          let args: unknown = {};
          if (call.function?.arguments) {
            try {
              const parsed: unknown = JSON.parse(call.function.arguments);
              args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch {
              args = {};
            }
          }
          parts.push({ functionCall: { name: call.function?.name ?? '', args } });
        }
      } else if (chunk.delta) {
        parts.push({ text: chunk.delta });
      }
      const payload = {
        candidates: [
          {
            content: { role: 'model', parts },
            index: 0,
            finishReason:
              chunk.finish_reason === 'stop' || chunk.finish_reason === 'tool_calls'
                ? 'STOP'
                : chunk.finish_reason === 'length'
                  ? 'MAX_TOKENS'
                  : null,
          },
        ],
      };
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    const back = await router.maybeSwitchBack(chatReq.model);
    if (back) reply.raw.write(`data: ${JSON.stringify({ fmf_route_notice: back })}\n\n`);
  } catch (err) {
    const parsed = parseRateLimitError(err);
    if (parsed.isRateLimit && router.isEnabled()) {
      router.markRateLimited(chatReq.model, provider.id as ProviderId, parsed);
      router.rememberPreference(originalRequested);
    }
    const msg = err instanceof Error ? err.message : String(err);
    // The status line is already gone, so the hint must ride in the event body.
    const error = { message: msg, type: 'server_error', ...streamRetryAfter(err) };
    reply.raw.write(`data: ${JSON.stringify({ error })}\n\n`);
  } finally {
    reply.raw.end();
  }
}

export function registerGeminiRoutes(app: FastifyInstance, getRegistry: () => ProviderRegistry) {
  app.post<{ Params: GeminiRouteParams; Body: GeminiHttpRequest }>(
    '/v1beta/models/:modelAction',
    async (req, reply) => {
      const parsed = parseModelAction(req.params.modelAction);
      if (!parsed) {
        return reply.code(404).send({ error: 'unknown gemini action' });
      }
      const { model, action } = parsed;

      try {
        if (action === 'generateContent') {
          return await handleGenerate(req, reply, getRegistry, model);
        }
        if (action === 'streamGenerateContent') {
          return await handleStream(req, reply, getRegistry, model);
        }
        return reply.code(404).send({ error: `unsupported gemini action: ${action}` });
      } catch (err) {
        // `handleGenerate` rethrows upstream failures; without this they surface
        // as Fastify's bare 500 and lose both the message and the back-off hint.
        const msg = err instanceof Error ? err.message : String(err);
        const shape = dispatchFailureShape(err);
        if (shape.retryAfter !== null) reply.header('retry-after', String(shape.retryAfter));
        return reply.code(shape.httpStatus).send({
          error: {
            code: shape.httpStatus,
            message: msg,
            status:
              shape.type === 'model_unavailable'
                ? 'MODEL_UNAVAILABLE'
                : shape.httpStatus === 429
                  ? 'RATE_LIMIT_EXCEEDED'
                  : 'UPSTREAM_ERROR',
          },
        });
      }
    },
  );
}
