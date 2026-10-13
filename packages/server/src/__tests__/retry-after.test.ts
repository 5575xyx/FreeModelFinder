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
 * The gateway must hand callers a way to back off: a `Retry-After` header on a
 * non-streaming failure, and `retry_after` inside the SSE error event when the
 * status line is already gone. Without either, a client cannot distinguish
 * "retry in 45s" from "hammer forever", and the gateway's own cooldown
 * information is thrown away at the boundary.
 */

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const CATALOG = [
  { id: 'fx:fast', provider: 'custom' as const, displayName: 'Fast', free: true },
];

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
            ],
          },
        },
      },
    },
    // No bearer key: these tests are about the error surface, not authorization.
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

/**
 * Builds a gateway whose single model answers every request by throwing `fail`.
 *
 * The message mirrors what the real providers throw (`custom chat failed 429:
 * …`) because the router's rate-limit detection reads that TEXT, not a status
 * code — providers build the error from `res.status` and the body only.
 *
 * `autoRouteEnabled` turns the router on so the automatic-pick and pool-walk
 * paths can be exercised instead of a plain explicit dispatch.
 */
async function failingApp(fail: string, autoRouteEnabled = false): Promise<FastifyInstance> {
  const config = baseConfig();
  config.autoRoute = { enabled: autoRouteEnabled, strategy: 'capability' };
  const registry = new ProviderRegistry(config);
  registry.listAllModels = async () => ({
    models: CATALOG,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  const providerWith = (providerId: ProviderId) => {
    const boom = (): never => {
      throw new Error(fail);
    };
    return {
      id: providerId,
      chat: async (): Promise<ChatResponse> => {
        return boom();
      },
      stream: async function* (): AsyncIterable<never> {
        // Nothing is ever yielded: the dispatch rejects before the first chunk.
        yield* [];
        boom();
      },
    };
  };
  registry.getProvider = ((providerId: ProviderId) => providerWith(providerId)) as never;
  if (autoRouteEnabled) {
    // "auto" resolution reads modelsCache, which listAllModels() normally fills.
    (registry as unknown as { modelsCache: unknown; cacheAt: number }).modelsCache = {
      models: CATALOG,
      succeededProviders: ['custom' as const],
      failedProviders: [],
    };
    (registry as unknown as { cacheAt: number }).cacheAt = Date.now();
  }
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

const RATE_LIMIT = 'custom chat failed 429: rate limit exceeded, retry-after: 45';

async function chat(app: FastifyInstance, model: string, body: object = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model, messages: [{ role: 'user', content: 'hi' }], ...body },
  });
}

async function anthropic(app: FastifyInstance, model: string, body: object = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/messages',
    payload: { model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], ...body },
  });
}

async function gemini(
  app: FastifyInstance,
  model: string,
  action: 'generateContent' | 'streamGenerateContent' = 'generateContent',
) {
  return app.inject({
    method: 'POST',
    url: `/v1beta/models/${encodeURIComponent(model)}:${action}`,
    payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
  });
}

/** The `data:` payloads of an SSE body, in order. */
function ssePayloads(body: string): Array<Record<string, unknown>> {
  return body
    .split(/\r?\n\r?\n/)
    // Anthropic prefixes its error frame with an `event:` line.
    .map((frame) => frame.replace(/^event:[^\n]*\n/, ''))
    .map((frame) => (frame.startsWith('data: ') ? frame.slice('data: '.length).trim() : ''))
    .filter((json) => json.startsWith('{'))
    .map((json) => JSON.parse(json) as Record<string, unknown>);
}

