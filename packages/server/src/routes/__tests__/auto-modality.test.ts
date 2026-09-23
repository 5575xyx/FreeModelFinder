import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../server.js';
import { detectRequestModality } from '../openai.js';

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

  it('keeps uploaded image parts as image', () => {
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
      'image',
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

function modalityRegistry(options: { autoRoute: AppConfig['autoRoute']; models: ModelInfo[] }): {
  registry: ProviderRegistry;
  imageCallCount: () => number;
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
  const provider = {
    id: 'custom',
    async chat(_request: ChatRequest): Promise<ChatResponse> {
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
    async generateImage() {
      imageCalls++;
      return {
        created: Date.now(),
        data: [{ url: 'https://example.invalid/cat.png' }],
      };
    },
  };
  registry.resolveModel = () => ({ provider: provider as never, modelId: 'fixture-model' });
  registry.listAllModels = async () => ({
    models: options.models,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  return { registry, imageCallCount: () => imageCalls };
}

async function withApp(
  options: Parameters<typeof modalityRegistry>[0],
  fn: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const { registry } = modalityRegistry(options);
  const { app } = await createServer({
    registry,
    watchIntervalMs: 60 * 60 * 1000,
  });
  try {
    await fn(app);
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
});
