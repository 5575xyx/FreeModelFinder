import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRemovalCleanupPlan,
  applyRemovalCleanupPatch,
  appendToRemovalCleanupLog,
  EMPTY_REMOVAL_CLEANUP_LOG,
  REMOVAL_CLEANUP_LOG_MAX,
} from '../removal-cleanup.js';
import type { AppConfig, ProviderId } from '../../types.js';
import type { ModelSnapshotEntry } from '../snapshot.js';

function baseConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    defaultModel: 'openrouter:llama-3',
    providers: { openrouter: { enabled: true } },
    gateway: {
      requireAuth: true,
      keys: [
        {
          id: 'k1',
          key: 'secret',
          createdAt: 0,
          modelAllowlist: ['openrouter:llama-3', 'openrouter:gpt-4o-mini', 'gemini:gemini-1'],
        },
        { id: 'k2', key: 'secret2', createdAt: 0, modelAllowlist: ['openrouter:llama-3'] },
        { id: 'k3', key: 'secret3', createdAt: 0 },
      ],
    },
    autoRoute: {
      enabled: true,
      strategy: 'capability',
      visionModel: ['openrouter:llava', 'openrouter:llama-3'],
      imageModel: ['openrouter:sd-xl'],
      videoModel: ['openrouter:llama-3'],
      fallbackChain: ['openrouter:llama-3', 'openrouter:gpt-4o-mini'],
      textTiers: { simple: ['openrouter:llama-3'], medium: ['openrouter:gpt-4o-mini'] },
      profiles: [{ id: 'llama-3', provider: 'openrouter', capabilityScore: 10 }],
    },
    modelAliases: {
      myllama: 'openrouter:llama-3',
      fast: 'openrouter:gpt-4o-mini',
      vid: 'openrouter:llama-3',
    },
  };
}

function removedModels(): ModelSnapshotEntry[] {
  return [
    { id: 'llama-3', provider: 'openrouter' as ProviderId, displayName: 'Llama 3', free: true },
  ];
}

function onlineModels(): ModelSnapshotEntry[] {
  return [
    {
      id: 'gpt-4o-mini',
      provider: 'openrouter' as ProviderId,
      displayName: 'GPT-4o mini',
      free: true,
    },
    { id: 'llava', provider: 'openrouter' as ProviderId, displayName: 'LLaVA', free: true },
    { id: 'sd-xl', provider: 'openrouter' as ProviderId, displayName: 'SDXL', free: true },
    { id: 'gemini-1', provider: 'gemini' as ProviderId, displayName: 'Gemini 1', free: true },
  ];
}

