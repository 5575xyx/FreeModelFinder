import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig, type ChatResponse } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const CHAT_REPLY: ChatResponse = {
  id: 'alias-reply',
  model: 'plain',
  created: 1_700_000_000,
  content: 'ok',
  finish_reason: 'stop',
};

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
                models: [
                  { id: 'plain', displayName: 'Plain' },
                  { id: 'fast', displayName: 'Fast' },
                ],
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

async function appWith(config: AppConfig): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(config);
  registry.listAllModels = async () => ({
    models: [
      { id: 'custom:fx:plain', provider: 'custom', displayName: 'Plain', free: true },
      { id: 'custom:fx:fast', provider: 'custom', displayName: 'Fast', free: true },
    ],
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  registry.resolveModel = (model) => {
    const bare = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
    const id = bare.split(':').pop() ?? bare;
    return {
      provider: {
        id: 'custom',
        chat: async () => ({ ...CHAT_REPLY, model: id }),
        stream: async function* () {
          yield { id: 'alias-stream', model: id, created: 1, delta: 'ok', finish_reason: 'stop' };
        },
      } as never,
      modelId: id,
    };
  };
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

describe('/v1/models alias replacement', () => {
  it('replaces an aliased model id with the alias and adds alias_of', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };

    const aliased = body.data.find((m) => m.id === 'my-model');
    assert.ok(aliased, 'alias must appear in the list');
    assert.equal(aliased.alias_of, 'custom:fx:fast');
    assert.equal(
      body.data.some((m) => m.id === 'custom:fx:fast'),
      false,
      'the original id must be replaced, not duplicated',
    );
  });

  it('leaves a model without an alias untouched and without alias_of', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    const plain = body.data.find((m) => m.id === 'custom:fx:plain');
    assert.ok(plain);
    assert.equal(plain.alias_of, undefined);
  });

  it('returns real ids unchanged when no alias is configured', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    assert.deepEqual(body.data.map((m) => m.id).sort(), ['custom:fx:fast', 'custom:fx:plain']);
    assert.equal(
      body.data.every((m) => m.alias_of === undefined),
      true,
    );
  });
});
