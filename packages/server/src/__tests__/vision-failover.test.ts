import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  resetAutoPoolCursor,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type StreamChunk,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import { resetModalityCursors } from '../routes/openai.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  resetModalityCursors();
  resetAutoPoolCursor();
});

const visionPool: ModelInfo[] = [
  {
    id: 'vision-down',
    provider: 'custom',
    displayName: 'Vision Down',
    free: true,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'vision-up',
    provider: 'custom',
    displayName: 'Vision Up',
    free: true,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'text-only',
    provider: 'custom',
    displayName: 'Text Only',
    free: true,
    inputModalities: ['text'],
  },
];

const imageMessage = {
  role: 'user' as const,
  content: [
    { type: 'text', text: '这是什么?' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
  ],
};

async function appWithVisionFailover(): Promise<{
  app: FastifyInstance;
  chatModels: () => string[];
  lastRequest: () => ChatRequest | undefined;
}> {
  const config: AppConfig = {
    version: 2,
    port: 11435,
    providers: {},
    autoRoute: { enabled: false, strategy: 'capability' },
  };
  const registry = new ProviderRegistry(config);
  const chatModels: string[] = [];
  let lastRequest: ChatRequest | undefined;
  const provider = {
    id: 'custom',
    async chat(request: ChatRequest): Promise<ChatResponse> {
      lastRequest = request;
      chatModels.push(request.model);
      if (request.model === 'vision-down') {
        throw new Error(
          'custom chat failed 503: {"error":{"message":"No available channel for model vision-down","type":"new_api_error","code":"model_not_found"}}',
        );
      }
      return {
        id: 'ok',
        model: request.model,
        created: 1,
        content: 'vision reply',
        finish_reason: 'stop',
      };
    },
    async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      lastRequest = request;
      chatModels.push(request.model);
      if (request.model === 'vision-down') {
        throw new Error(
          'custom stream failed 503: {"error":{"message":"No available channel for model vision-down","type":"new_api_error","code":"model_not_found"}}',
        );
      }
      yield {
        id: 's',
        model: request.model,
        created: 1,
        delta: 'vision reply',
        finish_reason: 'stop',
      };
    },
  };
  registry.resolveModel = (modelId: string) => {
    const bare = modelId.split(':').pop() ?? modelId;
    return { provider: provider as never, modelId: bare };
  };
  registry.listAllModels = async () => ({
    models: visionPool,
    succeededProviders: ['custom'],
    failedProviders: [],
  });
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return {
    app,
    chatModels: () => chatModels,
    lastRequest: () => lastRequest,
  };
}

describe('vision model failover', () => {
  it('non-stream falls through a dead vision model to the next vision model', async () => {
    const { app, chatModels, lastRequest } = await appWithVisionFailover();
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [imageMessage], stream: false },
    });
    assert.equal(res.statusCode, 200);
    const seen = chatModels();
    assert.ok(
      seen.includes('vision-down'),
      `expected dead model attempt, saw ${JSON.stringify(seen)}`,
    );
    assert.ok(seen.includes('vision-up'), `expected failover, saw ${JSON.stringify(seen)}`);
    const body = res.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]!.message.content, 'vision reply');
    const parts = lastRequest()?.messages[0]?.contentParts;
    assert.ok(
      parts?.some((p) => p.type === 'image_url'),
      'image must reach the healthy vision model',
    );
  });

  it('stream falls through a dead vision model to the next vision model', async () => {
    const { app, chatModels } = await appWithVisionFailover();
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [imageMessage], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /vision reply/);
    const seen = chatModels();
    assert.ok(
      seen.includes('vision-down'),
      `expected dead model attempt, saw ${JSON.stringify(seen)}`,
    );
    assert.ok(seen.includes('vision-up'), `expected failover, saw ${JSON.stringify(seen)}`);
    assert.doesNotMatch(res.body, /No available channel/);
  });

  it('does not fall over to a text-only model', async () => {
    const { app, chatModels } = await appWithVisionFailover();
    resetModalityCursors();
    resetAutoPoolCursor();
    // Force both vision models to fail by making "up" fail too — simulate via pool order:
    // here only "down" fails; if failover were broken it might pick text-only and still 200.
    // Instead assert chatModels never includes text-only when a vision model can succeed.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [imageMessage], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(chatModels().includes('text-only'), false);
  });
});
