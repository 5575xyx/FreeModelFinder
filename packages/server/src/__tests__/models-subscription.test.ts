import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig, type ModelInfo } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function baseConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {
      openrouter: { enabled: true, credentials: { apiKey: 'k' } },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

async function appWith(models: ModelInfo[]): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(baseConfig());
  registry.listAllModels = async () => ({
    models,
    succeededProviders: ['openrouter' as const],
    failedProviders: [],
  });
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

// 客户端（桌面端、仪表盘、外部 harness）需要一眼看出哪些模型是订阅额度，
// 才不会把订阅模型当成免费池的一部分去配 auto 路由。
describe('/v1/models subscription marker', () => {
  const models: ModelInfo[] = [
    { id: 'openrouter/some-free-model', provider: 'openrouter', displayName: 'F', free: true },
    {
      id: 'claude:claude-opus-4.8',
      provider: 'claude',
      displayName: 'Opus',
      free: true,
      subscription: true,
    },
  ];

  it('flags a subscription model with subscription: true', async () => {
    const app = await appWith(models);
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200, res.body);

    const data = res.json().data as Array<{ id: string; subscription?: boolean; free?: boolean }>;
    const sub = data.find((m) => m.id === 'claude:claude-opus-4.8');
    assert.ok(sub, 'subscription model must be listed');
    assert.equal(sub.subscription, true);
  });

  it('leaves the subscription field off a free model', async () => {
    const app = await appWith(models);
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200, res.body);

    const data = res.json().data as Array<{ id: string; subscription?: boolean }>;
    const free = data.find((m) => m.id === 'openrouter/some-free-model');
    assert.ok(free, 'free model must be listed');
    assert.equal(free.subscription, undefined);
  });
});
