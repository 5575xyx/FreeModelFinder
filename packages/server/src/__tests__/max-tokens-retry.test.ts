import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type StreamChunk,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const MAX_TOKENS_ERROR = new Error(
  'custom stream failed 400: {"error":{"message":"max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.","type":"invalid_request_error","param":"max_tokens","code":"invalid_value"}}',
);

async function appWithMaxTokensGate(): Promise<{
  app: FastifyInstance;
  seenMaxTokens: () => Array<number | undefined>;
  failUntilWithinLimit: () => void;
}> {
  const config: AppConfig = {
    version: 2,
    port: 11435,
    providers: {},
    autoRoute: { enabled: false, strategy: 'capability' },
  };
  const registry = new ProviderRegistry(config);
  const seen: Array<number | undefined> = [];
  let enforce = false;
  const provider = {
    id: 'custom',
    async chat(request: ChatRequest): Promise<ChatResponse> {
      seen.push(request.max_tokens);
      if (enforce && (request.max_tokens == null || request.max_tokens > 16384)) {
        throw MAX_TOKENS_ERROR;
      }
      return {
        id: 'ok',
        model: 'primary',
        created: 1,
        content: 'clamped reply',
        finish_reason: 'stop',
      };
    },
    async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      seen.push(request.max_tokens);
      if (enforce && (request.max_tokens == null || request.max_tokens > 16384)) {
        throw MAX_TOKENS_ERROR;
      }
      yield {
        id: 's',
        model: 'primary',
        created: 1,
        delta: 'clamped reply',
        finish_reason: 'stop',
      };
    },
  };
  registry.resolveModel = () => ({ provider: provider as never, modelId: 'primary' });
  registry.listAllModels = async () => ({
    models: [{ id: 'primary', provider: 'custom', displayName: 'Primary', free: true }],
    succeededProviders: ['custom'],
    failedProviders: [],
  });
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return {
    app,
    seenMaxTokens: () => seen,
    failUntilWithinLimit: () => {
      enforce = true;
    },
  };
}

describe('max_tokens overflow retry', () => {
  it('non-stream retries with a reduced max_tokens after upstream 400', async () => {
    const { app, seenMaxTokens, failUntilWithinLimit } = await appWithMaxTokensGate();
    failUntilWithinLimit();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'custom:primary',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32000,
        stream: false,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]!.message.content, 'clamped reply');
    const seen = seenMaxTokens();
    assert.ok(seen.length >= 2, `expected retry, saw ${JSON.stringify(seen)}`);
    assert.equal(seen[0], 32000);
    assert.equal(seen[1], 16384);
  });

  it('stream retries with a reduced max_tokens after upstream 400', async () => {
    const { app, seenMaxTokens, failUntilWithinLimit } = await appWithMaxTokensGate();
    failUntilWithinLimit();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'custom:primary',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32000,
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /clamped reply/);
    const seen = seenMaxTokens();
    assert.ok(seen.length >= 2, `expected retry, saw ${JSON.stringify(seen)}`);
    assert.equal(seen[0], 32000);
    assert.equal(seen[1], 16384);
  });
});
