import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CredentialRuntime } from '../../credentials/runtime.js';
import type { BaseProvider } from '../../providers/base.js';
import { ProviderRegistry, resetAutoPoolCursor } from '../../registry.js';
import { composeModelId, bareModelId } from '../../model-id.js';
import { parseRateLimitError } from '../../router/auto-router.js';
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

  it('exempts custom source ids named "custom" from model-id compose/bare', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        custom: {
          enabled: true,
          credentials: {
            apiKey: '',
            extra: {
              sources: [
                {
                  id: 'custom',
                  baseUrl: 'https://a.example/v1',
                  models: [{ id: 'llama3' }],
                },
                {
                  id: 'cpa',
                  baseUrl: 'https://b.example/v1',
                  models: [{ id: 'Qwen3.8-27B' }],
                },
              ],
            },
          },
        },
      }),
    );

    assert.equal(composeModelId('custom', 'custom:llama3'), 'custom:custom:llama3');
    assert.equal(bareModelId('custom', 'custom:llama3'), 'custom:llama3');
    assert.equal(composeModelId('custom', 'cpa:Qwen3.8-27B'), 'custom:cpa:Qwen3.8-27B');
    assert.equal(bareModelId('custom', 'cpa:Qwen3.8-27B'), 'cpa:Qwen3.8-27B');
    assert.equal(composeModelId('cline', 'cline:z-ai/glm-5.3-flash'), 'cline:z-ai/glm-5.3-flash');
    assert.equal(bareModelId('cline', 'cline:z-ai/glm-5.3-flash'), 'z-ai/glm-5.3-flash');

    const resolved = registry.resolveModel('custom:custom:llama3');
    assert.equal(resolved.provider.id, 'custom');
    assert.equal(resolved.modelId, 'custom:llama3');

    const other = registry.resolveModel('custom:cpa:Qwen3.8-27B');
    assert.equal(other.provider.id, 'custom');
    assert.equal(other.modelId, 'cpa:Qwen3.8-27B');
  });

  it('routes bare ERNIE ids to the qianfan provider', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        qianfan: { enabled: true, credentials: { apiKey: 'k' } },
      }),
    );

    const resolved = registry.resolveModel('ernie-speed-8k');
    assert.equal(resolved.provider.id, 'qianfan');
    assert.equal(resolved.modelId, 'ernie-speed-8k');
  });

  it('routes bare mixed-case ERNIE ids to the qianfan provider', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        qianfan: { enabled: true, credentials: { apiKey: 'k' } },
      }),
    );

    const resolved = registry.resolveModel('ERNIE-Speed-8k');
    assert.equal(resolved.provider.id, 'qianfan');
    assert.equal(resolved.modelId, 'ERNIE-Speed-8k');
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

describe('ProviderRegistry queue-full retry', () => {
  function registryWith(
    generateImage: () => Promise<unknown>,
    generateVideo?: () => Promise<unknown>,
  ) {
    const config = configWithProviders({
      agnes: { enabled: true, credentials: { apiKey: 'k' } },
    });
    const registry = new ProviderRegistry(
      config,
      async () => ({
        version: 1,
        updatedAt: 0,
        models: [],
        added: [],
        removed: [],
      }),
      { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    );
    const fakeProvider = {
      id: 'agnes' as const,
      displayName: 'Fake',
      listModels: async () => [
        {
          id: 'img-1',
          provider: 'agnes',
          displayName: 'Img',
          free: true,
          modalities: { input: ['text'], output: ['image'] },
        },
        {
          id: 'vid-1',
          provider: 'agnes',
          displayName: 'Vid',
          free: true,
          modalities: { input: ['text'], output: ['video'] },
        },
      ],
      generateImage,
      generateVideo,
    } as unknown as BaseProvider;
    const internals = registry as unknown as {
      instances: Map<ProviderId, BaseProvider>;
    };
    internals.instances.set('agnes', fakeProvider);
    return registry;
  }

  it('retries generateImage on 503 queue-full then succeeds', async () => {
    let calls = 0;
    const registry = registryWith(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('agnes image generation failed 503: 文生图队列已满');
      }
      return { created: 1, data: [{ url: 'ok' }] };
    });
    const result = await registry.generateImage({
      model: 'agnes:img-1',
      prompt: 'cat',
      size: '1024x1024',
      n: 1,
      response_format: 'url',
    });
    assert.equal(calls, 3);
    assert.equal(result.response.data[0]?.url, 'ok');
  });

  it('retries generateVideo on 503 queue-full then succeeds', async () => {
    let calls = 0;
    const registry = registryWith(
      async () => {
        throw new Error('unused');
      },
      async () => {
        calls += 1;
        if (calls < 2) {
          throw new Error('agnes video creation failed 503: video_queue_full');
        }
        return { video_id: 'v1', status: 'queued' as const };
      },
    );
    const result = await registry.generateVideo({
      model: 'agnes:vid-1',
      prompt: 'a cat',
      width: 1152,
      height: 768,
      num_frames: 121,
      frame_rate: 24,
    });
    assert.equal(calls, 2);
    assert.equal(result.response.video_id, 'v1');
  });

  it('does not retry non-queue errors in generateImage', async () => {
    let calls = 0;
    const registry = registryWith(async () => {
      calls += 1;
      throw new Error('agnes image generation failed 400: prompt too long');
    });
    await assert.rejects(
      () =>
        registry.generateImage({
          model: 'agnes:img-1',
          prompt: 'cat',
          size: '1024x1024',
          n: 1,
          response_format: 'url',
        }),
      /400/,
    );
    assert.equal(calls, 1);
  });
});

