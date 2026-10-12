import type { AppConfig } from '../types.js';
import { composeModelId } from '../model-id.js';
import type { ModelSnapshotEntry } from './snapshot.js';

/**
 * A single auto-cleanup event triggered when the model watcher confirms that an
 * upstream provider removed one or more models from its listing.
 */
export interface RemovalCleanupEntry {
  ts: number;
  /** Composed model ids (e.g. "openrouter:llama-3") that were removed. */
  removedModelIds: string[];
  /** Providers that had every one of their models disappear this round. */
  fullyRemovedProviders: string[];
  /** Number of gateway-key allowlist entries pruned. */
  allowlistEntriesPruned: number;
  /** Number of alias entries whose target pointed at a removed model. */
  aliasEntriesPruned: number;
  /** Number of autoRoute pool slots that became empty after pruning. */
  autoRoutePoolsEmptied: number;
  /** True if the top-level defaultModel was re-pointed or cleared. */
  defaultModelChanged: boolean;
}

/**
 * A partial config patch that can be applied on top of the freshest on-disk
 * config. `defaultModel`/`modelAliases` use `null` to mean "clear this field",
 * since a plain `undefined` cannot survive JSON serialization in the log.
 */
export interface RemovalCleanupPatch {
  gateway?: AppConfig['gateway'];
  autoRoute?: AppConfig['autoRoute'];
  /** New defaultModel value, or `null` to clear it. Omitted = leave unchanged. */
  defaultModel?: string | null;
  /** New alias map, or `null` to clear it. Omitted = leave unchanged. */
  modelAliases?: Record<string, string> | null;
}

/**
 * Compute the cleaned-up config and a summary of what was pruned, given the set
 * of models the watcher just confirmed removed upstream.
 *
 * Pure function: does not touch the filesystem. The caller applies the result
 * via `updateConfig` and persists the summary to the cleanup log.
 *
 * Rules:
 * - gateway keys are NEVER deleted; only their `modelAllowlist` entries that
 *   reference a removed composed model id are removed.
 * - `autoRoute` pools (`visionModel`/`imageModel`/`videoModel`/`fallbackChain`/
 *   `textTiers`/`profiles` model lists) have dead entries removed; if a pool
 *   becomes empty it is set to `undefined` (not an empty array) so the UI stays
 *   friendly.
 * - top-level `defaultModel`, if it points at a removed model, is re-pointed to
 *   the first still-online model from the same provider (per the snapshot
 *   order) or cleared if that provider is fully gone.
 * - `modelAliases` entries whose target equals a removed composed model id are
 *   dropped; alias names themselves are not reused or kept for dead targets.
 */
