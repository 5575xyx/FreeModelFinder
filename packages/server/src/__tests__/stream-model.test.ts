import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatResponse,
  type ProviderId,
  type StreamChunk,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

/**
 * `model` in a streaming chunk must identify the model the gateway served, the
 * same value the non-streaming response and `fmf_auto_route.picked` report.
 *
 * Some upstreams are routers in their own right and answer with the underlying
 * model they actually used (`openrouter/free` -> `nvidia/nemotron-…`). Echoing
 * that into `model` made a client believe the request had been routed to a
 * provider it never asked for, while the very same frame's `fmf_auto_route`
 * said otherwise.
 */

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

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
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

/**
 * A provider whose upstream answers with `upstreamModel` instead of the id it
 * was dispatched with — exactly what a pass-through router such as
 * `openrouter/free` does.
 */
async function appForUpstreamModel(upstreamModel: string): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(baseConfig());
  registry.listAllModels = async () => ({
    models: [{ id: 'fx:fast', provider: 'custom' as const, displayName: 'Fast', free: true }],
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  registry.getProvider = ((providerId: ProviderId) => ({
    id: providerId,
    chat: async (): Promise<ChatResponse> => ({
      id: 'gen-1',
      model: upstreamModel,
      created: 0,
      content: 'hello',
      finish_reason: 'stop',
    }),
    stream: async function* (): AsyncIterable<StreamChunk> {
      yield { id: 's1', model: upstreamModel, created: 0, delta: 'hel' };
      yield { id: 's1', model: upstreamModel, created: 0, delta: 'lo', finish_reason: 'stop' };
    },
  })) as never;
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

async function streamChat(app: FastifyInstance, model: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model, messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
}

/** The actual content-bearing SSE frames, skipping `[DONE]` and notice frames. */
function streamFrames(body: string): Array<Record<string, unknown>> {
  return body
    .split(/\r?\n\r?\n/)
    .map((frame) => (frame.startsWith('data: ') ? frame.slice('data: '.length).trim() : ''))
    .filter((json) => json.startsWith('{'))
    .map((json) => JSON.parse(json) as Record<string, unknown>)
    .filter((p) => Array.isArray(p.choices));
}

const COMPOSED = 'custom:fx:fast';

describe('streaming chunks name the model the gateway served', () => {
  it('overrides the upstream-reported model on every frame', async () => {
    const app = await appForUpstreamModel('nvidia/nemotron-3.5-lightning:free');
    const res = await streamChat(app, COMPOSED);

    assert.equal(res.statusCode, 200);
    const frames = streamFrames(res.body);
    assert.equal(frames.length, 2, res.body);
    for (const frame of frames) {
      assert.equal(frame.model, COMPOSED, 'must match the model the client asked for');
    }
  });

  it('keeps the upstream-reported model available as fmf_upstream_model', async () => {
    const app = await appForUpstreamModel('nvidia/nemotron-3.5-lightning:free');
    const res = await streamChat(app, COMPOSED);

    const frames = streamFrames(res.body);
    for (const frame of frames) {
      assert.equal(frame.fmf_upstream_model, 'nvidia/nemotron-3.5-lightning:free');
    }
  });

  it('omits fmf_upstream_model when the upstream already agrees', async () => {
    const app = await appForUpstreamModel(COMPOSED);
    const res = await streamChat(app, COMPOSED);

    const frames = streamFrames(res.body);
    for (const frame of frames) {
      assert.equal(frame.model, COMPOSED);
      assert.equal(frame.fmf_upstream_model, undefined, 'no need to echo what model already says');
    }
  });

  it('matches the model the non-streaming response reports', async () => {
    const app = await appForUpstreamModel('nvidia/nemotron-3.5-lightning:free');
    const [streamed, plain] = await Promise.all([
      streamChat(app, COMPOSED),
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: COMPOSED, messages: [{ role: 'user', content: 'hi' }] },
      }),
    ]);

    const streamedModel = streamFrames(streamed.body)[0]?.model;
    const plainModel = (plain.json() as { model: string }).model;
    assert.equal(streamedModel, plainModel, 'the two paths must agree');
  });
});
