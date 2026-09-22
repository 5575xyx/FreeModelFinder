import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  chatResponseToOpenAI,
  openAIToChatRequest,
  parseRateLimitError,
  scoreModel,
  streamChunkToOpenAI,
  type ChatRequest,
  type ChatResponse,
  type ImageGenerationRequest,
  type OpenAIChatCompletionRequest,
  type ProviderId,
  type ProviderRegistry,
  type SwitchNotice,
  type VideoGenerationRequest,
} from '@freemodelfinder/core';

function extractProviderIdFromError(chatReq: ChatRequest, reg: ProviderRegistry): string {
  try {
    const { provider } = reg.resolveModel(chatReq.model);
    return provider.id;
  } catch {
    return 'unknown';
  }
}

async function dispatchWithAutoRoute(
  reg: ProviderRegistry,
  chatReq: ChatRequest,
): Promise<{
  finalModel: string;
  finalProviderId: string;
  response: ChatResponse;
  notices: SwitchNotice[];
}> {
  const router = reg.getAutoRouter();
  const notices: SwitchNotice[] = [];
  const originalRequested = chatReq.model;

  // 1. Pre-flight: honor existing cooldowns before we even try upstream.
  const pre = await router.preflight(chatReq.model);
  if (pre.switched) {
    chatReq.model = pre.model.id;
    notices.push(pre.notice);
  }

  // 2. Resolve provider & dispatch. On rate-limit failure, fall back exactly
  //    ONCE (we intentionally do not interrupt a live stream elsewhere).
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resolved = reg.resolveModel(chatReq.model);
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
      };
    } catch (err) {
      const parsed = parseRateLimitError(err);
      if (parsed.isRateLimit && router.isEnabled() && attempt === 0) {
        router.markRateLimited(chatReq.model, provider.id, parsed);
        const fallback = await router.pickFallback(chatReq.model);
        if (fallback) {
          router.rememberPreference(originalRequested);
          const notice: SwitchNotice = {
            type: 'switch-away',
            from: chatReq.model,
            to: `${fallback.provider}:${fallback.id}`,
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
          chatReq.model = `${fallback.provider}:${fallback.id}`;
          attempt++;
          continue;
        }
      }
      throw err;
    }
  }
}