describe('buildRemovalCleanupPlan', () => {
  it('returns an empty patch and null entry when nothing was removed', () => {
    const cfg = baseConfig();
    const { patch, entry } = buildRemovalCleanupPlan([], cfg, onlineModels());
    assert.equal(entry, null);
    assert.deepEqual(patch, {});
  });

  it('prunes allowlist entries that reference the removed model but keeps others', () => {
    const { patch, entry } = buildRemovalCleanupPlan(removedModels(), baseConfig(), onlineModels());
    assert.ok(entry);
    const applied = applyRemovalCleanupPatch(baseConfig(), patch);
    const keys = applied.gateway?.keys ?? [];
    const k1 = keys.find((k) => k.id === 'k1')!;
    assert.deepEqual(k1.modelAllowlist, ['openrouter:gpt-4o-mini', 'gemini:gemini-1']);
    const k2 = keys.find((k) => k.id === 'k2')!;
    // k2 had only the removed model → allowlist emptied and dropped
    assert.equal(k2.modelAllowlist, undefined);
    const k3 = keys.find((k) => k.id === 'k3')!;
    assert.equal(k3.modelAllowlist, undefined);
    assert.equal(k1.key, 'secret', 'keys are never deleted');
    assert.equal(keys.length, 3, 'all three keys still present');
  });

  it('prunes autoRoute pools and empties fully-removed pools to undefined', () => {
    const { patch, entry } = buildRemovalCleanupPlan(removedModels(), baseConfig(), onlineModels());
    assert.ok(entry);
    const applied = applyRemovalCleanupPatch(baseConfig(), patch);
    const ar = applied.autoRoute!;
    assert.deepEqual(ar.visionModel, ['openrouter:llava']);
    assert.equal(ar.videoModel, undefined, 'videoModel was only the removed model');
    assert.deepEqual(ar.fallbackChain, ['openrouter:gpt-4o-mini']);
    assert.deepEqual(ar.textTiers?.simple, undefined, 'simple tier emptied');
    assert.deepEqual(ar.textTiers?.medium, ['openrouter:gpt-4o-mini']);
    assert.equal(
      ar.profiles?.find((p) => p.id === 'llama-3'),
      undefined,
      'dead profile removed',
    );
    assert.equal(entry!.autoRoutePoolsEmptied >= 1, true);
  });

  it('re-points defaultModel to the first still-online model of the same provider', () => {
    const { patch, entry } = buildRemovalCleanupPlan(removedModels(), baseConfig(), onlineModels());
    assert.ok(entry);
    // openrouter still has online models (gpt-4o-mini, llava, sd-xl); first in
    // onlineModels order is gpt-4o-mini.
    assert.equal(patch.defaultModel, 'openrouter:gpt-4o-mini');
    const applied = applyRemovalCleanupPatch(baseConfig(), patch);
    assert.equal(applied.defaultModel, 'openrouter:gpt-4o-mini');
    assert.equal(entry!.defaultModelChanged, true);
  });

  it('clears defaultModel when the removed model is from a fully-gone provider', () => {
    const cfg = baseConfig();
    cfg.defaultModel = 'gemini:gemini-1';
    const removed = [
      { id: 'gemini-1', provider: 'gemini' as ProviderId, displayName: 'Gemini 1', free: true },
    ];
    const online: ModelSnapshotEntry[] = []; // gemini provider fully gone
    const { patch, entry } = buildRemovalCleanupPlan(removed, cfg, online);
    assert.ok(entry);
    assert.equal(patch.defaultModel, null, 'null signals "clear the field"');
    const applied = applyRemovalCleanupPatch(cfg, patch);
    assert.equal(applied.defaultModel, undefined);
    assert.equal(entry!.fullyRemovedProviders.includes('gemini'), true);
  });

  it('leaves defaultModel alone when it does not reference a removed model', () => {
    const cfg = baseConfig();
    cfg.defaultModel = 'gemini:gemini-1';
    const { patch, entry } = buildRemovalCleanupPlan(removedModels(), cfg, onlineModels());
    assert.ok(entry);
    assert.equal(patch.defaultModel, undefined, 'omitted = leave unchanged');
    const applied = applyRemovalCleanupPatch(cfg, patch);
    assert.equal(applied.defaultModel, 'gemini:gemini-1');
    assert.equal(entry!.defaultModelChanged, false);
  });

  it('drops alias entries whose target is the removed model, keeps others', () => {
    const { patch, entry } = buildRemovalCleanupPlan(removedModels(), baseConfig(), onlineModels());
    assert.ok(entry);
    const applied = applyRemovalCleanupPatch(baseConfig(), patch);
    assert.deepEqual(applied.modelAliases, { fast: 'openrouter:gpt-4o-mini' });
    assert.equal(entry!.aliasEntriesPruned, 2); // myllama + vid
  });

  it('counts summary fields correctly across all four categories', () => {
    const { entry } = buildRemovalCleanupPlan(removedModels(), baseConfig(), onlineModels());
    assert.ok(entry);
    // k1 lost 1, k2 lost 1 (emptied), k3 had none
    assert.equal(entry!.allowlistEntriesPruned, 2);
    assert.equal(entry!.aliasEntriesPruned, 2);
    assert.equal(entry!.defaultModelChanged, true);
    assert.ok(entry!.removedModelIds.includes('openrouter:llama-3'));
  });

  it('handles config without gateway/autoRoute/aliases gracefully', () => {
    const minimal: AppConfig = {
      version: 2,
      port: 11435,
      providers: { openrouter: { enabled: true } },
    };
    const { patch, entry } = buildRemovalCleanupPlan(removedModels(), minimal, onlineModels());
    assert.ok(entry);
    const applied = applyRemovalCleanupPatch(minimal, patch);
    assert.equal(applied.gateway, undefined);
    assert.equal(applied.autoRoute, undefined);
    assert.equal(applied.modelAliases, undefined);
    assert.equal(applied.defaultModel, undefined);
  });
});

describe('applyRemovalCleanupPatch', () => {
  it('does not touch fields omitted from the patch', () => {
    const cfg = baseConfig();
    const applied = applyRemovalCleanupPatch(cfg, {});
    assert.deepEqual(applied, cfg);
  });

  it('applies a null defaultModel as a clear, not a set-to-null', () => {
    const cfg = baseConfig();
    const applied = applyRemovalCleanupPatch(cfg, { defaultModel: null });
    assert.equal(applied.defaultModel, undefined, 'null becomes undefined in AppConfig');
  });
});

describe('appendToRemovalCleanupLog', () => {
  it('prepends the newest entry first', () => {
    const e1 = {
      ts: 1,
      removedModelIds: ['a:b'],
      fullyRemovedProviders: [],
      allowlistEntriesPruned: 1,
      aliasEntriesPruned: 0,
      autoRoutePoolsEmptied: 0,
      defaultModelChanged: false,
    };
    const log = appendToRemovalCleanupLog(EMPTY_REMOVAL_CLEANUP_LOG, e1);
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0]?.ts, 1);
  });

  it('caps history at REMOVAL_CLEANUP_LOG_MAX', () => {
    let log = EMPTY_REMOVAL_CLEANUP_LOG;
    for (let i = 0; i < REMOVAL_CLEANUP_LOG_MAX + 5; i += 1) {
      log = appendToRemovalCleanupLog(log, {
        ts: i,
        removedModelIds: ['x'],
        fullyRemovedProviders: [],
        allowlistEntriesPruned: 0,
        aliasEntriesPruned: 0,
        autoRoutePoolsEmptied: 0,
        defaultModelChanged: false,
      });
    }
    assert.equal(log.entries.length, REMOVAL_CLEANUP_LOG_MAX);
    assert.equal(log.entries[0]?.ts, REMOVAL_CLEANUP_LOG_MAX + 4, 'newest first');
  });
});
