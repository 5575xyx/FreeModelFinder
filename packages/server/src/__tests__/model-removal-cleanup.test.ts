import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  applyRemovalCleanupPatch,
  buildRemovalCleanupPlan,
  EMPTY_REMOVAL_CLEANUP_LOG,
  loadSnapshot,
  ProviderRegistry,
  recordSnapshot,
  updateConfig,
  type AppConfig,
  type ModelInfo,
  type ModelSnapshotEntry,
  type ProviderId,
  type RemovalCleanupEntry,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import {
  clearRemovalCleanupLog,
  loadRemovalCleanupLog,
  recordRemovalCleanup,
} from '../removal-cleanup-log.js';

const apps: FastifyInstance[] = [];

const UI_HEADERS = { origin: 'http://127.0.0.1:11435', 'x-fmf-client': 'ui' };

function configFor(
  allowlist: string[],
  aliases?: Record<string, string>,
  defaultModel?: string,
): AppConfig {
  return {
    version: 2,
    port: 11435,
    defaultModel,
    providers: {
      openrouter: { enabled: true, credentials: { apiKey: 'test' } },
    },
    gateway: {
      requireAuth: true,
      keys: [{ id: 'k1', key: 'secret', createdAt: 0, modelAllowlist: allowlist }],
    },
    autoRoute: { enabled: true, strategy: 'capability' },
    ...(aliases ? { modelAliases: aliases } : {}),
  };
}

async function appWith(config: AppConfig): Promise<FastifyInstance> {
  await updateConfig(() => config);
  const { app } = await createServer({ registry: new ProviderRegistry(config) });
  const fastify = app as unknown as FastifyInstance;
  apps.push(fastify);
  return fastify;
}

function cleanupLogApi(app: FastifyInstance) {
  return app.inject({ method: 'GET', url: '/api/model-cleanup-log', headers: UI_HEADERS });
}

/**
 * Simulate the watcher's post-recordSnapshot cleanup step: re-record the
 * snapshot with `removedIds` missing from the provider and return the
 * confirmed-removed entries the watcher would hand to the handler.
 *
 * Passes `undefined` as the scoped-providers argument so the recorder treats
 * every provider as "succeeded this round". This mirrors the production case
 * where `listAllModels` returned successfully (with zero models) for a
 * provider whose models were all removed, and avoids the snapshot's
 * "preserve models from providers that failed" behaviour silently keeping
 * removed models in the online list.
 *
 * `seedNow` must be strictly less than `narrowNow` so the two recordSnapshot
 * calls produce two distinct timestamps; otherwise the diff can be empty.
 */
async function simulateWatcherRound(
  fullCatalog: ModelInfo[],
  removedIds: string[],
  seedNow: number,
): Promise<ModelSnapshotEntry[]> {
  const narrowed = fullCatalog.filter((m) =>
    m.provider === 'openrouter' ? !removedIds.includes(m.id) : true,
  );
  const narrowNow = seedNow + 1;
  const rec = await recordSnapshot(narrowed, narrowNow, undefined);
  return rec.diff.removed;
}