export function buildRemovalCleanupPlan(
  removedModels: readonly ModelSnapshotEntry[],
  currentConfig: AppConfig,
  currentOnlineModels: readonly ModelSnapshotEntry[],
): { patch: RemovalCleanupPatch; entry: RemovalCleanupEntry | null } {
  if (removedModels.length === 0) return { patch: {}, entry: null };

  const removedComposed = new Set(removedModels.map((m) => composeModelId(m.provider, m.id)));
  if (removedComposed.size === 0) return { patch: {}, entry: null };

  // Providers that are now fully gone (every one of their models was removed
  // this round and none remain online).
  const fullyRemoved = new Set<string>();
  for (const provider of new Set(removedModels.map((m) => m.provider))) {
    const stillOnline = currentOnlineModels.some((m) => m.provider === provider);
    if (!stillOnline) fullyRemoved.add(provider);
  }

  // 1. gateway keys: prune allowlist entries
  let allowlistEntriesPruned = 0;
  const nextGateway = currentConfig.gateway
    ? {
        ...currentConfig.gateway,
        keys: currentConfig.gateway.keys?.map((entry) => {
          if (!entry.modelAllowlist?.length) return entry;
          const kept = entry.modelAllowlist.filter((id) => !removedComposed.has(id));
          allowlistEntriesPruned += entry.modelAllowlist.length - kept.length;
          return kept.length === 0
            ? { ...entry, modelAllowlist: undefined }
            : { ...entry, modelAllowlist: kept };
        }),
      }
    : currentConfig.gateway;

  // 2. autoRoute: prune pools and tiers
  let autoRoutePoolsEmptied = 0;
  let nextAutoRoute = currentConfig.autoRoute;
  const prunePool = (pool?: string[]): string[] | undefined => {
    if (!pool?.length) return pool;
    const kept = pool.filter((id) => !removedComposed.has(id));
    if (kept.length < pool.length) {
      if (kept.length === 0) autoRoutePoolsEmptied += 1;
      return kept.length === 0 ? undefined : kept;
    }
    return pool;
  };
  if (nextAutoRoute) {
    const nextTiers = nextAutoRoute.textTiers
      ? {
          simple: prunePool(nextAutoRoute.textTiers.simple),
          medium: prunePool(nextAutoRoute.textTiers.medium),
          complex: prunePool(nextAutoRoute.textTiers.complex),
        }
      : undefined;
    nextAutoRoute = {
      ...nextAutoRoute,
      fallbackChain: prunePool(nextAutoRoute.fallbackChain),
      imageModel: prunePool(nextAutoRoute.imageModel),
      videoModel: prunePool(nextAutoRoute.videoModel),
      visionModel: prunePool(nextAutoRoute.visionModel),
      textTiers:
        nextTiers && (nextTiers.simple || nextTiers.medium || nextTiers.complex)
          ? nextTiers
          : undefined,
      // Profiles map to a single model (provider+id). If that model was
      // removed upstream, drop the whole profile entry — a profile without a
      // live model is a dead routing rule.
      profiles: nextAutoRoute.profiles?.filter(
        (profile) => !removedComposed.has(composeModelId(profile.provider, profile.id)),
      ),
    };
  }

  // 3. defaultModel: re-point to the first still-online model of the same
  //    provider, or clear it if that provider is fully removed.
  let defaultModelChanged = false;
  let nextDefaultModel = currentConfig.defaultModel;
  if (nextDefaultModel && removedComposed.has(nextDefaultModel)) {
    const removedProvider = removedModels.find(
      (m) => composeModelId(m.provider, m.id) === nextDefaultModel,
    );
    if (removedProvider) {
      const removedIdsForProvider = new Set(
        removedModels.filter((m) => m.provider === removedProvider.provider).map((m) => m.id),
      );
      const replacement = currentOnlineModels.find(
        (m) => m.provider === removedProvider.provider && !removedIdsForProvider.has(m.id),
      );
      nextDefaultModel = replacement
        ? composeModelId(replacement.provider, replacement.id)
        : undefined;
    }
    defaultModelChanged = true;
  }

  // 4. modelAliases: drop entries whose target is a removed model
  let aliasEntriesPruned = 0;
  let nextModelAliases = currentConfig.modelAliases;
  if (nextModelAliases) {
    const kept: Record<string, string> = {};
    for (const [alias, target] of Object.entries(nextModelAliases)) {
      if (removedComposed.has(target)) {
        aliasEntriesPruned += 1;
        continue;
      }
      kept[alias] = target;
    }
    nextModelAliases = Object.keys(kept).length === 0 ? undefined : kept;
  }

  const entry: RemovalCleanupEntry = {
    ts: Date.now(),
    removedModelIds: [...removedComposed],
    fullyRemovedProviders: [...fullyRemoved],
    allowlistEntriesPruned,
    aliasEntriesPruned,
    autoRoutePoolsEmptied,
    defaultModelChanged,
  };

  // Return a partial patch (not a full config) so the caller can apply it on
  // top of the freshest on-disk config. Merging a full AppConfig would
  // resurrect stale fields through normalizeConfig's DEFAULT spread.
  // `null` means "clear this field"; omitted means "leave unchanged".
  const patch: RemovalCleanupPatch = {
    ...(nextGateway !== currentConfig.gateway ? { gateway: nextGateway } : {}),
    ...(nextAutoRoute !== currentConfig.autoRoute ? { autoRoute: nextAutoRoute } : {}),
    ...(defaultModelChanged ? { defaultModel: nextDefaultModel ?? null } : {}),
    ...(nextModelAliases !== currentConfig.modelAliases
      ? { modelAliases: nextModelAliases ?? null }
      : {}),
  };

  return { patch, entry };
}

/** Maximum number of cleanup log entries to keep. */
export const REMOVAL_CLEANUP_LOG_MAX = 100;

export interface RemovalCleanupLog {
  entries: RemovalCleanupEntry[];
}

/** Append an entry to the cleanup log, capping history at REMOVAL_CLEANUP_LOG_MAX. */
export function appendToRemovalCleanupLog(
  log: RemovalCleanupLog,
  entry: RemovalCleanupEntry,
): RemovalCleanupLog {
  return { entries: [entry, ...log.entries].slice(0, REMOVAL_CLEANUP_LOG_MAX) };
}

export const EMPTY_REMOVAL_CLEANUP_LOG: RemovalCleanupLog = { entries: [] };

/**
 * Apply a cleanup patch on top of the freshest on-disk config. `null` values
 * mean "clear this field"; omitted fields are left untouched.
 */
export function applyRemovalCleanupPatch(config: AppConfig, patch: RemovalCleanupPatch): AppConfig {
  return {
    ...config,
    ...(patch.gateway !== undefined ? { gateway: patch.gateway } : {}),
    ...(patch.autoRoute !== undefined ? { autoRoute: patch.autoRoute } : {}),
    ...(patch.defaultModel !== undefined ? { defaultModel: patch.defaultModel ?? undefined } : {}),
    ...(patch.modelAliases !== undefined ? { modelAliases: patch.modelAliases ?? undefined } : {}),
  };
}
