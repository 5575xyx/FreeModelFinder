import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelSnapshot } from '../../config/snapshot.js';
import type { BaseProvider } from '../../providers/base.js';
import { ProviderRegistry } from '../../registry.js';
import type { AppConfig, ModelInfo, ProviderId } from '../../types.js';

function configWith(providers: AppConfig['providers']): AppConfig {
  return { version: 2, port: 11435, providers };
}

function installProvider(
  registry: ProviderRegistry,
  id: ProviderId,
  listModels: () => Promise<ModelInfo[]>,
): void {
  (registry as unknown as { instances: Map<ProviderId, BaseProvider> }).instances.set(id, {
    id,
    displayName: 'Fake',
    listModels,
  } as unknown as BaseProvider);
}

describe('ProviderRegistry listAllModels resilience', () => {
  it('bounds a stalled provider with a timeout and falls back to the snapshot', async () => {
    const snapshot: ModelSnapshot = {
      version: 1,
      updatedAt: 0,
      models: [{ id: 'cached-1', provider: 'openrouter', displayName: 'Cached', free: true }],
      added: [],
      removed: [],
    };
    const registry = new ProviderRegistry(
      configWith({ openrouter: { enabled: true, credentials: { apiKey: 'k' } } }),
      async () => snapshot,
      {},
      undefined,
      25,
    );
    // A provider that accepts the call but never answers — the remote gateway's
    // real failure mode (a blackholed upstream connection).
    installProvider(registry, 'openrouter', () => new Promise<ModelInfo[]>(() => {}));

    const startedAt = Date.now();
    const result = await registry.listAllModels(true);

    assert.ok(
      Date.now() - startedAt < 2_000,
      'refresh must not wait for the stalled provider to settle on its own',
    );
    assert.deepEqual(
      result.failedProviders.map((f) => f.id),
      ['openrouter'],
    );
    assert.match(result.failedProviders[0]!.error, /timed out/);
    // The failed provider's last known models survive via the snapshot.
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['cached-1'],
    );
  });

  it('coalesces concurrent refreshes into a single provider fan-out', async () => {
    const registry = new ProviderRegistry(
      configWith({ openrouter: { enabled: true, credentials: { apiKey: 'k' } } }),
    );
    let calls = 0;
    installProvider(registry, 'openrouter', async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ id: 'm1', provider: 'openrouter', displayName: 'M1', free: true }];
    });

    const results = await Promise.all([
      registry.listAllModels(true),
      registry.listAllModels(true),
      registry.listAllModels(true),
    ]);

    assert.equal(calls, 1, 'concurrent callers must share one refresh, not hammer every provider');
    for (const result of results) {
      assert.deepEqual(
        result.models.map((m) => m.id),
        ['m1'],
      );
    }
  });

  it('serves a stale catalog immediately and refreshes it in the background', async () => {
    const registry = new ProviderRegistry(
      configWith({ openrouter: { enabled: true, credentials: { apiKey: 'k' } } }),
    );
    const internals = registry as unknown as { modelsCache: unknown; cacheAt: number };
    internals.modelsCache = {
      models: [{ id: 'stale', provider: 'openrouter', displayName: 'Stale', free: true }],
      succeededProviders: ['openrouter'],
      failedProviders: [],
    };
    internals.cacheAt = 0; // older than the TTL

    let refreshStarted = false;
    let releaseRefresh!: (models: ModelInfo[]) => void;
    const gate = new Promise<ModelInfo[]>((resolve) => {
      releaseRefresh = resolve;
    });
    installProvider(registry, 'openrouter', () => {
      refreshStarted = true;
      return gate;
    });

    const result = await registry.listAllModels();
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['stale'],
      'a stale catalog is handed back right away instead of blocking on the refresh',
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshStarted, true, 'the background refresh is kicked off');

    const pending = registry.listAllModels(true); // joins the in-flight refresh
    releaseRefresh([{ id: 'fresh', provider: 'openrouter', displayName: 'Fresh', free: true }]);
    const refreshed = await pending;
    assert.deepEqual(
      refreshed.models.map((m) => m.id),
      ['fresh'],
    );
  });

  it('awaits a stale refresh when the caller asks to revalidate', async () => {
    const registry = new ProviderRegistry(
      configWith({ openrouter: { enabled: true, credentials: { apiKey: 'k' } } }),
    );
    const internals = registry as unknown as { modelsCache: unknown; cacheAt: number };
    internals.modelsCache = {
      models: [{ id: 'stale', provider: 'openrouter', displayName: 'Stale', free: true }],
      succeededProviders: ['openrouter'],
      failedProviders: [],
    };
    internals.cacheAt = 0; // stale
    installProvider(registry, 'openrouter', async () => [
      { id: 'fresh', provider: 'openrouter', displayName: 'Fresh', free: true },
    ]);

    const result = await registry.listAllModels(false, { revalidate: true });
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['fresh'],
      'a revalidate caller must not be handed the older catalog',
    );
  });

  it('reuses a fresh cache without touching providers and lets force bypass it', async () => {
    const registry = new ProviderRegistry(
      configWith({ openrouter: { enabled: true, credentials: { apiKey: 'k' } } }),
    );
    let calls = 0;
    installProvider(registry, 'openrouter', async () => {
      calls += 1;
      return [{ id: `m${calls}`, provider: 'openrouter', displayName: 'M', free: true }];
    });

    const first = await registry.listAllModels(true);
    assert.equal(calls, 1);

    const cached = await registry.listAllModels();
    assert.equal(calls, 1, 'a fresh cache must not trigger another provider fan-out');
    assert.deepEqual(
      cached.models.map((m) => m.id),
      first.models.map((m) => m.id),
    );

    const forced = await registry.listAllModels(true);
    assert.equal(calls, 2);
    assert.deepEqual(
      forced.models.map((m) => m.id),
      ['m2'],
    );
  });
});
