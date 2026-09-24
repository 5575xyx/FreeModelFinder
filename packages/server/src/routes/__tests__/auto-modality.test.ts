import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ProviderRegistry,
  resetAutoPoolCursor,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type ProviderId,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';
import { detectRequestModality, extractGenerationPrompt } from '../openai.js';

function textMsg(content: string) {
  return { role: 'user' as const, content };
}

describe('detectRequestModality image text intent', () => {
  it('detects Chinese image generation prompts', () => {
    assert.equal(detectRequestModality([textMsg('生成小猫图片')]), 'image');
    assert.equal(detectRequestModality([textMsg('帮我画一张风景插画')]), 'image');
    assert.equal(detectRequestModality([textMsg('画一张图')]), 'image');
    assert.equal(detectRequestModality([textMsg('generate an image of a cat')]), 'image');
  });

  it('does not flag ordinary chat', () => {
    assert.equal(detectRequestModality([textMsg('介绍一下 OpenRouter')]), 'text');
    assert.equal(detectRequestModality([textMsg('这张地图怎么走')]), 'text');
  });

  it('does not flag map/GUI/diagram questions as image intent', () => {
    assert.equal(detectRequestModality([textMsg('画地图')]), 'text');
    assert.equal(detectRequestModality([textMsg('做个图形界面')]), 'text');
    assert.equal(detectRequestModality([textMsg('make a diagram')]), 'text');
  });

  it('keeps video keyword priority over image text', () => {
    assert.equal(detectRequestModality([textMsg('生成一段小猫视频')]), 'video');
  });

  it('uses the latest user message, not earlier image history', () => {
    assert.equal(
      detectRequestModality([textMsg('生成小猫图片'), textMsg('生成小猫卖萌视频')]),
      'video',
    );
    assert.equal(
      detectRequestModality([
        textMsg('帮我画一张风景插画'),
        { role: 'assistant' as const, content: 'done' },
        textMsg('生成小猫卖萌视频'),
      ]),
      'video',
    );
  });

  it('prefers latest image intent over earlier video history', () => {
    assert.equal(
      detectRequestModality([textMsg('生成一段小猫视频'), textMsg('生成小猫图片')]),
      'image',
    );
  });

  it('treats latest plain chat as text even after earlier image intent', () => {
    assert.equal(
      detectRequestModality([textMsg('生成小猫图片'), textMsg('介绍一下 OpenRouter')]),
      'text',
    );
  });

  it('keeps uploaded image parts as vision', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'http://x/y.png' } } as {
      type: string;
      text?: string;
    };
    assert.equal(
      detectRequestModality([
        {
          role: 'user' as const,
          content: [imagePart],
        },
      ]),
      'vision',
    );
  });

  it('detects vision when latest user uploads an image part', () => {
    assert.equal(
      detectRequestModality([
        {
          role: 'user' as const,
          content: [{ type: 'image_url', image_url: { url: 'http://x/y.png' } } as never],
        },
      ]),
      'vision',
    );
  });

  it('image part wins over generation keywords in the same message', () => {
    assert.equal(
      detectRequestModality([
        {
          role: 'user' as const,
          content: [
            { type: 'text', text: '生成一张图片' },
            { type: 'image_url', image_url: { url: 'http://x/y.png' } } as never,
          ],
        },
      ]),
      'vision',
    );
  });

  it('does not trigger vision from image only in history', () => {
    assert.equal(
      detectRequestModality([
        {
          role: 'user' as const,
          content: [{ type: 'image_url', image_url: { url: 'http://old.png' } } as never],
        },
        { role: 'assistant' as const, content: 'ok' },
        { role: 'user' as const, content: '介绍一下 OpenRouter' },
      ]),
      'text',
    );
  });
});

describe('extractGenerationPrompt', () => {
  it('returns only the latest non-empty user message', () => {
    assert.equal(
      extractGenerationPrompt([
        { role: 'system', content: '系统指令' },
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'user', content: '生成小猫图片' },
      ]),
      '生成小猫图片',
    );
  });

  it('skips empty user messages and assistant turns', () => {
    assert.equal(
      extractGenerationPrompt([
        { role: 'user', content: '画一只猫' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: '   ' },
      ]),
      '画一只猫',
    );
  });

  it('returns empty string when no user text exists', () => {
    assert.equal(
      extractGenerationPrompt([
        { role: 'system', content: '系统指令' },
        { role: 'assistant', content: '你好' },
      ]),
      '',
    );
  });
});