interface StubRuntimeResult {
  runtime: CredentialRuntime;
  getCalls: () => number;
}

function stubRuntime(active: boolean): StubRuntimeResult {
  let getCalls = 0;
  const runtime: CredentialRuntime = {
    async getPool() {
      getCalls += 1;
      return {
        accounts: active
          ? [
              {
                id: 'acc-1',
                label: 'a@example.com',
                status: 'active' as const,
                addedAt: 1,
                payload: {},
              },
            ]
          : [],
      };
    },
    async upsertAccount() {},
    async removeAccount() {},
    async saveSettings() {},
    hasActiveAccounts: () => active,
    nextAccount: () => null,
    reportRateLimit() {},
    reportInvalid() {},
    reportSuccess() {},
    clearAccountCooldowns: () => 0,
    listAccountCooldowns: () => [],
    recordUsage() {},
    snapshotUsage: () => [],
  };
  return { runtime, getCalls: () => getCalls };
}

function clineConfig(enabled: boolean): AppConfig {
  return configWithProviders({
    cline: { enabled, credentials: { apiKey: '' } },
  });
}

describe('ProviderRegistry cline credential seams', () => {
  it('gates getProvider on hasCredentials when the hook exists', () => {
    const withAccounts = stubRuntime(true);
    const registry = new ProviderRegistry(
      clineConfig(true),
      undefined,
      undefined,
      withAccounts.runtime,
    );
    const provider = registry.getProvider('cline');
    assert.equal(provider.id, 'cline');
    assert.equal(provider.hasCredentials?.(), true);
    assert.equal(registry.getProvider('cline'), provider);

    const empty = new ProviderRegistry(
      clineConfig(true),
      undefined,
      undefined,
      stubRuntime(false).runtime,
    );
    assert.throws(() => empty.getProvider('cline'), /has no available credentials/);

    const disabled = new ProviderRegistry(
      clineConfig(false),
      undefined,
      undefined,
      stubRuntime(true).runtime,
    );
    assert.throws(() => disabled.getProvider('cline'), /not enabled/);
  });

  it('lists cline only when enabled and the pool has active accounts', () => {
    const enabled = new ProviderRegistry(
      clineConfig(true),
      undefined,
      undefined,
      stubRuntime(true).runtime,
    );
    assert.deepEqual(enabled.listEnabledProviders(), ['cline']);

    const noAccounts = new ProviderRegistry(
      clineConfig(true),
      undefined,
      undefined,
      stubRuntime(false).runtime,
    );
    assert.deepEqual(noAccounts.listEnabledProviders(), []);

    const disabled = new ProviderRegistry(
      clineConfig(false),
      undefined,
      undefined,
      stubRuntime(true).runtime,
    );
    assert.deepEqual(disabled.listEnabledProviders(), []);
  });

  it('routes cline-prefixed and colon-qualified ids verbatim', () => {
    const registry = new ProviderRegistry(
      clineConfig(true),
      undefined,
      undefined,
      stubRuntime(true).runtime,
    );
    const free = registry.resolveModel('cline-free/deepseek-v4.1-flash');
    assert.equal(free.provider.id, 'cline');
    assert.equal(free.modelId, 'cline-free/deepseek-v4.1-flash');

    const slash = registry.resolveModel('cline/some-model');
    assert.equal(slash.provider.id, 'cline');
    assert.equal(slash.modelId, 'cline/some-model');

    const colon = registry.resolveModel('cline:deepseek-v4-flash');
    assert.equal(colon.provider.id, 'cline');
    assert.equal(colon.modelId, 'deepseek-v4-flash');
  });

  it('falls back when cline is not configured', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        cline: { enabled: false, credentials: { apiKey: '' } },
        openrouter: { enabled: true, credentials: { apiKey: 'k' } },
      }),
    );
    const resolved = registry.resolveModel('cline-free/deepseek-v4.1-flash');
    assert.equal(resolved.provider.id, 'openrouter');
    assert.equal(resolved.modelId, 'cline-free/deepseek-v4.1-flash');
    assert.throws(() => registry.resolveModel('cline:deepseek-v4-flash'), /not enabled/);
  });

  it('warms the credential pool before aggregating models', async () => {
    const stub = stubRuntime(true);
    const registry = new ProviderRegistry(clineConfig(true), undefined, undefined, stub.runtime);
    const result = await registry.listAllModels(true);
    assert.ok(stub.getCalls() > 0, 'listAllModels must warm cline credentials first');
    assert.deepEqual(result.succeededProviders, ['cline']);
    assert.deepEqual(
      result.models.filter((model) => model.provider === 'cline').map((model) => model.id),
      [
        'cline:cline-free/deepseek-v4.1-flash',
        'cline:deepseek/deepseek-v4-flash',
        'cline:z-ai/glm-5.3-flash',
        'cline:poolside/laguna-s-2.1:free',
      ],
    );
  });

  it('routes canonical cline ids without a double prefix', () => {
    const registry = new ProviderRegistry(
      clineConfig(true),
      undefined,
      undefined,
      stubRuntime(true).runtime,
    );

    const canonical = registry.resolveModel('cline:cline-free/deepseek-v4.1-flash');
    assert.equal(canonical.provider.id, 'cline');
    assert.equal(canonical.modelId, 'cline-free/deepseek-v4.1-flash');

    const doubled = registry.resolveModel('cline:cline:z-ai/glm-5.3-flash');
    assert.equal(doubled.provider.id, 'cline');
    assert.equal(doubled.modelId, 'z-ai/glm-5.3-flash');

    assert.equal(composeModelId('cline', 'cline:z-ai/glm-5.3-flash'), 'cline:z-ai/glm-5.3-flash');
    assert.equal(composeModelId('cline', 'z-ai/glm-5.3-flash'), 'cline:z-ai/glm-5.3-flash');
    assert.equal(bareModelId('cline', 'cline:z-ai/glm-5.3-flash'), 'z-ai/glm-5.3-flash');
    assert.equal(
      bareModelId('cline', 'cline-free/deepseek-v4.1-flash'),
      'cline-free/deepseek-v4.1-flash',
    );
    assert.equal(bareModelId('custom', 'cpa:Qwen3.8-27B'), 'cpa:Qwen3.8-27B');
  });

  it('keeps bare deepseek ids on the sensenova heuristic and never on cline', () => {
    const registry = new ProviderRegistry(
      configWithProviders({
        cline: { enabled: true, credentials: { apiKey: '' } },
        sensenova: { enabled: true, credentials: { apiKey: 'k' } },
      }),
      undefined,
      undefined,
      stubRuntime(true).runtime,
    );
    const resolved = registry.resolveModel('deepseek/deepseek-v4-flash');
    assert.equal(resolved.provider.id, 'sensenova');
    assert.equal(resolved.modelId, 'deepseek/deepseek-v4-flash');

    const clineOnly = new ProviderRegistry(
      clineConfig(true),
      undefined,
      undefined,
      stubRuntime(true).runtime,
    );
    assert.throws(() => clineOnly.resolveModel('deepseek/deepseek-v4-flash'), /not enabled/);
  });
});

