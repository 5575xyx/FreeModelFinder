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

type VisionHarnessOpts = {
  autoRoute?: AppConfig['autoRoute'];
  gateway?: AppConfig['gateway'];
  pool?: ModelInfo[];
};

async function appWithVisionFailover(opts: VisionHarnessOpts = {}): Promise<{
  app: FastifyInstance;
  chatModels: () => string[];
  lastRequest: () => ChatRequest | undefined;
  requests: () => ChatRequest[];
}> {
  const config: AppConfig = {
    version: 2,
    port: 11435,
    providers: {},
    gateway: { requireAuth: false, ...opts.gateway },
    autoRoute: opts.autoRoute ?? { enabled: false, strategy: 'capability' },
  };
  const registry = new ProviderRegistry(config);
  const chatModels: string[] = [];
  const requests: ChatRequest[] = [];
  let lastRequest: ChatRequest | undefined;
  const provider = {
    id: 'custom',
    async chat(request: ChatRequest): Promise<ChatResponse> {
      lastRequest = request;
      chatModels.push(request.model);
      requests.push(request);
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
      requests.push(request);
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
    models: opts.pool ?? visionPool,
    succeededProviders: ['custom'],
    failedProviders: [],
  });
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return {
    app,
    chatModels: () => chatModels,
    lastRequest: () => lastRequest,
    requests: () => requests,
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

describe('vision routing for an explicitly named model', () => {
  it('describes the image with a vision model, then answers with the named model', async () => {
    const { app, chatModels, requests } = await appWithVisionFailover();
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'text-only', messages: [imageMessage], stream: false },
    });
    assert.equal(res.statusCode, 200);

    const seen = chatModels();
    // A vision model was used to look at the image...
    const visionReq = requests().find((r) =>
      r.messages.some((m) => m.contentParts?.some((p) => p.type === 'image_url')),
    );
    assert.ok(
      visionReq && visionReq.model !== 'text-only',
      `a vision model must have received the image, saw ${JSON.stringify(seen)}`,
    );

    // ...but the named text-only model is the one that actually answers, and it
    // must NOT receive an image part — only the description text.
    assert.equal(seen[seen.length - 1], 'text-only', 'the final answer comes from the named model');
    const textOnlyReq = requests().find((r) => r.model === 'text-only');
    assert.ok(textOnlyReq, 'the named model must have been called');
    assert.equal(
      textOnlyReq!.messages.some((m) => m.contentParts?.some((p) => p.type === 'image_url')),
      false,
      'the text-only model must not receive an image part',
    );
    // The description text from the vision step is folded into the text.
    const joined = textOnlyReq!.messages
      .map(
        (m) =>
          m.content ?? m.contentParts?.map((p) => ('text' in p ? p.text : '')).join('\n') ?? '',
      )
      .join('\n');
    assert.match(joined, /vision reply/, 'the vision description must reach the named model');
  });

  it('falls back to sending the image to the named model when no vision model can describe it', async () => {
    const { app, chatModels, requests } = await appWithVisionFailover({
      pool: [
        {
          id: 'text-only',
          provider: 'custom',
          displayName: 'Text Only',
          free: true,
          inputModalities: ['text'],
        },
      ],
    });
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'text-only', messages: [imageMessage], stream: false },
    });
    // No vision model in the catalog: the image is handed to the named model as
    // before, which the (stubbed) upstream accepts here.
    assert.equal(res.statusCode, 200);
    assert.ok(chatModels().includes('text-only'));
    const req = requests().find((r) => r.model === 'text-only');
    assert.ok(
      req!.messages.some((m) => m.contentParts?.some((p) => p.type === 'image_url')),
      'with no vision model the image must reach the named model unchanged',
    );
  });

  it('describes the image then streams the named model answer', async () => {
    const { app, chatModels, requests } = await appWithVisionFailover();
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'text-only', messages: [imageMessage], stream: true },
    });
    assert.equal(res.statusCode, 200);
    const seen = chatModels();
    assert.equal(
      seen[seen.length - 1],
      'text-only',
      'the streamed answer comes from the named model',
    );
    const textOnlyReq = requests().find((r) => r.model === 'text-only');
    assert.ok(textOnlyReq, 'the named model must have been called');
    assert.equal(
      textOnlyReq!.messages.some((m) => m.contentParts?.some((p) => p.type === 'image_url')),
      false,
      'the streamed text-only request must not carry an image part',
    );
  });

  it('leaves a named model alone when it already declares image input', async () => {
    const { app, chatModels } = await appWithVisionFailover();
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'vision-up', messages: [imageMessage], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(chatModels(), ['vision-up']);
  });

  it('lets the visionModel pool exempt a model the id heuristic would reject', async () => {
    const { app, chatModels } = await appWithVisionFailover({
      autoRoute: {
        enabled: false,
        strategy: 'capability',
        visionModel: ['text-only', 'vision-up'],
      },
    });
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'text-only', messages: [imageMessage], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(chatModels(), ['text-only']);
  });

  it('keeps the named model rather than failing when nothing can see', async () => {
    const { app, chatModels } = await appWithVisionFailover({
      pool: [
        {
          id: 'text-only',
          provider: 'custom',
          displayName: 'Text Only',
          free: true,
          inputModalities: ['text'],
        },
      ],
    });
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'text-only', messages: [imageMessage], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(chatModels(), ['text-only']);
  });

  it('never redirects outside the caller key allowlist', async () => {
    const { app, chatModels } = await appWithVisionFailover({
      gateway: {
        requireAuth: true,
        keys: [
          {
            id: 'k1',
            key: 'test-key',
            createdAt: 0,
            modelAllowlist: ['custom:text-only', 'custom:vision-up'],
          },
        ],
      },
    });
    resetModalityCursors();
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-key' },
      payload: { model: 'text-only', messages: [imageMessage], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      chatModels().includes('vision-down'),
      false,
      `the redirect left the allowlist: ${JSON.stringify(chatModels())}`,
    );
    assert.ok(
      chatModels().includes('vision-up'),
      `expected the allowed vision model, saw ${JSON.stringify(chatModels())}`,
    );
  });

  it('keeps the auto-route vision pool inside the caller key allowlist', async () => {
    // `auto` + an image message picks from the vision pool. That pool must be
    // intersected with the allowlist too, or auto would hand a restricted key a
    // model it is not entitled to.
    const denied = await appWithVisionFailover({
      gateway: {
        requireAuth: true,
        keys: [
          {
            id: 'k1',
            key: 'test-key',
            createdAt: 0,
            modelAllowlist: ['custom:text-only'],
          },
        ],
      },
    });
    resetModalityCursors();
    resetAutoPoolCursor();
    const refused = await denied.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-key' },
      payload: { model: 'auto', messages: [imageMessage], stream: false },
    });
    assert.equal(refused.statusCode, 400, JSON.stringify(refused.json()));
    assert.equal((refused.json() as { error: { type: string } }).error.type, 'no_vision_model');
    assert.deepEqual(denied.chatModels(), [], 'no model may be dispatched');

    const allowed = await appWithVisionFailover({
      gateway: {
        requireAuth: true,
        keys: [
          {
            id: 'k1',
            key: 'test-key',
            createdAt: 0,
            modelAllowlist: ['custom:vision-up'],
          },
        ],
      },
    });
    resetModalityCursors();
    resetAutoPoolCursor();
    const served = await allowed.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-key' },
      payload: { model: 'auto', messages: [imageMessage], stream: false },
    });
    assert.equal(served.statusCode, 200, JSON.stringify(served.json()));
    assert.deepEqual(allowed.chatModels(), ['vision-up']);
  });
});
