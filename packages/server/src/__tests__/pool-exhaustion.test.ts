import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatResponse,
  type ProviderId,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

/**
 * When every candidate in the pool is down, the gateway must say so distinctly
 * instead of surfacing the first candidate's raw upstream error.
 *
 * A raw `custom chat failed 429: …` reads exactly the same as "one model is
 * cooling down", so a client cannot tell whether it should retry immediately on
 * another model or back off entirely. And when the exhaustion is rate-limit
 * driven the client also needs the back-off hint, otherwise it cannot time a
 * retry at all and either gives up or hammers.
 */

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const CATALOG = [
  { id: 'fx:fast', provider: 'custom' as const, displayName: 'Fast', free: true },
  { id: 'fy:slow', provider: 'custom' as const, displayName: 'Slow', free: true },
];

const RATE_LIMIT = 'custom chat failed 429: rate limit exceeded, retry-after: 45';

function baseConfig(): AppConfig {
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
                id: 'fx',
                label: 'FX',
                baseUrl: 'https://fx.invalid/v1',
                apiKey: 'k',
                models: [{ id: 'fast', displayName: 'Fast' }],
              },
              {
                id: 'fy',
                label: 'FY',
                baseUrl: 'https://fy.invalid/v1',
                apiKey: 'k',
                models: [{ id: 'slow', displayName: 'Slow' }],
              },
            ],
          },
        },
      },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: true, strategy: 'capability' },
  };
}

/** A gateway whose whole pool answers every request with the same rate limit. */
async function allDownApp(): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(baseConfig());
  const cache = {
    models: CATALOG,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  };
  registry.listAllModels = async () => cache;
  (registry as unknown as { modelsCache: unknown; cacheAt: number }).modelsCache = cache;
  (registry as unknown as { cacheAt: number }).cacheAt = Date.now();
  registry.getProvider = ((providerId: ProviderId) => ({
    id: providerId,
    chat: async (): Promise<ChatResponse> => {
      throw new Error(RATE_LIMIT);
    },
    stream: async function* (): AsyncIterable<never> {
      // Nothing is ever yielded: the dispatch rejects before the first chunk.
      yield* [];
      throw new Error(RATE_LIMIT);
    },
  })) as never;
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

/** The `data:` payloads of an SSE body, in order. */
function ssePayloads(body: string): Array<Record<string, unknown>> {
  return body
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.replace(/^event:[^\n]*\n/, ''))
    .map((frame) => (frame.startsWith('data: ') ? frame.slice('data: '.length).trim() : ''))
    .filter((json) => json.startsWith('{'))
    .map((json) => JSON.parse(json) as Record<string, unknown>);
}

const MESSAGES = [{ role: 'user', content: 'hi' }];

async function openai(app: FastifyInstance, stream = false) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model: 'auto', messages: MESSAGES, stream },
  });
}

async function anthropic(app: FastifyInstance, stream = false) {
  return app.inject({
    method: 'POST',
    url: '/v1/messages',
    payload: { model: 'auto', max_tokens: 16, messages: MESSAGES, stream },
  });
}

async function gemini(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/v1beta/models/auto:generateContent',
    payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
  });
}

describe('an exhausted pool reports exhaustion, not the first candidate\'s error', () => {
  it('OpenAI chat: 503 model_unavailable carrying both candidates and the hint', async () => {
    const res = await openai(await allDownApp());

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '45', 'the caller still needs to know when to retry');
    const error = res.json().error as { type: string; message: string };
    assert.equal(error.type, 'model_unavailable');
    // The whole pool was walked: both candidates must be named, not just the
    // first one that happened to fail.
    assert.match(error.message, /fx:fast/);
    assert.match(error.message, /fy:slow/);
    assert.match(error.message, /rate-limited/);
  });

  it('OpenAI stream: model_unavailable with retry_after in the error event', async () => {
    const res = await openai(await allDownApp(), true);

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/event-stream/);
    const frame = ssePayloads(res.body).find((p) => p.error) as
      | { error: { type: string; message: string; retry_after?: number } }
      | undefined;
    assert.ok(frame, `expected a streaming error event, got ${res.body}`);
    assert.equal(frame.error.type, 'model_unavailable');
    assert.equal(frame.error.retry_after, 45);
    assert.match(frame.error.message, /fy:slow/);
  });

  it('Anthropic chat: 503 model_unavailable with the hint', async () => {
    const res = await anthropic(await allDownApp());

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '45');
    const error = res.json().error as { type: string; message: string };
    assert.equal(error.type, 'model_unavailable');
    assert.match(error.message, /fy:slow/, 'every candidate must be accounted for');
  });

  it('Anthropic stream: model_unavailable with retry_after', async () => {
    const res = await anthropic(await allDownApp(), true);

    assert.equal(res.statusCode, 200);
    const frame = ssePayloads(res.body).find((p) => p.error) as
      | { error: { type: string; retry_after?: number } }
      | undefined;
    assert.ok(frame, `expected a streaming error event, got ${res.body}`);
    assert.equal(frame.error.type, 'model_unavailable');
    assert.equal(frame.error.retry_after, 45);
  });

  it('Gemini generateContent: 503 MODEL_UNAVAILABLE with the hint', async () => {
    const res = await gemini(await allDownApp());

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '45');
    const error = res.json().error as { status: string; message: string };
    assert.equal(error.status, 'MODEL_UNAVAILABLE');
    assert.match(error.message, /fy:slow/);
  });

  it('Gemini streamGenerateContent: model_unavailable with retry_after', async () => {
    const res = await (await allDownApp()).inject({
      method: 'POST',
      url: '/v1beta/models/auto:streamGenerateContent',
      payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });

    assert.equal(res.statusCode, 200);
    const frame = ssePayloads(res.body).find((p) => p.error) as
      | { error: { type: string; retry_after?: number } }
      | undefined;
    assert.ok(frame, `expected a streaming error event, got ${res.body}`);
    assert.equal(frame.error.type, 'model_unavailable');
    assert.equal(frame.error.retry_after, 45);
  });
});

describe('an explicit model keeps its own error semantics', () => {
  it('a rate-limited explicit model is not reported as pool exhaustion', async () => {
    const res = await (await allDownApp()).inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'custom:fx:fast', messages: MESSAGES },
    });

    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '45');
    const error = res.json().error as { type: string };
    assert.equal(error.type, 'upstream_error');
  });
});
