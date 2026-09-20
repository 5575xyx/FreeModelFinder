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
      yield { id: 'fixture-stream', model: 'fixture-model', created: 1_700_000_000, delta: 'fixture ' };
      yield { id: 'fixture-stream', model: 'fixture-model', created: 1_700_000_000, delta: 'reply', finish_reason: 'stop' as const };
    },
    async generateImage() {
      return {
        created: Date.now(),
        data: [{ url: 'https://example.com/image.png' }],
      };
    },
  };
  registry.resolveModel = () => ({ provider: provider as never, modelId: 'fixture-model' });
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
  return registry;
}

describe('POST /v1/images/generations', () => {
  it('returns image generation result', async () => {
    const { app } = await createServer({
      registry: fakeRegistry(),
      watchIntervalMs: 60 * 60 * 1000,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/images/generations',
        payload: {
          model: 'custom:fixture-model',
          prompt: 'a cute cat',
          size: '1024x1024',
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.model, 'custom:fixture-model');
      assert.ok(Array.isArray(body.data));
      assert.equal(body.data[0].url, 'https://example.com/image.png');
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
        url: '/v1/images/generations',
        payload: {
          prompt: 'a cute cat',
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
        url: '/v1/images/generations',
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
