import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  chatResponseToOpenAI,
  openAIToChatRequest,
  parseRateLimitError,
  scoreModel,
  streamChunkToOpenAI,
  usageCaptureStore,
  type CallLogEntry,
  type CallLogger,
  type CallStatus,
  type ChatRequest,
  type ChatResponse,
  type GatewayKeyEntry,
  type ImageGenerationRequest,
  type OpenAIChatCompletionRequest,
  type ProviderId,
  type ProviderRegistry,
  type SwitchNotice,
  type VideoGenerationRequest,
} from '@freemodelfinder/core';

function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xKey = req.headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.trim()) return xKey.trim();
  const googKey = req.headers['x-goog-api-key'];
  if (typeof googKey === 'string' && googKey.trim()) return googKey.trim();
  return null;
}

function keysEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.equals(right);
}

function resolveGatewayKeyId(reg: ProviderRegistry, req: FastifyRequest): string | undefined {
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
    if (entry.expiresAt && entry.expiresAt < now) continue;
    if (keysEqual(provided, entry.key)) return entry.id;
  }
  return undefined;
}

function classifyStatus(err: unknown): { status: CallStatus; httpStatus?: number } {
  const parsed = parseRateLimitError(err);
  if (parsed.isRateLimit) return { status: 'rate_limited', httpStatus: 429 };
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/failed\s+(\d{3})/i);
  const upstream = match ? Number(match[1]) : undefined;
  return { status: 'error', httpStatus: upstream };
}

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

type RequestModality = 'text' | 'image' | 'video';

function detectRequestModality(messages: OpenAIChatCompletionRequest['messages']): RequestModality {
  const VIDEO_KEYWORDS =
    /\b(生成|制作|创建|做一段?|来一段?|画一段?)(视频|动画|短片|影片|动态|视频片段)\b/i;
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'image_url' || part.type === 'image') return 'image';
      }
    }
    if (typeof content === 'string' && VIDEO_KEYWORDS.test(content)) return 'video';
  }
  return 'text';
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
      const t0 = Date.now();
      const reg = getRegistry();
      const chatReq = openAIToChatRequest(body);

      // Auto-route: detect modality from request content when model is "auto"
      if (chatReq.model === 'auto' || chatReq.model === 'default') {
        const cfg = reg.getConfig();
        const ar = cfg.autoRoute;
        const detectedModality = detectRequestModality(body.messages);
        if (detectedModality === 'image' && ar?.imageModel) {
          chatReq.model = ar.imageModel;
        } else if (detectedModality === 'video' && ar?.videoModel) {
          chatReq.model = ar.videoModel;
        } else if (detectedModality === 'text' && ar?.textTiers) {
          const prompt = chatReq.messages.map((m) => m.content).join('\n');
          const tier = classifyTextComplexity(prompt);
          const tierModel = ar.textTiers[tier];
          if (tierModel) chatReq.model = tierModel;
        }
      }

      // Fast-path: infer capabilities from model ID without async calls
      const rawModelId = chatReq.model.split(':').pop() ?? chatReq.model;
      const inferredCaps: ('text' | 'image' | 'video')[] = /video/i.test(rawModelId)
        ? ['video']
        : /image/i.test(rawModelId)
          ? ['image']
          : [];

      const prompt = chatReq.messages.map((m) => m.content).join('\n');

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
            model: chatReq.model,
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
          const { response, notices, finalModel } = await usageCaptureStore.run(
            (u) => {
              usage = u;
            },
            async () => dispatchWithAutoRoute(reg, chatReq),
          );
          const payload = chatResponseToOpenAI(response) as Record<string, unknown> & {
            model?: string;
          };
          payload.model = finalModel;
          if (notices.length > 0) {
            (payload as Record<string, unknown>).fmf_route_notices = notices;
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
          const match = msg.match(/failed\s+(\d{3})/i);
          const upstream = match ? Number(match[1]) : undefined;
          const { status, httpStatus } = classifyStatus(err);
          record(req, t0, {
            kind: 'chat',
            ...resolvePM(reg, chatReq.model),
            status,
            httpStatus: httpStatus ?? upstream,
            error: msg,
          });
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
        record(req, t0, {
          kind: 'chat',
          provider: 'unknown',
          model: chatReq.model,
          status: 'error',
          error: msg,
        });
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

      let streamUsage: ChatResponse['usage'] | undefined;
      try {
        await usageCaptureStore.run(
          (u) => {
            streamUsage = u;
          },
          async () => {
            for await (const chunk of provider.stream(dispatchReq)) {
              const payload = streamChunkToOpenAI(chunk);
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
        record(req, t0, {
          kind: 'chat',
          ...resolvePM(reg, chatReq.model),
          status: 'success',
          httpStatus: 200,
          promptTokens: streamUsage?.prompt_tokens,
          completionTokens: streamUsage?.completion_tokens,
          cachedTokens: streamUsage?.prompt_tokens_details?.cached_tokens,
        });
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
        const { status, httpStatus } = classifyStatus(err);
        record(req, t0, {
          kind: 'chat',
          ...resolvePM(reg, chatReq.model),
          status,
          httpStatus,
          error: msg,
        });
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