describe('OpenAI Retry-After passthrough', () => {
  it('returns 429 with the upstream retry-after on a chat failure', async () => {
    const app = await failingApp(RATE_LIMIT);
    const res = await chat(app, 'custom:fx:fast');

    assert.equal(res.statusCode, 429, JSON.stringify(res.json()));
    assert.equal(res.headers['retry-after'], '45');
    const error = res.json().error as { type: string; upstream?: number };
    assert.equal(error.type, 'upstream_error');
    assert.equal(error.upstream, 429);
  });

  it('falls back to the gateway cooldown when the upstream gives no hint', async () => {
    const app = await failingApp('custom chat failed 429: Too Many Requests');
    const res = await chat(app, 'custom:fx:fast');

    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '60', 'the model is cooling for the default window');
  });

  it('does not invent a retry hint for a non-rate-limit upstream error', async () => {
    const app = await failingApp('custom chat failed 500: internal error');
    const res = await chat(app, 'custom:fx:fast');

    // The upstream status is echoed as-is; the point here is the absence of a hint.
    assert.equal(res.statusCode, 500);
    assert.equal(res.headers['retry-after'], undefined);
  });

  it('clamps the hint into a sane range', async () => {
    const floor = await chat(
      await failingApp('custom chat failed 429: retry-after: 0'),
      'custom:fx:fast',
    );
    assert.equal(floor.statusCode, 429);
    assert.equal(floor.headers['retry-after'], '1');

    const ceiling = await chat(
      await failingApp('custom chat failed 429: retry-after: 999999'),
      'custom:fx:fast',
    );
    assert.equal(ceiling.statusCode, 429);
    assert.equal(ceiling.headers['retry-after'], '3600');
  });

  it('carries retry_after in the streaming error event', async () => {
    const app = await failingApp(RATE_LIMIT);
    const res = await chat(app, 'custom:fx:fast', { stream: true });

    // The status line is already gone once a stream has been opened.
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/event-stream/);
    const frame = ssePayloads(res.body).find((p) => p.error) as
      | { error: { type: string; retry_after?: number } }
      | undefined;
    assert.ok(frame, `expected a streaming error event, got ${res.body}`);
    assert.equal(frame.error.retry_after, 45);
  });
});

describe('Anthropic Retry-After passthrough', () => {
  it('returns 429 with the upstream retry-after on a messages failure', async () => {
    const app = await failingApp(RATE_LIMIT);
    const res = await anthropic(app, 'custom:fx:fast');

    assert.equal(res.statusCode, 429, JSON.stringify(res.json()));
    assert.equal(res.headers['retry-after'], '45');
    assert.equal((res.json().error as { type: string }).type, 'upstream_error');
  });

  it('carries retry_after in the streaming error event', async () => {
    const app = await failingApp(RATE_LIMIT);
    const res = await anthropic(app, 'custom:fx:fast', { stream: true });

    assert.equal(res.statusCode, 200);
    const frame = ssePayloads(res.body).find((p) => p.error) as
      | { error: { type: string; retry_after?: number } }
      | undefined;
    assert.ok(frame, `expected a streaming error event, got ${res.body}`);
    assert.equal(frame.error.retry_after, 45);
  });
});

describe('Gemini Retry-After passthrough', () => {
  it('returns 429 with the upstream retry-after on a generateContent failure', async () => {
    const app = await failingApp(RATE_LIMIT);
    const res = await gemini(app, 'custom:fx:fast');

    assert.equal(res.statusCode, 429, JSON.stringify(res.json()));
    assert.equal(res.headers['retry-after'], '45');
    const error = res.json().error as { code?: number; status?: string };
    assert.equal(error.code, 429);
    assert.equal(error.status, 'RATE_LIMIT_EXCEEDED');
  });

  it('carries retry_after in the streaming error event', async () => {
    const app = await failingApp(RATE_LIMIT);
    const res = await gemini(app, 'custom:fx:fast', 'streamGenerateContent');

    assert.equal(res.statusCode, 200);
    const frame = ssePayloads(res.body).find((p) => p.error) as
      | { error: { type: string; retry_after?: number } }
      | undefined;
    assert.ok(frame, `expected a streaming error event, got ${res.body}`);
    assert.equal(frame.error.retry_after, 45);
  });
});

describe('no fabricated hints', () => {
  it('exhausting the automatic pool returns 503 without a retry-after', async () => {
    // The exhaustion message contains the words "rate-limited", so it must not
    // be misread as a rate limit and answered with a backoff hint.
    const app = await failingApp(RATE_LIMIT, true);
    const res = await chat(app, 'auto');

    assert.equal(res.statusCode, 503, JSON.stringify(res.json()));
    assert.equal((res.json().error as { type: string }).type, 'model_unavailable');
    assert.equal(res.headers['retry-after'], undefined);
  });
});