function modalityConfig(autoRoute: AppConfig['autoRoute']): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {
      custom: {
        enabled: true,
        credentials: {
          apiKey: '',
          extra: {
            sources: [
              {
                id: 'fixture',
                label: 'Fixture',
                baseUrl: 'https://fixture.invalid/v1',
                apiKey: 'source-key',
                models: [{ id: 'fixture-model' }],
              },
            ],
          },
        },
      },
    },
    gateway: { requireAuth: false },
    autoRoute,
  };
}

function modalityRegistry(options: {
  autoRoute: AppConfig['autoRoute'];
  models: ModelInfo[];
  realResolveModel?: boolean;
  chatErrorMessage?: string;
}): {
  registry: ProviderRegistry;
  imageCallCount: () => number;
  videoCallCount: () => number;
  lastImagePrompt: () => string | undefined;
  lastVideoPrompt: () => string | undefined;
  lastChatRequest: () => ChatRequest | undefined;
} {
  const registry = new ProviderRegistry(modalityConfig(options.autoRoute));
  const response: ChatResponse = {
    id: 'fixture-response',
    model: 'fixture-model',
    created: 1_700_000_000,
    content: 'fixture reply',
    finish_reason: 'stop',
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  };
  let imageCalls = 0;
  let videoCalls = 0;
  let lastImagePrompt: string | undefined;
  let lastVideoPrompt: string | undefined;
  let lastChatRequest: ChatRequest | undefined;
  const provider = {
    id: 'custom',
    async chat(request: ChatRequest): Promise<ChatResponse> {
      lastChatRequest = request;
      if (options.chatErrorMessage) {
        throw new Error(options.chatErrorMessage);
      }
      return response;
    },
    async *stream(_request: ChatRequest) {
      yield {
        id: 'fixture-stream',
        model: 'fixture-model',
        created: 1_700_000_000,
        delta: 'fixture reply',
        finish_reason: 'stop' as const,
      };
    },
    async generateImage(req: { prompt: string }) {
      imageCalls++;
      lastImagePrompt = req.prompt;
      return {
        created: Date.now(),
        data: [{ url: 'https://example.invalid/cat.png' }],
      };
    },
    async generateVideo(req: { prompt: string }) {
      videoCalls++;
      lastVideoPrompt = req.prompt;
      return {
        video_id: 'vid_fixture123',
        status: 'submitted' as const,
        provider: 'custom',
      };
    },
  };
  const handles = {
    registry,
    imageCallCount: () => imageCalls,
    videoCallCount: () => videoCalls,
    lastImagePrompt: () => lastImagePrompt,
    lastVideoPrompt: () => lastVideoPrompt,
    lastChatRequest: () => lastChatRequest,
  };
  if (options.realResolveModel) {
    const internals = registry as unknown as {
      instances: Map<ProviderId, unknown>;
      modelsCache: unknown;
      cacheAt: number;
    };
    internals.instances.set('custom', provider);
    internals.modelsCache = {
      models: options.models,
      succeededProviders: ['custom'],
      failedProviders: [],
    };
    internals.cacheAt = Date.now();
    return handles;
  }
  registry.resolveModel = () => ({ provider: provider as never, modelId: 'fixture-model' });
  registry.listAllModels = async () => ({
    models: options.models,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  return handles;
}

async function withApp(
  options: Parameters<typeof modalityRegistry>[0],
  fn: (app: FastifyInstance, handles: ReturnType<typeof modalityRegistry>) => Promise<void>,
): Promise<void> {
  const handles = modalityRegistry(options);
  const { app } = await createServer({
    registry: handles.registry,
    watchIntervalMs: 60 * 60 * 1000,
  });
  try {
    await fn(app, handles);
  } finally {
    await app.close();
  }
}

const textOnlyModel: ModelInfo = {
  id: 'fixture-model',
  provider: 'custom',
  displayName: 'Fixture Model',
  free: true,
};

const capabilityImageModel: ModelInfo = {
  id: 'picsa-mirror-1',
  provider: 'custom',
  displayName: 'Picsa Mirror',
  free: true,
  capabilities: ['image'],
};

describe('auto modality HTTP routing', () => {
  it('reports fmf_auto_route on auto text picks and round-robins across the scored pool', async () => {
    await withApp(
      {
        autoRoute: {
          enabled: false,
          strategy: 'capability',
          imageModel: ['custom:img-model'],
        },
        models: [
          textOnlyModel,
          {
            id: 'second-text-model',
            provider: 'custom',
            displayName: 'Second Text',
            free: true,
          },
        ],
        realResolveModel: true,
      },
      async (app) => {
        resetAutoPoolCursor();
        const res1 = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '你好' }],
            stream: false,
          },
        });
        assert.equal(res1.statusCode, 200);
        const r1 = res1.json() as {
          model: string;
          fmf_auto_route?: { picked: string; strategy: string };
        };
        assert.deepEqual(r1.fmf_auto_route, {
          picked: r1.model,
          strategy: 'capability',
        });
        const res2 = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '你好' }],
            stream: false,
          },
        });
        assert.equal(res2.statusCode, 200);
        const r2 = res2.json() as {
          model: string;
          fmf_auto_route?: { picked: string; strategy: string };
        };
        assert.deepEqual(r2.fmf_auto_route, {
          picked: r2.model,
          strategy: 'capability',
        });
        assert.notEqual(r1.model, r2.model, 'two consecutive auto picks should differ');
        const resStream = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '你好' }],
            stream: true,
          },
        });
        assert.equal(resStream.statusCode, 200);
        const chunkLines = resStream.body
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => {
            try {
              return JSON.parse(l.slice(6));
            } catch {
              return null;
            }
          })
          .filter((c) => c !== null && c.type !== 'upstream_error');
        const chunkWithRoute = chunkLines.find((c) => c.fmf_auto_route !== undefined);
        assert.ok(chunkWithRoute, 'stream chunk should carry fmf_auto_route');
        assert.equal(
          (chunkWithRoute?.fmf_auto_route as { strategy: string }).strategy,
          'capability',
        );
      },
    );
  });

  it('routes auto image intent to configured imageModel', async () => {
    await withApp(
      {
        autoRoute: {
          enabled: false,
          strategy: 'capability',
          imageModel: ['custom:img-model'],
        },
        models: [textOnlyModel],
      },
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '生成小猫图片' }],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.model, 'custom:img-model');
        assert.match(body.choices[0].message.content, /cat\.png/);
        assert.equal(body.fmf_image_response.data[0].url, 'https://example.invalid/cat.png');
      },
    );
  });

  it('routes legacy string imageModel without truncating to its first character', async () => {
    await withApp(
      {
        autoRoute: {
          enabled: false,
          strategy: 'capability',
          imageModel: 'custom:img-model' as unknown as string[],
        },
        models: [textOnlyModel],
      },
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '生成小猫图片' }],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.model, 'custom:img-model');
        assert.match(body.choices[0].message.content, /cat\.png/);
      },
    );
  });

  it('keeps auto text intent on the text path', async () => {
    await withApp(
      {
        autoRoute: {
          enabled: false,
          strategy: 'capability',
          imageModel: ['custom:img-model'],
        },
        models: [textOnlyModel],
      },
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '你好' }],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.choices[0].message.content, 'fixture reply');
        assert.equal(body.fmf_image_response, undefined);
      },
    );
  });

  it('discovers an image-capable model when imageModel is unset', async () => {
    await withApp(
      {
        autoRoute: { enabled: false, strategy: 'capability' },
        models: [textOnlyModel, capabilityImageModel],
      },
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '生成小猫图片' }],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.model, 'picsa-mirror-1');
        assert.match(body.choices[0].message.content, /cat\.png/);
        assert.equal(body.fmf_image_response.data[0].url, 'https://example.invalid/cat.png');
      },
    );
  });

  it('discovers a model whose id contains image when imageModel is unset', async () => {
    await withApp(
      {
        autoRoute: { enabled: false, strategy: 'capability' },
        models: [
          textOnlyModel,
          {
            id: 'image-fixture-1',
            provider: 'custom',
            displayName: 'Image Fixture',
            free: true,
          },
        ],
      },
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '生成小猫图片' }],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.model, 'image-fixture-1');
        assert.match(body.choices[0].message.content, /cat\.png/);
      },
    );
  });

  it('routes video intent to videoModel even after earlier image history', async () => {
    await withApp(
      {
        autoRoute: {
          enabled: false,
          strategy: 'capability',
          imageModel: ['custom:img-model'],
          videoModel: ['custom:vid-model'],
        },
        models: [textOnlyModel],
      },
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [
              { role: 'user', content: '生成小猫图片' },
              { role: 'assistant', content: 'done' },
              { role: 'user', content: '生成小猫卖萌视频' },
            ],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.model, 'custom:vid-model');
        assert.equal(body.fmf_image_response, undefined);
        assert.equal(body.fmf_video_response?.video_id, 'vid_fixture123');
        assert.match(body.choices[0].message.content, /vid_fixture123/);
      },
    );
  });

  it('falls back to text when no image model is discoverable', async () => {
    await withApp(
      {
        autoRoute: { enabled: false, strategy: 'capability' },
        models: [textOnlyModel],
      },
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [{ role: 'user', content: '生成小猫图片' }],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.choices[0].message.content, 'fixture reply');
        assert.equal(body.fmf_image_response, undefined);
      },
    );
  });

  it('uses only the latest user message as image prompt despite long history', async () => {
    const filler = '历史背景内容'.repeat(2000);
    await withApp(
      {
        autoRoute: {
          enabled: false,
          strategy: 'capability',
          imageModel: ['custom:img-model'],
        },
        models: [textOnlyModel],
      },
      async (app, handles) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [
              { role: 'system', content: filler },
              { role: 'user', content: filler },
              { role: 'assistant', content: filler },
              { role: 'user', content: '生成小猫图片' },
            ],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.model, 'custom:img-model');
        const prompt = handles.lastImagePrompt();
        assert.equal(prompt, '生成小猫图片');
        assert.ok((prompt ?? '').length < 10000, 'image prompt must stay under provider limit');
      },
    );
  });

  it('uses only the latest user message as video prompt despite long history', async () => {
    const filler = '历史背景内容'.repeat(2000);
    await withApp(
      {
        autoRoute: {
          enabled: false,
          strategy: 'capability',
          imageModel: ['custom:img-model'],
          videoModel: ['custom:vid-model'],
        },
        models: [textOnlyModel],
      },
      async (app, handles) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'auto',
            messages: [
              { role: 'system', content: filler },
              { role: 'user', content: filler },
              { role: 'assistant', content: filler },
              { role: 'user', content: '生成小猫卖萌视频' },
            ],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.model, 'custom:vid-model');
        const prompt = handles.lastVideoPrompt();
        assert.equal(prompt, '生成小猫卖萌视频');
        assert.ok((prompt ?? '').length < 10000, 'video prompt must stay under provider limit');
      },
    );
  });

  it('explicit model with image part goes to chat with contentParts (not image gen)', async () => {
    await withApp(
      {
        autoRoute: { enabled: false, strategy: 'capability' },
        models: [textOnlyModel],
      },
      async (app, handles) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'custom:fixture-model',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: '描述这张图' },
                  { type: 'image_url', image_url: { url: 'http://x/y.png' } },
                ],
              },
            ],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(handles.imageCallCount(), 0, 'explicit model must not hit generateImage');
        const chatReq = handles.lastChatRequest();
        assert.ok(chatReq, 'chat must be invoked');
        const parts = chatReq!.messages[0]!.contentParts;
        assert.ok(parts, 'contentParts must flow into chat request');
        assert.equal(
          parts!.some((p) => p.type === 'image_url'),
          true,
        );
        const body = res.json();
        assert.equal(body.choices[0].message.content, 'fixture reply');
        assert.equal(body.fmf_image_response, undefined);
      },
    );
  });

  it('upstream image rejection surfaces vision_input_error', async () => {
    await withApp(
      {
        autoRoute: { enabled: false, strategy: 'capability' },
        models: [textOnlyModel],
        chatErrorMessage: 'Provider custom does not support image input',
      },
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload: {
            model: 'custom:fixture-model',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: '描述这张图' },
                  { type: 'image_url', image_url: { url: 'http://x/y.png' } },
                ],
              },
            ],
            stream: false,
          },
        });
        assert.equal(res.statusCode, 400);
        const body = res.json() as { error: { message: string; type: string } };
        assert.equal(body.error.type, 'vision_input_error');
        assert.match(body.error.message, /does not support image input/);
      },
    );
  });
});
