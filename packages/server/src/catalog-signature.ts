import type { ModelInfo } from '@freemodelfinder/core';

function compareEntries(
  a: readonly [string, string, string],
  b: readonly [string, string, string],
): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

/**
 * Stable fingerprint of the model catalog for change detection.
 *
 * The order providers (and their models) come back in is not part of the
 * catalog's identity, so entries are sorted before hashing. Without this any
 * transient reshuffle — one provider falling back to the snapshot mid-refresh,
 * or two concurrent refreshes finishing in a different order — flips the
 * signature and bumps `catalogRevision`. The dashboard polls
 * `/api/desktop/state` every 2s, so each flip makes it re-fetch the whole
 * catalog for nothing.
 */
export function catalogSignature(models: readonly ModelInfo[]): string {
  return JSON.stringify(
    models
      .map((model) => [model.provider, model.id, model.displayName ?? ''] as const)
      .sort(compareEntries),
  );
}
