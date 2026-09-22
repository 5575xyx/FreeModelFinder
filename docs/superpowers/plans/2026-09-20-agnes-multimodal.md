# Agnes 多模态支持（图片+视频生成）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 FreeModelFinder 添加 Agnes 图片生成和视频生成的完整支持，包括类型系统、Provider 接口、API 路由和测试。

**Architecture:** 在现有文本聊天架构基础上扩展多模态能力。类型层新增 ImageGenerationRequest/Response 和 VideoGenerationRequest/Response；Provider 层在 BaseProvider 中添加可选的 generateImage/generateVideo 方法；AgnesProvider 实现实际 API 调用；Server 层新增 `/v1/images/generations` 和 `/v1/videos` 端点。

**Tech Stack:** TypeScript, Zod, Fastify, Node.js 内置测试

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `packages/core/src/types.ts` | 修改 | 新增多模态类型定义 |
| `packages/core/src/providers/base.ts` | 修改 | 添加可选的 generateImage/generateVideo 方法 |
| `packages/core/src/providers/agnes.ts` | 修改 | 实现 Agnes 图片/视频 API 调用 |
| `packages/server/src/routes/openai.ts` | 修改 | 添加 `/v1/images/generations` 和 `/v1/videos` 路由 |
| `packages/core/src/protocols/openai.ts` | 修改 | 添加图片/视频请求/响应转换函数 |
| `packages/core/src/__tests__/multimodal.test.ts` | 新建 | 多模态类型和转换函数测试 |
| `packages/core/src/providers/__tests__/agnes-multimodal.test.ts` | 新建 | Agnes 多模态 Provider 测试 |
| `packages/server/src/routes/__tests__/images.test.ts` | 新建 | 图片生成端点测试 |
| `packages/server/src/routes/__tests__/videos.test.ts` | 新建 | 视频生成端点测试 |

---

### Task 1: 扩展类型系统

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/__tests__/multimodal.test.ts`

- [ ] **Step 1: 创建多模态类型测试文件**

```typescript
// packages/core/src/__tests__/multimodal.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ImageGenerationRequestSchema,
  ImageGenerationResponseSchema,
  VideoGenerationRequestSchema,
  VideoGenerationResponseSchema,
} from '../types.js';

