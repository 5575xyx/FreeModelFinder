import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BaseProvider } from '../../providers/base.js';
import { ProviderRegistry } from '../../registry.js';
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
