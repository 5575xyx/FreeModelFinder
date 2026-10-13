import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  anthropicToChatRequest,
  chatResponseToAnthropic,
  composeModelId,
  parseRateLimitError,
  retryAfterSeconds,
  type AnthropicMessagesRequest,
  type ChatRequest,
  type ChatResponse,
  type ProviderId,
  type ProviderRegistry,
  type SwitchNotice,
} from '@freemodelfinder/core';
import { keyModelAllowlist, resolveGatewayKey, streamRetryAfter } from './openai.js';

/**
 * Restricted composed model ids for the caller's gateway key, or null for an
 * unrestricted caller. Failover must stay inside it, or a 200 from another
 * model would silently bypass the allowlist.
 */
async function dispatchWithAutoRoute(
  reg: ProviderRegistry,
  chatReq: ChatRequest,
  allowed?: Set<string> | null,
): Promise<{ response: ChatResponse; notices: SwitchNotice[]; finalModel: string }> {
  const router = reg.getAutoRouter();
  const notices: SwitchNotice[] = [];
  const originalRequested = chatReq.model;

  const pre = await router.preflight(chatReq.model, allowed);
  if (pre.switched) {
    // The substitute must be re-composed with ITS provider prefix: a bare
    // catalog id (e.g. "agnes-3.0-flash") matches no resolveModel heuristic
    // and would silently fall through to the openrouter default.
    chatReq.model = composeModelId(pre.model.provider, pre.model.id);
    notices.push(pre.notice);
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { provider, modelId: realModelId } = reg.resolveModel(chatReq.model, { allowed });
    const dispatchReq: ChatRequest = { ...chatReq, model: realModelId };
    try {
      const res = await provider.chat(dispatchReq);
      const back = await router.maybeSwitchBack(chatReq.model);
      if (back) notices.push(back);
      return {
        response: res,
        notices,
        finalModel: `${provider.id}:${realModelId}`,
      };
    } catch (err) {
      const parsed = parseRateLimitError(err);
      if (parsed.isRateLimit && router.isEnabled() && attempt === 0) {
        router.markRateLimited(chatReq.model, provider.id as ProviderId, parsed);
        const fallback = await router.pickFallback(chatReq.model, allowed);
        if (fallback) {
          router.rememberPreference(originalRequested);
          const notice: SwitchNotice = {
            type: 'switch-away',
            from: chatReq.model,
            to: composeModelId(fallback.provider, fallback.id),
            strategy: router.getStrategy(),
            reason: router.buildSwitchAwayMessage(
              {
                model: chatReq.model,
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

export function registerAnthropicRoutes(app: FastifyInstance, getRegistry: () => ProviderRegistry) {
  app.post(
    '/v1/messages',
    async (req: FastifyRequest<{ Body: AnthropicMessagesRequest }>, reply) => {
      const body = req.body;
      if (!body?.model || !Array.isArray(body?.messages)) {
        return reply.code(400).send({ error: 'model and messages are required' });
      }
      const reg = getRegistry();
      const chatReq = anthropicToChatRequest(body);
      // Resolve an external alias to its target BEFORE preflight so cooldown
      // lookups and markRateLimited are keyed by the resolved model rather than
      // the external name.
      chatReq.model = reg.resolveAlias(chatReq.model);
      // The caller's allowlist, resolved once here: preflight and the post-429
      // switch must both stay inside it.
      const allowedModels = keyModelAllowlist(resolveGatewayKey(reg, req));

      if (!chatReq.stream) {
        try {
          const { response, notices, finalModel } = await dispatchWithAutoRoute(
            reg,
            chatReq,
            allowedModels,
          );
          const payload = chatResponseToAnthropic(response) as Record<string, unknown>;
          payload.model = reg.toClientFacingModel(finalModel);
          if (notices.length > 0) payload.fmf_route_notices = notices;
          return reply.send(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // A rate limit used to surface as a 502, which tells a client the
          // gateway is broken instead of telling it to back off.
          const retryAfter = retryAfterSeconds(err);
          if (retryAfter !== null) reply.header('retry-after', String(retryAfter));
          return reply
            .code(retryAfter !== null ? 429 : 502)
            .send({ error: { message: msg, type: 'upstream_error' } });
        }
      }

      const router = reg.getAutoRouter();
      const originalRequested = chatReq.model;
      const preNotices: SwitchNotice[] = [];
      const pre = await router.preflight(chatReq.model, allowedModels);
      if (pre.switched) {
        chatReq.model = composeModelId(pre.model.provider, pre.model.id);
        preNotices.push(pre.notice);
      }

      const { provider, modelId } = reg.resolveModel(chatReq.model, { allowed: allowedModels });
      const dispatchReq: ChatRequest = { ...chatReq, model: modelId };

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });

      const msgId = `msg_${Date.now()}`;
      const write = (event: string, data: unknown) =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      write('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model: reg.toClientFacingModel(`${provider.id}:${modelId}`),
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      for (const notice of preNotices) {
        write('fmf_route_notice', notice);
      }
      let blockIndex = -1;
      let blockKind: 'text' | 'tool_use' | null = null;
      let currentToolIndex: number | null = null;
      let sawToolCalls = false;
      let chunkFinishReason: string | null = null;

      try {
        for await (const chunk of provider.stream(dispatchReq)) {
          if (chunk.finish_reason) chunkFinishReason = chunk.finish_reason;
          if (chunk.tool_calls && chunk.tool_calls.length > 0) {
            sawToolCalls = true;
            for (const call of chunk.tool_calls) {
              if (blockKind !== 'tool_use' || currentToolIndex !== call.index) {
                if (blockKind !== null) {
                  write('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                }
                blockIndex += 1;
                blockKind = 'tool_use';
                currentToolIndex = call.index;
                write('content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: call.id ?? `call_${blockIndex}`,
                    name: call.function?.name ?? '',
                    input: {},
                  },
                });
              }
              if (call.function?.arguments) {
                write('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'input_json_delta', partial_json: call.function.arguments },
                });
              }
            }
            continue;
          }
          if (chunk.delta) {
            if (blockKind !== 'text') {
              if (blockKind !== null) {
                write('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              }
              blockIndex += 1;
              blockKind = 'text';
              currentToolIndex = null;
              write('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' },
              });
            }
            write('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: chunk.delta },
            });
          }
        }
        if (blockKind === null) {
          blockIndex += 1;
          blockKind = 'text';
          write('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        write('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        write('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason:
              sawToolCalls || chunkFinishReason === 'tool_calls'
                ? 'tool_use'
                : chunkFinishReason === 'length'
                  ? 'max_tokens'
                  : 'end_turn',
          },
          usage: { output_tokens: 0 },
        });
        const back = await router.maybeSwitchBack(chatReq.model);
        if (back) write('fmf_route_notice', back);
        write('message_stop', { type: 'message_stop' });
      } catch (err) {
        const parsed = parseRateLimitError(err);
        if (parsed.isRateLimit && router.isEnabled()) {
          router.markRateLimited(chatReq.model, provider.id as ProviderId, parsed);
          router.rememberPreference(originalRequested);
        }
        const msg = err instanceof Error ? err.message : String(err);
        // The status line is already gone, so the hint must ride in the body.
        write('error', {
          type: 'error',
          error: { type: 'api_error', message: msg, ...streamRetryAfter(err) },
        });
      } finally {
        reply.raw.end();
      }
    },
  );
}