describe('multimodal types', () => {
  it('validates image generation request', () => {
    const req = ImageGenerationRequestSchema.parse({
      model: 'agnes-image-2.5-flash',
      prompt: 'a cute cat',
      size: '1024x1024',
    });
    assert.equal(req.model, 'agnes-image-2.5-flash');
    assert.equal(req.size, '1024x1024');
  });

  it('validates image generation response', () => {
    const res = ImageGenerationResponseSchema.parse({
      created: Date.now(),
      data: [{ url: 'https://example.com/image.png' }],
    });
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].url, 'https://example.com/image.png');
  });

  it('validates video generation request', () => {
    const req = VideoGenerationRequestSchema.parse({
      model: 'agnes-video-v2.0',
      prompt: 'a cat playing',
      width: 1152,
      height: 768,
      num_frames: 121,
      frame_rate: 24,
    });
    assert.equal(req.num_frames, 121);
    assert.equal(req.frame_rate, 24);
  });

  it('validates video generation response with video_id', () => {
    const res = VideoGenerationResponseSchema.parse({
      video_id: 'vid_123',
      status: 'queued',
    });
    assert.equal(res.video_id, 'vid_123');
    assert.equal(res.status, 'queued');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL with "ImageGenerationRequestSchema is not exported"

- [ ] **Step 3: 在 types.ts 中添加多模态类型**

在 `packages/core/src/types.ts` 末尾添加：

```typescript
// ── 多模态生成类型 ──────────────────────────────────────────

export const ImageGenerationRequestSchema = z.object({
  model: z.string(),
  prompt: z.string(),
  size: z.string().optional().default('1024x1024'),
  n: z.number().int().positive().optional().default(1),
  response_format: z.enum(['url', 'b64_json']).optional().default('url'),
  image: z.array(z.string()).optional(),
});
export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>;

export const ImageGenerationResponseSchema = z.object({
  created: z.number(),
  data: z.array(
    z.object({
      url: z.string().optional(),
      b64_json: z.string().optional(),
    }),
  ),
});
export type ImageGenerationResponse = z.infer<typeof ImageGenerationResponseSchema>;

export const VideoGenerationRequestSchema = z.object({
  model: z.string(),
  prompt: z.string(),
  width: z.number().int().positive().optional().default(1152),
  height: z.number().int().positive().optional().default(768),
  num_frames: z.number().int().positive().optional().default(121),
  frame_rate: z.number().int().min(1).max(60).optional().default(24),
  image: z.array(z.string()).optional(),
  negative_prompt: z.string().optional(),
  seed: z.number().int().optional(),
});
export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;

export const VideoGenerationResponseSchema = z.object({
  video_id: z.string(),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed']),
  video_url: z.string().optional(),
  progress: z.number().optional(),
  error: z.string().optional(),
});
export type VideoGenerationResponse = z.infer<typeof VideoGenerationResponseSchema>;
```

同时在 `ModelInfo` 接口中添加 capabilities 字段：

```typescript
export interface ModelInfo {
  id: string;
  provider: ProviderId;
  displayName: string;
  contextWindow?: number;
  free: boolean;
  description?: string;
  capabilities?: ('text' | 'image' | 'video')[];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/multimodal.test.ts
git commit -m "feat(core): add multimodal type definitions for image and video generation"
```

---

### Task 2: 扩展 Provider 基类接口

**Files:**
- Modify: `packages/core/src/providers/base.ts`
- Test: `packages/core/src/__tests__/multimodal.test.ts` (追加)

- [ ] **Step 1: 添加多模态方法到 BaseProvider**

在 `packages/core/src/providers/base.ts` 的 `BaseProvider` 类中添加：

```typescript
import type {
  ChatRequest,
  ChatResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelInfo,
  ProviderId,
  ProviderCredentials,
  QuotaWindow,
  StreamChunk,
  VideoGenerationRequest,
  VideoGenerationResponse,
} from '../types.js';

// ... 在 BaseProvider 类中添加：
generateImage?(req: ImageGenerationRequest): Promise<ImageGenerationResponse>;
generateVideo?(req: VideoGenerationRequest): Promise<VideoGenerationResponse>;
queryVideoStatus?(videoId: string): Promise<VideoGenerationResponse>;
```

- [ ] **Step 2: 在 ProviderRegistry 中添加多模态分发方法**

在 `packages/core/src/registry.ts` 中添加：

```typescript
async generateImage(
  req: ImageGenerationRequest,
): Promise<{ provider: BaseProvider; response: ImageGenerationResponse }> {
  const { provider, modelId } = this.resolveModel(req.model);
  if (!provider.generateImage) {
    throw new Error(`Provider ${provider.id} does not support image generation`);
  }
  const response = await provider.generateImage({ ...req, model: modelId });
  return { provider, response };
}

async generateVideo(
  req: VideoGenerationRequest,
): Promise<{ provider: BaseProvider; response: VideoGenerationResponse }> {
  const { provider, modelId } = this.resolveModel(req.model);
  if (!provider.generateVideo) {
    throw new Error(`Provider ${provider.id} does not support video generation`);
  }
  const response = await provider.generateVideo({ ...req, model: modelId });
  return { provider, response };
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add packages/core/src/providers/base.ts packages/core/src/registry.ts
git commit -m "feat(core): add generateImage/generateVideo to ProviderRegistry"
```

---

### Task 3: 实现 Agnes 图片生成

**Files:**
- Modify: `packages/core/src/providers/agnes.ts`
- Test: `packages/core/src/providers/__tests__/agnes-multimodal.test.ts`

- [ ] **Step 1: 创建 Agnes 多模态测试文件**

```typescript
// packages/core/src/providers/__tests__/agnes-multimodal.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgnesProvider } from '../agnes.js';

function mockFetch(responseBody: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('AgnesProvider multimodal', () => {
  it('generates image via /images/generations', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        created: Date.now(),
        data: [{ url: 'https://example.com/image.png' }],
      }),
    });

    const result = await provider.generateImage!({
      model: 'agnes-image-2.5-flash',
      prompt: 'a cute cat',
      size: '1024x1024',
    });

    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].url, 'https://example.com/image.png');
  });

  it('generates image with b64_json response', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        created: Date.now(),
        data: [{ b64_json: 'base64data...' }],
      }),
    });

    const result = await provider.generateImage!({
      model: 'agnes-image-2.5-flash',
      prompt: 'a cute cat',
      response_format: 'b64_json',
    });

    assert.equal(result.data[0].b64_json, 'base64data...');
  });

  it('creates video via /videos', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        video_id: 'vid_abc123',
        status: 'queued',
      }),
    });

    const result = await provider.generateVideo!({
      model: 'agnes-video-v2.0',
      prompt: 'a cat playing',
      width: 1152,
      height: 768,
      num_frames: 121,
      frame_rate: 24,
    });

    assert.equal(result.video_id, 'vid_abc123');
    assert.equal(result.status, 'queued');
  });

  it('queries video status via /agnesapi', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        video_id: 'vid_abc123',
        status: 'completed',
        remixed_from_video_id: 'https://example.com/video.mp4',
      }),
    });

    const result = await provider.queryVideoStatus!('vid_abc123');

    assert.equal(result.status, 'completed');
    assert.equal(result.video_url, 'https://example.com/video.mp4');
  });

  it('throws on image generation failure', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({ error: { message: 'Invalid API key' } }, 401),
    });

    await assert.rejects(
      () =>
        provider.generateImage!({
          model: 'agnes-image-2.5-flash',
          prompt: 'test',
        }),
      /401/,
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL with "provider.generateImage is not a function"

- [ ] **Step 3: 实现 AgnesProvider.generateImage**

在 `packages/core/src/providers/agnes.ts` 中添加：

```typescript
import type {
  ImageGenerationRequest,
  ImageGenerationResponse,
  VideoGenerationRequest,
  VideoGenerationResponse,
} from '../types.js';

// ... 在 AgnesProvider 类中添加：

private rootBase(): string {
  const base = this.baseUrl();
  return base.replace(/\/v1$/, '');
}

async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResponse> {
  const key = this.ctx.credentials.apiKey;
  if (!key) throw new Error('agnes API key not configured');

  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    size: req.size,
    response_format: req.response_format,
  };
  if (req.image && req.image.length > 0) {
    body.image = req.image;
  }

  const res = await this.fetch(`${this.baseUrl()}/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`agnes image generation failed ${res.status}: ${text}`);
  }

  return (await res.json()) as ImageGenerationResponse;
}

async generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResponse> {
  const key = this.ctx.credentials.apiKey;
  if (!key) throw new Error('agnes API key not configured');

  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    width: req.width,
    height: req.height,
    num_frames: req.num_frames,
    frame_rate: req.frame_rate,
  };
  if (req.image && req.image.length > 0) {
    body.image = req.image;
  }
  if (req.negative_prompt) body.negative_prompt = req.negative_prompt;
  if (req.seed != null) body.seed = req.seed;

  const res = await this.fetch(`${this.baseUrl()}/videos`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`agnes video creation failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    video_id: (data.video_id as string) || (data.id as string) || '',
    status: (data.status as VideoGenerationResponse['status']) || 'queued',
  };
}

async queryVideoStatus(videoId: string): Promise<VideoGenerationResponse> {
  const key = this.ctx.credentials.apiKey;
  if (!key) throw new Error('agnes API key not configured');

  const res = await this.fetch(
    `${this.rootBase()}/agnesapi?video_id=${encodeURIComponent(videoId)}`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${key}`,
      },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`agnes video query failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const videoUrl =
    (data.remixed_from_video_id as string) ||
    (data.video_url as string) ||
    (data.output_url as string) ||
    (data.url as string) ||
    '';

  return {
    video_id: (data.video_id as string) || (data.id as string) || videoId,
    status: (data.status as VideoGenerationResponse['status']) || 'queued',
    video_url: videoUrl || undefined,
    progress: data.progress as number | undefined,
    error: data.error ? String(data.error) : undefined,
  };
}
```

- [ ] **Step 4: 更新 Agnes 模型列表添加 capabilities**

更新 `agnes.ts` 中的 `AGNES_STATIC_MODELS`：

```typescript
const AGNES_STATIC_MODELS: Omit<ModelInfo, 'provider'>[] = [
  {
    id: 'agnes-2.5-flash',
    displayName: 'Agnes 2.5 Flash',
    free: true,
    capabilities: ['text'],
    description: 'Agnes 2.5 Flash, permanently free, optimized for coding and agent workflows.',
  },
  {
    id: 'agnes-3.0-flash',
    displayName: 'Agnes 3.0 Flash',
    free: true,
    capabilities: ['text'],
    description: 'Agnes 3.0 Flash, next-gen text model, permanently free.',
  },
  {
    id: 'agnes-image-2.0-flash',
    displayName: 'Agnes Image 2.0 Flash',
    free: true,
    capabilities: ['image'],
    description: 'Agnes Image 2.0 Flash, text-to-image and image editing, permanently free.',
  },
  {
    id: 'agnes-image-2.1-flash',
    displayName: 'Agnes Image 2.1 Flash',
    free: true,
    capabilities: ['image'],
    description: 'Agnes Image 2.1 Flash, upgraded image generation, permanently free.',
  },
  {
    id: 'agnes-image-2.5-flash',
    displayName: 'Agnes Image 2.5 Flash',
    free: true,
    capabilities: ['image'],
    description: 'Agnes Image 2.5 Flash, latest image model, permanently free.',
  },
  {
    id: 'agnes-video-v2.0',
    displayName: 'Agnes Video V2.0',
    free: true,
    capabilities: ['video'],
    description: 'Agnes Video V2.0, text-to-video and image-to-video, permanently free.',
  },
  {
    id: 'agnes-video-2.5-flash',
    displayName: 'Agnes Video 2.5 Flash',
    free: true,
    capabilities: ['video'],
    description: 'Agnes Video 2.5 Flash, video generation with first/last frame control, permanently free.',
  },
];
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/providers/agnes.ts packages/core/src/providers/__tests__/agnes-multimodal.test.ts
git commit -m "feat(agnes): implement image and video generation methods"
```

---

### Task 4: 添加 Server 路由

**Files:**
- Modify: `packages/server/src/routes/openai.ts`
- Test: `packages/server/src/routes/__tests__/images.test.ts`, `videos.test.ts`

- [ ] **Step 1: 创建图片生成端点测试**

```typescript
// packages/server/src/routes/__tests__/images.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTestServer } from '../../test-utils.js';

describe('POST /v1/images/generations', () => {
  it('returns image generation result', async () => {
    const server = await buildTestServer({
      providers: {
        agnes: {
          enabled: true,
          credentials: { apiKey: 'test-key' },
        },
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-gateway-key',
      },
      payload: {
        model: 'agnes:agnes-image-2.5-flash',
        prompt: 'a cute cat',
        size: '1024x1024',
      },
    });

    assert.ok(res.statusCode === 200 || res.statusCode === 401);
  });

  it('rejects request without model', async () => {
    const server = await buildTestServer({
      providers: {
        agnes: { enabled: true, credentials: { apiKey: 'test-key' } },
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-gateway-key',
      },
      payload: {
        prompt: 'a cute cat',
      },
    });

    assert.equal(res.statusCode, 400);
  });
});
```

- [ ] **Step 2: 创建视频生成端点测试**

```typescript
// packages/server/src/routes/__tests__/videos.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTestServer } from '../../test-utils.js';

describe('POST /v1/videos', () => {
  it('returns video creation result', async () => {
    const server = await buildTestServer({
      providers: {
        agnes: {
          enabled: true,
          credentials: { apiKey: 'test-key' },
        },
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/videos',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-gateway-key',
      },
      payload: {
        model: 'agnes:agnes-video-v2.0',
        prompt: 'a cat playing',
        width: 1152,
        height: 768,
      },
    });

    assert.ok(res.statusCode === 200 || res.statusCode === 401);
  });
});

describe('GET /v1/videos/:video_id', () => {
  it('returns video status', async () => {
    const server = await buildTestServer({
      providers: {
        agnes: {
          enabled: true,
          credentials: { apiKey: 'test-key' },
        },
      },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/v1/videos/vid_123',
      headers: {
        authorization: 'Bearer test-gateway-key',
      },
    });

    assert.ok(res.statusCode === 200 || res.statusCode === 401);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: FAIL with "Route POST /v1/images/generations not found"

- [ ] **Step 4: 在 openai.ts 中添加图片生成路由**

在 `packages/server/src/routes/openai.ts` 中添加：

```typescript
import type {
  ImageGenerationRequest,
  VideoGenerationRequest,
} from '@freemodelfinder/core';

// ... 在 registerOpenAIRoutes 函数中添加：

// POST /v1/images/generations
fastify.post<{
  Body: ImageGenerationRequest;
}>('/v1/images/generations', async (req, reply) => {
  const body = req.body;
  if (!body?.model || !body?.prompt) {
    return reply.code(400).send({ error: { message: 'model and prompt are required' } });
  }

  try {
    const { provider, response } = await reg.generateImage(body);
    return reply.send({
      ...response,
      model: `${provider.id}:${body.model}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: { message } });
  }
});

// POST /v1/videos
fastify.post<{
  Body: VideoGenerationRequest;
}>('/v1/videos', async (req, reply) => {
  const body = req.body;
  if (!body?.model || !body?.prompt) {
    return reply.code(400).send({ error: { message: 'model and prompt are required' } });
  }

  try {
    const { provider, response } = await reg.generateVideo(body);
    return reply.send({
      ...response,
      model: `${provider.id}:${body.model}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: { message } });
  }
});

// GET /v1/videos/:video_id
fastify.get<{
  Params: { video_id: string };
}>('/v1/videos/:video_id', async (req, reply) => {
  const { video_id } = req.params;
  if (!video_id) {
    return reply.code(400).send({ error: { message: 'video_id is required' } });
  }

  // 从 query 参数获取 provider 信息
  const providerId = (req.query as Record<string, string>).provider;
  if (!providerId) {
    return reply.code(400).send({ error: { message: 'provider query parameter is required' } });
  }

  try {
    const provider = reg.getProvider(providerId);
    if (!provider.queryVideoStatus) {
      return reply.code(400).send({ error: { message: `Provider ${providerId} does not support video status queries` } });
    }
    const response = await provider.queryVideoStatus(video_id);
    return reply.send(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: { message } });
  }
});
```

- [ ] **Step 5: 更新 isPublicGatewayRoute 函数**

在 `packages/server/src/server.ts` 中更新公开路由列表：

```typescript
function isPublicGatewayRoute(url: string): boolean {
  const publicRoutes = [
    '/v1/models',
    '/v1/chat/completions',
    '/v1/messages',
    '/v1beta/',
    '/healthz',
    '/v1/images/generations',  // 新增
    '/v1/videos',              // 新增
  ];
  return publicRoutes.some((route) => url.startsWith(route));
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/routes/openai.ts packages/server/src/server.ts packages/server/src/routes/__tests__/
git commit -m "feat(server): add /v1/images/generations and /v1/videos endpoints"
```

---

### Task 5: 导出多模态类型

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 确保多模态类型已导出**

检查 `packages/core/src/index.ts` 已经通过 `export * from './types.js'` 导出了所有类型，无需额外修改。

- [ ] **Step 2: 运行完整测试套件**

Run: `pnpm --filter @freemodelfinder/core test && pnpm --filter @freemodelfinder/server test`
Expected: PASS

- [ ] **Step 3: 运行 lint 和 typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: verify multimodal support exports and types"
```

---

### Task 6: 端到端验证

**Files:**
- Manual testing with actual Agnes API key

- [ ] **Step 1: 启动本地服务器**

Run: `pnpm dev:server`

- [ ] **Step 2: 在 Dashboard 中配置 Agnes API Key**

打开 `http://127.0.0.1:11435`，在设置页添加 Agnes API Key

- [ ] **Step 3: 测试图片生成**

```bash
curl http://127.0.0.1:11435/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{
    "model": "agnes:agnes-image-2.5-flash",
    "prompt": "a cute orange cat sitting on a windowsill",
    "size": "1024x1024"
  }'
```

Expected: 返回包含图片 URL 的 JSON

- [ ] **Step 4: 测试视频生成**

```bash
curl http://127.0.0.1:11435/v1/videos \
  -H 'content-type: application/json' \
  -d '{
    "model": "agnes:agnes-video-v2.0",
    "prompt": "a cat playing with a ball of yarn",
    "width": 1152,
    "height": 768,
    "num_frames": 81,
    "frame_rate": 24
  }'
```

Expected: 返回包含 video_id 和 status 的 JSON

- [ ] **Step 5: 测试视频状态查询**

```bash
curl "http://127.0.0.1:11435/v1/videos/{video_id}?provider=agnes"
```

Expected: 返回视频状态和 URL（如果完成）

- [ ] **Step 6: 停止服务器并提交最终更改**

```bash
git add -A
git commit -m "feat: complete Agnes multimodal support with end-to-end verification"
```

---

## 完成检查清单

- [ ] 所有测试通过 (`pnpm test:coverage`)
- [ ] Lint 无警告 (`pnpm lint`)
- [ ] Typecheck 通过 (`pnpm typecheck`)
- [ ] 图片生成端点可用
- [ ] 视频生成端点可用
- [ ] 视频状态查询端点可用
- [ ] Agnes 模型列表包含 capabilities 标记
- [ ] 文档更新（可选）