function switchRuntime(ids: string[]): {
  runtime: CredentialRuntime;
  rateLimits: Array<{ accountId: string; resetAt?: number }>;
} {
  let cursor = 0;
  const rateLimits: Array<{ accountId: string; resetAt?: number }> = [];
  const accounts = ids.map((id) => ({
    id,
    label: `${id}@example.com`,
    status: 'active' as const,
    addedAt: 1,
    payload: {
      accessToken: `at-${id}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  }));
  const runtime: CredentialRuntime = {
    async getPool() {
      return { accounts: accounts.map((account) => ({ ...account })) };
    },
    async upsertAccount() {},
    async removeAccount() {},
    async saveSettings() {},
    hasActiveAccounts: () => accounts.length > 0,
    nextAccount: () => {
      const account = accounts[cursor % accounts.length];
      cursor += 1;
      return account ?? null;
    },
    reportRateLimit(_platform, accountId, _model, resetAt) {
      rateLimits.push({ accountId, resetAt });
    },
    reportInvalid() {},
    reportSuccess() {},
    clearAccountCooldowns: () => 0,
    listAccountCooldowns: () => [],
    recordUsage() {},
    snapshotUsage: () => [],
  };
  return { runtime, rateLimits };
}

function clineAutoConfig(autoRoute: AppConfig['autoRoute']): AppConfig {
  return {
    ...configWithProviders({ cline: { enabled: true, credentials: { apiKey: '' } } }),
    autoRoute,
  };
}

describe('ProviderRegistry cline auto/failover two states', () => {
  const MODEL = 'z-ai/glm-5.3-flash';

  function headerOf(init: RequestInit | undefined, name: string): string | undefined {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) return value;
    }
    return undefined;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  async function chatWithSwitch(enabled: boolean): Promise<void> {
    const state = switchRuntime(['acc-a1', 'acc-a2']);
    const registry = new ProviderRegistry(
      clineAutoConfig({ enabled, strategy: 'rate-limit' }),
      undefined,
      undefined,
      state.runtime,
    );
    const sentModels: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      sentModels.push(String(body.model ?? ''));
      if (headerOf(init, 'authorization') === 'Bearer workos:at-acc-a1') {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
      }
      return jsonResponse({
        id: 'chat-1',
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok from a2' },
            finish_reason: 'stop',
          },
        ],
      });
    }) as typeof fetch;
    try {
      const resolved = registry.resolveModel(`cline:${MODEL}`);
      assert.equal(resolved.provider.id, 'cline');
      assert.equal(resolved.modelId, MODEL);
      const response = await resolved.provider.chat({
        model: resolved.modelId,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      assert.equal(response.content, 'ok from a2');
      assert.deepEqual(sentModels, [MODEL, MODEL], 'upstream must receive the native model id');
      assert.equal(state.rateLimits[0]?.accountId, 'acc-a1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function exhaustAndProbe(enabled: boolean): Promise<void> {
    const state = switchRuntime(['acc-b1']);
    const registry = new ProviderRegistry(
      clineAutoConfig({ enabled, strategy: 'rate-limit' }),
      undefined,
      undefined,
      state.runtime,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '60' },
      })) as typeof fetch;
    try {
      const resolved = registry.resolveModel(`cline:${MODEL}`);
      const started = Date.now();
      let caught: unknown;
      await assert.rejects(
        resolved.provider.chat({
          model: resolved.modelId,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
        (error: unknown) => {
          caught = error;
          return true;
        },
      );

      const parsed = parseRateLimitError(caught);
      assert.equal(parsed.isRateLimit, true, 'the bubbled message must stay parseable');
      assert.ok(
        parsed.resetAt !== undefined &&
          parsed.resetAt >= started + 55_000 &&
          parsed.resetAt <= Date.now() + 65_000,
        `parsed resetAt ${parsed.resetAt} must fall near retry-after 60s`,
      );

      const router = registry.getAutoRouter();
      router.markRateLimited(MODEL, 'cline', parsed);
      if (enabled) {
        assert.ok(router.isRateLimited(MODEL), 'enabled router must keep the mark');
        const next = await router.pickFallback(MODEL);
        assert.ok(next, 'enabled router must offer a cross-model fallback');
        assert.notEqual(next.id, MODEL);
        assert.equal(next.provider, 'cline');
        const pre = await router.preflight(`cline:${MODEL}`);
        if (!pre.switched) assert.fail('enabled preflight must switch away from the marked model');
        assert.notEqual(pre.model.id, MODEL);
      } else {
        assert.equal(await router.pickFallback(MODEL), null, 'disabled router must not fail over');
        const pre = await router.preflight(`cline:${MODEL}`);
        assert.equal(pre.switched, false);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('switches accounts inside the pool with autoRoute enabled', async () => {
    await chatWithSwitch(true);
  });

  it('switches accounts inside the pool with autoRoute disabled', async () => {
    await chatWithSwitch(false);
  });

  it('bubbles a parseable 429 and fails over when autoRoute is enabled', async () => {
    await exhaustAndProbe(true);
  });

  it('bubbles a parseable 429 but never fails over when autoRoute is disabled', async () => {
    await exhaustAndProbe(false);
  });
});
