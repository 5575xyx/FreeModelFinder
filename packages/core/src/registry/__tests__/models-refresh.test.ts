import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ModelSnapshot } from '../../config/snapshot.js';
import { ModelsDevContextStore, __setModelsDevContextForTests } from '../../models-dev-context.js';
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

// Every test runs against an injected context store: the real singleton would
// reach for `~/.freemodelfinder/models.dev.context.json` and models.dev itself
// (the exact pollution 478b70c had to fix for availability probes).
const contextDirs: string[] = [];
const offlineFetch = (async () => {
  throw new Error('offline');
}) as typeof fetch;

function newContextStore(table?: Record<string, number>): ModelsDevContextStore {
  const dir = mkdtempSync(join(tmpdir(), 'fmf-ctx-'));
  contextDirs.push(dir);
  if (table) {
    writeFileSync(
      join(dir, 'models.dev.context.json'),
      JSON.stringify({ updated_at: Date.now(), table }),
    );
  }
  return new ModelsDevContextStore({ dir, fetchImpl: offlineFetch });
}

beforeEach(() => {
  __setModelsDevContextForTests(newContextStore());
});

afterEach(() => {
  __setModelsDevContextForTests();
  for (const dir of contextDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it('fills contextWindow from the models.dev table', async () => {
    const registry = new ProviderRegistry(
      configWith({ openrouter: { enabled: true, credentials: { apiKey: 'k' } } }),
    );
    installProvider(registry, 'openrouter', async () => [
      {
        id: 'cline-free/deepseek-v4.1-flash',
        provider: 'openrouter',
        displayName: 'DeepSeek Flash',
        free: true,
      },
    ]);
    __setModelsDevContextForTests(newContextStore({ 'deepseek-v4.1-flash': 1_000_000 }));

    const result = await registry.listAllModels(true);

    assert.equal(
      result.models.find((model) => model.id === 'cline-free/deepseek-v4.1-flash')?.contextWindow,
      1_000_000,
      'a provider that publishes no context window borrows the models.dev value',
    );
  });

  it('keeps a provider-supplied contextWindow untouched', async () => {
    const registry = new ProviderRegistry(
      configWith({ openrouter: { enabled: true, credentials: { apiKey: 'k' } } }),
    );
    installProvider(registry, 'openrouter', async () => [
      { id: 'a-8k', provider: 'openrouter', displayName: 'A', free: true, contextWindow: 32_768 },
    ]);
    __setModelsDevContextForTests(newContextStore({ 'a-8k': 1_000_000 }));

    const result = await registry.listAllModels(true);

    assert.equal(
      result.models.find((model) => model.id === 'a-8k')?.contextWindow,
      32_768,
      'the authoritative upstream value must never be overwritten by a guess',
    );
  });

  it('still returns every model when the context fetch fails', async () => {
    const registry = new ProviderRegistry(
      configWith({ openrouter: { enabled: true, credentials: { apiKey: 'k' } } }),
    );
    installProvider(registry, 'openrouter', async () => [
      { id: 'ghost', provider: 'openrouter', displayName: 'Ghost', free: true },
    ]);
    __setModelsDevContextForTests(newContextStore({}));

    const result = await registry.listAllModels(true);

    assert.deepEqual(
      result.models.map((model) => model.id),
      ['ghost'],
    );
    assert.equal(result.models[0]?.contextWindow, undefined);
    assert.deepEqual(result.failedProviders, [], 'a dead models.dev must not fail the listing');
  });
});