export function registerOpenAIRoutes(
  app: FastifyInstance,
  getRegistry: () => ProviderRegistry,
  options: { includeManagement?: boolean } = {},
) {
  app.get('/v1/models', async (_req, reply) => {
    const reg = getRegistry();
    const { models, succeededProviders, failedProviders } = await reg.listAllModels();
    const router = reg.getAutoRouter();
    return reply.send({
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
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
      })),
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
      const reg = getRegistry();
      const chatReq = openAIToChatRequest(body);

      // Auto-route image/video models sent to chat completions
      try {
        const { provider } = reg.resolveModel(chatReq.model);
        const models = (await reg.listAllModels()).models;
        const modelInfo = models.find(
          (m) => m.id === chatReq.model || m.id === chatReq.model.split(':').pop(),
        );
        const caps = modelInfo?.capabilities ?? [];
        const prompt = chatReq.messages.map((m) => m.content).join('\n');

        if (caps.includes('image')) {
          const imageReq: ImageGenerationRequest = {
            model: chatReq.model,
            prompt,
            size: '1024x1024',
            n: 1,
            response_format: 'url',
          };
          const { response } = await reg.generateImage(imageReq);
          const content = response.data
            .map((d) => d.url ?? d.b64_json ?? '[image]')
            .join('\n');
          const payload = {
            id: `chatcmpl-agnes-img-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: chatReq.model,
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
        }

        if (caps.includes('video')) {
          const videoReq: VideoGenerationRequest = {
            model: chatReq.model,
            prompt,
            width: 1152,
            height: 768,
            num_frames: 121,
            frame_rate: 24,
          };
          const { response } = await reg.generateVideo(videoReq);
          const content = response.video_id
            ? `视频任务已提交，video_id: ${response.video_id}，状态: ${response.status}。请使用 GET /v1/videos/${response.video_id}?provider=${provider.id} 查询进度。`
            : '视频任务提交失败';
          const payload = {
            id: `chatcmpl-agnes-vid-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: chatReq.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            fmf_video_response: { ...response, provider: provider.id },
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
        }
      } catch {
        // Not a multimodal model or model info unavailable, fall through to chat
      }

      if (!chatReq.stream) {
        try {
          const { response, notices, finalModel } = await dispatchWithAutoRoute(reg, chatReq);
          const payload = chatResponseToOpenAI(response) as Record<string, unknown> & {
            model?: string;
          };
          payload.model = finalModel;
          if (notices.length > 0) {
            (payload as Record<string, unknown>).fmf_route_notices = notices;
          }
          return reply.send(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const match = msg.match(/failed\s+(\d{3})/i);
          const upstream = match ? Number(match[1]) : undefined;
          return reply
            .code(upstream && upstream >= 400 && upstream < 600 ? upstream : 502)
            .send({ error: { message: msg, type: 'upstream_error', upstream } });
        }
      }

      // Streaming path: never interrupt an active stream. Only preflight
      // and switch-back notices are surfaced; a mid-stream 429 is passed
      // through as an error (per user requirement: only switch on the NEXT
      // request after a limit-triggered interruption).
      const origin = req.headers.origin;
      const corsHeaders: Record<string, string> = origin
        ? {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            vary: 'Origin',
          }
        : { 'access-control-allow-origin': '*' };

      const router = reg.getAutoRouter();
      const originalRequested = chatReq.model;
      const preNotices: SwitchNotice[] = [];
      const pre = await router.preflight(chatReq.model);
      if (pre.switched) {
        chatReq.model = pre.model.id;
        preNotices.push(pre.notice);
      }

      let provider;
      let realModelId: string;
      try {
        const resolved = reg.resolveModel(chatReq.model);
        provider = resolved.provider;
        realModelId = resolved.modelId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: { message: msg, type: 'resolve_error' } });
      }
      const dispatchReq: ChatRequest = { ...chatReq, model: realModelId };

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

      try {
        for await (const chunk of provider.stream(dispatchReq)) {
          const payload = streamChunkToOpenAI(chunk);
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
        // Post-stream: if we were on a fallback and preferred is free again,
        // emit a switch-back notice (applied on the NEXT request).
        const switchBack = await router.maybeSwitchBack(chatReq.model);
        if (switchBack) {
          reply.raw.write(
            `data: ${JSON.stringify({ fmf_route_notice: switchBack, id: 'fmf', object: 'chat.completion.chunk', choices: [] })}\n\n`,
          );
        }
        reply.raw.write('data: [DONE]\n\n');
      } catch (err) {
        const parsed = parseRateLimitError(err);
        if (parsed.isRateLimit && router.isEnabled()) {
          router.markRateLimited(
            chatReq.model,
            extractProviderIdFromError(chatReq, reg) as ProviderId,
            parsed,
          );
          router.rememberPreference(originalRequested);
        }
        const msg = err instanceof Error ? err.message : String(err);
        reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
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
        return reply
          .code(400)
          .send({ error: { message: 'model and prompt are required' } });
      }
      const reg = getRegistry();
      try {
        const { response } = await reg.generateImage(body);
        return reply.send({
          ...response,
          model: body.model,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: { message } });
      }
    },
  );

  app.post<{ Body: VideoGenerationRequest }>(
    '/v1/videos',
    async (req: FastifyRequest<{ Body: VideoGenerationRequest }>, reply: FastifyReply) => {
      const body = req.body;
      if (!body?.model || !body?.prompt) {
        return reply
          .code(400)
          .send({ error: { message: 'model and prompt are required' } });
      }
      const reg = getRegistry();
      try {
        const { response } = await reg.generateVideo(body);
        return reply.send({
          ...response,
          model: body.model,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
        return reply
          .code(400)
          .send({ error: { message: 'video_id is required' } });
      }
      if (!providerId) {
        return reply
          .code(400)
          .send({ error: { message: 'provider is required' } });
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
    async (
      req: FastifyRequest<{ Params: { video_id: string } }>,
      reply: FastifyReply,
    ) => {
      const { video_id } = req.params;
      if (!video_id) {
        return reply
          .code(400)
          .send({ error: { message: 'video_id is required' } });
      }
      const providerId = (req.query as Record<string, string>).provider;
      if (!providerId) {
        return reply
          .code(400)
          .send({ error: { message: 'provider query parameter is required' } });
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
        const headers: Record<string, string> = apiKey
          ? { Authorization: `Bearer ${apiKey}` }
          : {};
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
        const body = upstream.body as unknown as { pipe: (w: NodeJS.WritableStream) => void } | null;
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
