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
import { createServer } from '../server.js';

function textMsg(content: string) {
  return { role: 'user' as const, content };
}

function rrConfig(autoRoute: AppConfig['autoRoute']): AppConfig {
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
                apiKey: 'k',
                models: [{ id: 'img-a' }, { id: 'img-b' }, { id: 'plain' }],
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

function rrRegistry(autoRoute: AppConfig['autoRoute']) {
  const seen: string[] = [];
  const registry = new ProviderRegistry(rrConfig(autoRoute));
  const response: ChatResponse = {
    id: 'r',
    model: 'fixture-model',
    created: 1,
    content: 'ok',
    finish_reason: 'stop',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const provider = {
    id: 'custom',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      return { ...response, model: req.model };
    },
    async *stream(req: ChatRequest) {
      yield {
        id: 's',
        model: req.model,
        created: 1,
        delta: 'ok',
        finish_reason: 'stop' as const,
      };
    },
    async generateImage(req: { model: string }) {
      return { created: 1, data: [{ url: `https://example.invalid/${req.model}.png` }] };
    },
  };
  registry.resolveModel = (modelId: string) => {
    seen.push(modelId);
    return { provider: provider as never, modelId };
  };
  registry.listAllModels = async () => ({
    models: [
      {
        id: 'fixture:plain',
        provider: 'custom',
        displayName: 'Plain',
        free: true,
      } satisfies ModelInfo,
    ],
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  return { registry, seen };
}

async function withApp(
  autoRoute: AppConfig['autoRoute'],
  fn: (app: FastifyInstance, seen: string[]) => Promise<void>,
): Promise<void> {
  const { registry, seen } = rrRegistry(autoRoute);
  const { app } = await createServer({
    registry,
    watchIntervalMs: 60 * 60 * 1000,
  });
  try {
    await fn(app, seen);
  } finally {
    await app.close();
  }
}

async function postImage(app: FastifyInstance): Promise<unknown> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      model: 'auto',
      messages: [textMsg('生成小猫图片')],
      stream: false,
    },
  });
  assert.equal(res.statusCode, 200);
  return res.json();
}

describe('auto-route multi-model round robin', () => {
  it('round-robins imageModel pool across consecutive requests', async () => {
    await withApp(
      {
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:fixture:img-a', 'custom:fixture:img-b'],
      },
      async (app) => {
        const models: string[] = [];
        for (let i = 0; i < 4; i++) {
          const body = (await postImage(app)) as { model?: string };
          models.push(body.model ?? '');
        }
        const unique = new Set(models);
        assert.equal(unique.size, 2, `expected 2 distinct models, got ${models.join(',')}`);
        assert.ok(models.includes('custom:fixture:img-a'));
        assert.ok(models.includes('custom:fixture:img-b'));
        for (let i = 1; i < models.length; i++) {
          assert.notEqual(models[i], models[i - 1]);
        }
      },
    );
  });

  it('keeps single-element pool stable', async () => {
    await withApp(
      {
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:fixture:only'],
      },
      async (app) => {
        const a = (await postImage(app)) as { model?: string };
        const b = (await postImage(app)) as { model?: string };
        assert.equal(a.model, 'custom:fixture:only');
        assert.equal(b.model, 'custom:fixture:only');
      },
    );
  });

  it('accepts legacy string imageModel in config file', async () => {
    await withApp(
      {
        enabled: false,
        strategy: 'capability',
        imageModel: 'custom:fixture:legacy' as unknown as string[],
      },
      async (app) => {
        const body = (await postImage(app)) as { model?: string };
        assert.equal(body.model, 'custom:fixture:legacy');
      },
    );
  });

  it('does not consume image cursor when text tier is used', async () => {
    await withApp(
      {
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:fixture:img-a', 'custom:fixture:img-b'],
        textTiers: { simple: ['custom:fixture:s0', 'custom:fixture:s1'] },
      },
      async (app) => {
        const t1 = (
          await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            payload: { model: 'auto', messages: [textMsg('hi')], stream: false },
          })
        ).json() as { model?: string };
        const t2 = (
          await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            payload: { model: 'auto', messages: [textMsg('hello')], stream: false },
          })
        ).json() as { model?: string };
        assert.notEqual(t1.model, t2.model);

        const i1 = (await postImage(app)) as { model?: string };
        const i2 = (await postImage(app)) as { model?: string };
        assert.ok(i1.model === 'custom:fixture:img-a' || i1.model === 'custom:fixture:img-b');
        assert.ok(i2.model === 'custom:fixture:img-a' || i2.model === 'custom:fixture:img-b');
        assert.notEqual(i1.model, i2.model);
      },
    );
  });
});
