import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from '../../server.js';
import { ProviderRegistry, type AppConfig, type ChatResponse } from '@freemodelfinder/core';

function testConfig(): AppConfig {
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
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

function fakeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry(testConfig());
  const response: ChatResponse = {
    id: 'fixture-response',
    model: 'fixture-model',
    created: 1_700_000_000,
    content: 'fixture reply',
    finish_reason: 'stop',
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  };
  const provider = {
    id: 'custom',
    async chat() {
      return response;
    },
    async *stream() {
      yield {
        id: 'fixture-stream',
        model: 'fixture-model',
        created: 1_700_000_000,
        delta: 'fixture ',
      };
      yield {
        id: 'fixture-stream',
        model: 'fixture-model',
        created: 1_700_000_000,
        delta: 'reply',
        finish_reason: 'stop' as const,
      };
    },
    async generateVideo() {
      return {
        video_id: 'vid_test123',
        status: 'queued' as const,
      };
    },
    async queryVideoStatus() {
      return {
        video_id: 'vid_test123',
        status: 'completed' as const,
        video_url: 'https://example.com/video.mp4',
        progress: 100,
      };
    },
  };
  registry.resolveModel = () => ({
    provider: provider as never,
    modelId: 'fixture-model',
  });
  registry.listAllModels = async () => ({
    models: [
      {
        id: 'fixture-model',
        provider: 'custom',
        displayName: 'Fixture Model',
        free: true,
      },
    ],
    succeededProviders: ['custom'],
    failedProviders: [],
  });
  registry.queryVideoStatus = async (videoId: string, _providerId: string) => ({
    provider: {} as never,
    response: {
      video_id: videoId,
      status: 'completed' as const,
      video_url: 'https://example.com/video.mp4',
      progress: 100,
    },
  });
  return registry;
}

describe('POST /v1/videos', () => {
  it('returns video creation result', async () => {
    const { app } = await createServer({
      registry: fakeRegistry(),
      watchIntervalMs: 60 * 60 * 1000,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/videos',
        payload: {
          model: 'custom:fixture-model',
          prompt: 'a cat playing',
          width: 1152,
          height: 768,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.video_id, 'vid_test123');
      assert.equal(body.status, 'queued');
    } finally {
      await app.close();
    }
  });

  it('rejects request without model', async () => {
    const { app } = await createServer({
      registry: fakeRegistry(),
      watchIntervalMs: 60 * 60 * 1000,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/videos',
        payload: {
          prompt: 'a cat playing',
        },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('rejects request without prompt', async () => {
    const { app } = await createServer({
      registry: fakeRegistry(),
      watchIntervalMs: 60 * 60 * 1000,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/videos',
        payload: {
          model: 'custom:fixture-model',
        },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/videos/:video_id', () => {
  it('returns video status', async () => {
    const { app } = await createServer({
      registry: fakeRegistry(),
      watchIntervalMs: 60 * 60 * 1000,
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/videos/vid_test123?provider=custom',
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.video_id, 'vid_test123');
      assert.equal(body.status, 'completed');
      assert.equal(body.video_url, 'https://example.com/video.mp4');
    } finally {
      await app.close();
    }
  });

  it('rejects request without provider query', async () => {
    const { app } = await createServer({
      registry: fakeRegistry(),
      watchIntervalMs: 60 * 60 * 1000,
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/videos/vid_test123',
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
