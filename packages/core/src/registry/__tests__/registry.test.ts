import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BaseProvider } from '../../providers/base.js';
import { ProviderRegistry, resetAutoPoolCursor } from '../../registry.js';
import type { AppConfig, ModelInfo, ProviderId } from '../../types.js';

function configWithProviders(providers: AppConfig['providers']): AppConfig {
  return {
    version: 1,
    port: 11435,
    providers,
  };
}

describe('ProviderRegistry model catalog', () => {
  it('ignores unknown provider keys left by older config files', () => {
    const providers = {
      openrouter: { enabled: false },
      legacy_provider: {
        enabled: true,
        credentials: { apiKey: 'legacy-key' },
      },
    } as unknown as AppConfig['providers'];
    const registry = new ProviderRegistry(configWithProviders(providers));

    assert.deepEqual(registry.listEnabledProviders(), []);
  });

  it('resolves two-segment custom source ids to the custom provider', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        custom: {
          enabled: true,
          credentials: {
            apiKey: '',
            extra: {
              sources: [
                {
                  id: 'cpa',
                  label: 'cpa',
                  baseUrl: 'https://cpa.example/v1',
                  models: [{ id: 'Qwen3.8-27B' }],
                },
              ],
            },
          },
        },
      }),
    );

    const resolved = registry.resolveModel('cpa:Qwen3.8-27B');
    assert.equal(resolved.provider.id, 'custom');
    assert.equal(resolved.modelId, 'cpa:Qwen3.8-27B');
  });

  it('keeps three-segment custom ids working', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        custom: {
          enabled: true,
          credentials: {
            apiKey: '',
            extra: {
              sources: [
                {
                  id: 'cpa',
                  label: 'cpa',
                  baseUrl: 'https://cpa.example/v1',
                  models: [{ id: 'Qwen3.8-27B' }],
                },
              ],
            },
          },
        },
      }),
    );

    const resolved = registry.resolveModel('custom:cpa:Qwen3.8-27B');
    assert.equal(resolved.provider.id, 'custom');
    assert.equal(resolved.modelId, 'cpa:Qwen3.8-27B');
  });

  it('does not hijack real built-in provider prefixes for unknown custom sources', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        openrouter: { enabled: true, credentials: { apiKey: 'k' } },
        custom: {
          enabled: true,
          credentials: {
            apiKey: '',
            extra: {
              sources: [{ id: 'cpa', baseUrl: 'https://cpa.example/v1', models: [] }],
            },
          },
        },
      }),
    );

    // 'cpa:...' must not be treated as an openrouter model
    const resolved = registry.resolveModel('cpa:Qwen3.8-27B');
    assert.equal(resolved.provider.id, 'custom');
  });

  it('still falls back to openrouter for unknown non-source segments', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        openrouter: { enabled: true, credentials: { apiKey: 'k' } },
        custom: {
          enabled: true,
          credentials: {
            apiKey: '',
            extra: {
              sources: [{ id: 'cpa', baseUrl: 'https://cpa.example/v1', models: [] }],
            },
          },
        },
      }),
    );

    // 'xyz:foo' where xyz is neither a known provider nor a custom source id
    const resolved = registry.resolveModel('xyz:foo-model');
    assert.equal(resolved.provider.id, 'openrouter');
  });

  it('filters paid entries and deduplicates provider/model ids', async () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        openrouter: {
          enabled: true,
          credentials: { apiKey: 'test-key' },
        },
      }),
    );
    const entries: ModelInfo[] = [
      {
        id: 'vendor/free:free',
        provider: 'openrouter',
        displayName: 'First',
        free: true,
      },
      {
        id: 'VENDOR/FREE:FREE',
        provider: 'openrouter',
        displayName: 'Duplicate',
        free: true,
      },
      {
        id: 'vendor/paid',
        provider: 'openrouter',
        displayName: 'Paid',
        free: false,
      },
    ];
    const fakeProvider = {
      id: 'openrouter' as ProviderId,
      displayName: 'Fake OpenRouter',
      listModels: async () => entries,
    } as unknown as BaseProvider;
    const internals = registry as unknown as {
      instances: Map<ProviderId, BaseProvider>;
    };
    internals.instances.set('openrouter', fakeProvider);

    const result = await registry.listAllModels(true);

    assert.equal(result.models.length, 1);
    assert.equal(result.models[0]?.displayName, 'Duplicate');
    assert.deepEqual(result.succeededProviders, ['openrouter']);
    assert.deepEqual(result.failedProviders, []);
  });

  it('resolves bare custom source ids even when openrouter is enabled', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        openrouter: { enabled: true, credentials: { apiKey: 'k' } },
        custom: {
          enabled: true,
          credentials: {
            apiKey: '',
            extra: {
              sources: [{ id: 'cpa', baseUrl: 'https://cpa.example/v1', models: [] }],
            },
          },
        },
      }),
    );

    const resolved = registry.resolveModel('cpa:Qwen3.8-27B');
    assert.equal(resolved.provider.id, 'custom');
    assert.equal(resolved.modelId, 'cpa:Qwen3.8-27B');
  });

  it('keeps the last successful models when a provider refresh fails', async () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        gemini: {
          enabled: true,
          credentials: { apiKey: 'test-key' },
        },
      }),
      async () => ({
        version: 1,
        updatedAt: Date.now(),
        models: [
          {
            id: 'gemini-cached',
            provider: 'gemini',
            displayName: 'Cached Gemini',
            free: true,
          },
          {
            id: 'unrelated-cached',
            provider: 'openrouter',
            displayName: 'Unrelated cached model',
            free: true,
          },
        ],
        added: [],
        removed: [],
      }),
    );
    const failingProvider = {
      id: 'gemini' as ProviderId,
      displayName: 'Fake Gemini',
      listModels: async () => {
        throw new Error('temporarily offline');
      },
    } as unknown as BaseProvider;
    const internals = registry as unknown as {
      instances: Map<ProviderId, BaseProvider>;
    };
    internals.instances.set('gemini', failingProvider);

    const result = await registry.listAllModels(true);

    assert.deepEqual(
      result.models.map((model) => `${model.provider}:${model.id}`),
      ['gemini:gemini-cached'],
    );
    assert.deepEqual(result.succeededProviders, []);
    assert.deepEqual(result.failedProviders, [{ id: 'gemini', error: 'temporarily offline' }]);
  });
});

