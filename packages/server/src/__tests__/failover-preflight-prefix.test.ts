import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type ProviderId,
  type StreamChunk,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/**
 * Regression test for the preflight-switch provider loss.
 *
 * `AutoRouter.preflight()` returns the picked substitute as a `ModelInfo`,
 * which carries BOTH `provider` and the provider-native `id`. Providers such
 * as `agnes` use bare ids (`"agnes-3.0-flash"`) that match NO heuristic in
 * `ProviderRegistry.resolveModel`, so a bare id handed to `resolveModel`
 * silently falls through to the "default to openrouter" branch.
 *
 * Handing the gateway `pre.model.id` instead of `composeModelId(pre.model.provider, pre.model.id)`
 * therefore dispatched the request to OpenRouter, which rejects the unknown
 * model — every follow-up request repeated the same wrong hop and failed.
 * The fix must compose the id so it round-trips back to the SAME provider.
 */
async function appWithPreflightSwitch(opts: {
  /** model the caller asks for; it is marked rate-limited before the request */
  primary: ModelInfo;
  /** the substitute preflight will pick */
  fallback: ModelInfo;
  autoRoute?: AppConfig['autoRoute'];
}): Promise<{
  app: FastifyInstance;
  /** provider id + model id actually dispatched to the upstream */
  seen: () => Array<{ provider: ProviderId; model: string }>;
}> {
  const autoRoute = opts.autoRoute ?? {
    enabled: true,
    strategy: 'capability' as const,
  };
  const pool = [opts.primary, opts.fallback];
  const providers: AppConfig['providers'] = {};
  for (const m of pool) {
    if (!providers[m.provider]) {
      providers[m.provider] = { enabled: true, credentials: { apiKey: 'test-key' } };
    }
  }
  const config: AppConfig = {
    version: 2,
    port: 11435,
    providers,
    gateway: { requireAuth: false },
    autoRoute,
  };
  const registry = new ProviderRegistry(config);
  const hits: Array<{ provider: ProviderId; model: string }> = [];
  const stubFor = (id: ProviderId) => ({
    id,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      hits.push({ provider: id, model: request.model });
      return {
        id: 'ok',
        model: request.model,
        created: 1,
        content: 'healthy reply',
        finish_reason: 'stop',
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      };
    },
    async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      hits.push({ provider: id, model: request.model });
      yield {
        id: 's',
        model: request.model,
        created: 1,
        delta: 'healthy reply',
        finish_reason: 'stop' as const,
      };
    },
  });
  const internals = registry as unknown as {
    instances: Map<ProviderId, unknown>;
    modelsCache: unknown;
    cacheAt: number;
  };
  for (const m of pool) internals.instances.set(m.provider, stubFor(m.provider));
  internals.modelsCache = {
    models: pool,
    succeededProviders: pool.map((m) => m.provider),
    failedProviders: [],
  };
  internals.cacheAt = Date.now();
  registry.listAllModels = async () => ({
    models: pool,
    succeededProviders: pool.map((m) => m.provider),
    failedProviders: [],
  });

  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  // Put the requested model in cooldown so preflight switches to the substitute.
  registry.getAutoRouter().markRateLimited(opts.primary.id, opts.primary.provider, {
    isRateLimit: true,
    resetAt: Date.now() + 60_000,
    message: 'rate limited',
  });
  return { app, seen: () => hits };
}

describe("preflight switch keeps the substitute's provider prefix", () => {
  const primary: ModelInfo = {
    id: 'cline-free/mimo-v2.6-flash',
    provider: 'cline',
    displayName: 'mimo',
    free: true,
  };
  const fallback: ModelInfo = {
    id: 'agnes-3.0-flash',
    provider: 'agnes',
    displayName: 'Agnes 3.0 Flash',
    free: true,
  };

  it('dispatches the preflight substitute to ITS OWN provider, not openrouter', async () => {
    const { app, seen } = await appWithPreflightSwitch({ primary, fallback });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'cline:cline-free/mimo-v2.6-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(seen(), [{ provider: 'agnes', model: 'agnes-3.0-flash' }]);
  });

  it('streams the preflight substitute to ITS OWN provider', async () => {
    const { app, seen } = await appWithPreflightSwitch({ primary, fallback });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'cline:cline-free/mimo-v2.6-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /healthy reply/);
    assert.deepEqual(seen(), [{ provider: 'agnes', model: 'agnes-3.0-flash' }]);
  });

  it('announces the switch to the SAME id it actually dispatched', async () => {
    const { app } = await appWithPreflightSwitch({ primary, fallback });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'cline:cline-free/mimo-v2.6-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    });
    const body = res.json() as {
      model: string;
      fmf_route_notices?: Array<{ to: string }>;
    };
    // The switch target the gateway tells the caller must be the composed id,
    // matching what the call log records.
    assert.equal(body.model, 'agnes:agnes-3.0-flash', JSON.stringify(body));
    assert.equal(body.fmf_route_notices?.[0]?.to, 'agnes:agnes-3.0-flash');
  });

  it('anthropic route dispatches the substitute to its own provider', async () => {
    const { app, seen } = await appWithPreflightSwitch({ primary, fallback });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'cline:cline-free/mimo-v2.6-flash',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(seen(), [{ provider: 'agnes', model: 'agnes-3.0-flash' }]);
  });
});