describe('model removal cleanup', () => {
  beforeEach(async () => {
    await clearRemovalCleanupLog();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('prunes allowlist, aliases and re-points defaultModel when a model is removed upstream', async () => {
    const config = configFor(
      ['openrouter:llama-3', 'openrouter:gpt-4o-mini'],
      { myllama: 'openrouter:llama-3' },
      'openrouter:llama-3',
    );
    const app = await appWith(config);

    // Read the config as the watcher's handler would, build the patch, apply it.
    // `removed` and `online` are passed explicitly so this check is independent
    // of any snapshot the previous test left on disk (the disk-snapshot path is
    // exercised separately by `simulateWatcherRound`-based assertions below).
    const current = await updateConfig(() => config);
    const removed: ModelSnapshotEntry[] = [
      { id: 'llama-3', provider: 'openrouter' as ProviderId, displayName: 'Llama 3', free: true },
    ];
    const online: ModelSnapshotEntry[] = [
      {
        id: 'gpt-4o-mini',
        provider: 'openrouter' as ProviderId,
        displayName: 'GPT-4o mini',
        free: true,
      },
    ];
    const { patch, entry } = buildRemovalCleanupPlan(removed, current, online);
    assert.ok(entry);
    const next = await updateConfig((cfg) => applyRemovalCleanupPatch(cfg, patch));
    assert.deepEqual(next.gateway?.keys?.[0]?.modelAllowlist, ['openrouter:gpt-4o-mini']);
    assert.equal(next.modelAliases, undefined, 'dead alias dropped');
    assert.equal(next.defaultModel, 'openrouter:gpt-4o-mini', 're-pointed to sibling');

    const log = await recordRemovalCleanup(entry);
    assert.equal(log.entries.length, 1);
    const res = await cleanupLogApi(app);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload) as { entries: RemovalCleanupEntry[] };
    assert.equal(body.entries.length, 1);
    assert.deepEqual(body.entries[0]?.removedModelIds, ['openrouter:llama-3']);
    assert.equal(body.entries[0]?.allowlistEntriesPruned, 1);
    assert.equal(body.entries[0]?.defaultModelChanged, true);
  });

  it('does not delete the gateway key even when its allowlist empties out', async () => {
    const app = await appWith(configFor(['openrouter:llama-3']));
    void app;

    // Pure-function check: pass the removed entries and the post-removal online
    // list explicitly so this test is independent of any snapshot the previous
    // test left on disk.
    const current = await updateConfig(() => configFor(['openrouter:llama-3']));
    const removed: ModelSnapshotEntry[] = [
      { id: 'llama-3', provider: 'openrouter' as ProviderId, displayName: 'Llama 3', free: true },
    ];
    const { patch, entry } = buildRemovalCleanupPlan(removed, current, []);
    assert.ok(entry);
    const next = await updateConfig((cfg) => applyRemovalCleanupPatch(cfg, patch));
    assert.equal(next.gateway?.keys?.length, 1, 'key itself is never deleted');
    assert.equal(next.gateway?.keys?.[0]?.modelAllowlist, undefined, 'allowlist emptied');
    assert.equal(next.gateway?.keys?.[0]?.key, 'secret');
    assert.equal(next.defaultModel, undefined, 'defaultModel cleared when provider fully gone');
  });

  it('clears defaultModel when the removed provider is fully gone', async () => {
    const app = await appWith(configFor(['openrouter:only'], undefined, 'openrouter:only'));

    // Pure-function check, independent of the shared on-disk snapshot.
    const current = await updateConfig(() => configFor([], undefined, 'openrouter:only'));
    const removed: ModelSnapshotEntry[] = [
      { id: 'only', provider: 'openrouter' as ProviderId, displayName: 'Only', free: true },
    ];
    const { patch, entry } = buildRemovalCleanupPlan(removed, current, []);
    assert.ok(entry);
    assert.equal(patch.defaultModel, null, 'no sibling online, patch clears defaultModel');
    const next = await updateConfig((cfg) => applyRemovalCleanupPatch(cfg, patch));
    assert.equal(next.defaultModel, undefined, 'defaultModel cleared in config');
    assert.ok(entry.fullyRemovedProviders.includes('openrouter'));
    await recordRemovalCleanup(entry);
    const res = await cleanupLogApi(app);
    const body = JSON.parse(res.payload) as { entries: RemovalCleanupEntry[] };
    assert.ok(body.entries[0]?.fullyRemovedProviders.includes('openrouter'));
  });

  it('GET /api/model-cleanup-log returns an empty list when nothing was cleaned up', async () => {
    const app = await appWith(configFor([]));
    const res = await cleanupLogApi(app);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.payload), { entries: [] });
  });

  it('loadRemovalCleanupLog returns the empty log by default', async () => {
    const log = await loadRemovalCleanupLog();
    assert.deepEqual(log, EMPTY_REMOVAL_CLEANUP_LOG);
  });

  it('drives the cleanup plan through the on-disk snapshot path the watcher uses', async () => {
    const catalog: ModelInfo[] = [
      { id: 'llama-3', provider: 'openrouter' as ProviderId, displayName: 'Llama 3', free: true },
      {
        id: 'gpt-4o-mini',
        provider: 'openrouter' as ProviderId,
        displayName: 'GPT-4o mini',
        free: true,
      },
    ];
    // Two strictly-increasing timestamps so the two recordSnapshot calls
    // (seed + narrowed round) never collide on the same millisecond.
    const seedNow = Date.now();
    await recordSnapshot(catalog, seedNow, undefined);
    await appWith(configFor(['openrouter:llama-3'], undefined, 'openrouter:llama-3'));

    const removed = await simulateWatcherRound(catalog, ['llama-3'], seedNow);
    assert.deepEqual(
      removed.map((r) => r.id),
      ['llama-3'],
      'diff confirms only the removed model',
    );
    const online = (await loadSnapshot()).models;
    assert.deepEqual(
      online.map((m) => m.id),
      ['gpt-4o-mini'],
      'post-removal online list from the on-disk snapshot',
    );

    const current = await updateConfig(() =>
      configFor(['openrouter:llama-3'], undefined, 'openrouter:llama-3'),
    );
    const { patch, entry } = buildRemovalCleanupPlan(removed, current, online);
    assert.ok(entry);
    const next = await updateConfig((cfg) => applyRemovalCleanupPatch(cfg, patch));
    assert.equal(next.defaultModel, 'openrouter:gpt-4o-mini', 're-pointed via disk-snapshot path');
  });
});