describe('ProviderRegistry auto scored pool', () => {
  function poolConfig(autoRoute?: AppConfig['autoRoute']): AppConfig {
    return {
      version: 1,
      port: 11435,
      providers: { openrouter: { enabled: true, credentials: { apiKey: 'k' } } },
      autoRoute,
    };
  }

  function catalogRegistry(models: ModelInfo[], autoRoute?: AppConfig['autoRoute']) {
    const registry = new ProviderRegistry(poolConfig(autoRoute), async () => ({
      version: 1,
      updatedAt: 0,
      models: [],
      added: [],
      removed: [],
    }));
    const fakeProvider = {
      id: 'openrouter' as const,
      displayName: 'Fake',
      listModels: async () => models,
    } as unknown as BaseProvider;
    const internals = registry as unknown as {
      instances: Map<ProviderId, BaseProvider>;
    };
    internals.instances.set('openrouter', fakeProvider);
    return registry;
  }

  // Pre-prime the in-memory modelsCache without triggering a provider call.
  // Used by tests that mutate provider state (updateConfig) after registry construction.
  function prime(registry: ProviderRegistry, models: ModelInfo[]) {
    (registry as unknown as { modelsCache: unknown }).modelsCache = {
      models,
      succeededProviders: ['openrouter'],
      failedProviders: [],
    };
    (registry as unknown as { cacheAt: number }).cacheAt = Date.now();
  }

  const bigModel: ModelInfo = {
    id: 'big-70b',
    provider: 'openrouter',
    displayName: 'Big',
    free: true,
  };
  const smallModel: ModelInfo = {
    id: 'tiny-3b',
    provider: 'openrouter',
    displayName: 'Small',
    free: true,
  };
  const midModel: ModelInfo = {
    id: 'mid-14b',
    provider: 'openrouter',
    displayName: 'Mid',
    free: true,
  };

  async function fill(registry: ProviderRegistry) {
    await registry.listAllModels(true);
  }

  it('round-robins across the scored pool for auto', async () => {
    resetAutoPoolCursor();
    const registry = catalogRegistry([smallModel, bigModel, midModel]);
    await fill(registry);
    const picks = new Set<string>();
    for (let i = 0; i < 3; i++) picks.add(registry.resolveModel('auto').modelId);
    assert.deepEqual([...picks].sort(), ['big-70b', 'mid-14b', 'tiny-3b'].sort());
  });

  it('skips cooling-down members and shrinks the pool', async () => {
    resetAutoPoolCursor();
    const registry = catalogRegistry([smallModel, bigModel, midModel]);
    await fill(registry);
    const router = registry.getAutoRouter();
    router.markRateLimited('big-70b', 'openrouter', {
      isRateLimit: true,
      resetAt: Date.now() + 60_000,
      message: 'rpm',
    });
    // openrouter is shared-quota: clear the provider-scope cooldown so
    // sibling models stay eligible (mirrors real provider isolation).
    router.clearProviderCooldown('openrouter');
    const a = registry.resolveModel('auto').modelId;
    const b = registry.resolveModel('auto').modelId;
    assert.notEqual(a, b);
    assert.ok(a === 'mid-14b' || a === 'tiny-3b');
    assert.ok(b === 'mid-14b' || b === 'tiny-3b');
  });

  it('falls back to the first catalog model when the whole pool is cooling', async () => {
    resetAutoPoolCursor();
    const registry = catalogRegistry([smallModel, bigModel, midModel]);
    await fill(registry);
    const router = registry.getAutoRouter();
    for (const m of [bigModel, midModel, smallModel]) {
      router.markRateLimited(m.id, 'openrouter', {
        isRateLimit: true,
        resetAt: Date.now() + 60_000,
        message: 'rpm',
      });
    }
    assert.equal(registry.resolveModel('auto').modelId, smallModel.id);
  });

  it('recomputes the pool when strategy changes', async () => {
    resetAutoPoolCursor();
    const registry = catalogRegistry([smallModel, bigModel, midModel], {
      enabled: false,
      strategy: 'speed',
    });
    await fill(registry);
    const pick = registry.resolveModel('auto').modelId;
    assert.equal(pick, 'tiny-3b');
  });

  it('wraps the pool cursor around after the pool size', async () => {
    resetAutoPoolCursor();
    const registry = catalogRegistry([smallModel, bigModel, midModel]);
    await fill(registry);
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) picks.push(registry.resolveModel('auto').modelId);
    assert.equal(picks[3], picks[0]);
    assert.equal(picks[4], picks[1]);
    assert.equal(picks[5], picks[2]);
  });

  it('default resolves defaultModel first (regression)', async () => {
    resetAutoPoolCursor();
    const registry = catalogRegistry([smallModel, bigModel]);
    registry.updateConfig({ ...registry.getConfig(), defaultModel: 'openrouter:big-70b' });
    // updateConfig clears modelsCache; re-prime without touching providers
    prime(registry, [smallModel, bigModel]);
    assert.equal(registry.resolveModel('default').modelId, 'big-70b');
    resetAutoPoolCursor();
    // auto is independent of defaultModel — capability top is big-70b
    assert.equal(registry.resolveModel('auto').modelId, 'big-70b');
  });

  it('auto throws when no provider catalog is available', () => {
    const registry = catalogRegistry([], undefined);
    assert.throws(() => registry.resolveModel('auto'), /no model available/);
  });
});
