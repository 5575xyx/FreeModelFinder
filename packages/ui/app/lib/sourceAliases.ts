/**
 * Source-scoped alias rewrite logic.
 *
 * Aliases live in a per-source card: key = `来源id/别名名` (no prefix in the
 * alias name itself, e.g. `glm`), value = composed form `custom:来源id:模型id`
 * pointing at a model of that source. Bare (prefix-less) legacy keys never
 * take part in the rewrite and are kept as-is; `findLegacyBareAliases`
 * extracts them so the UI can offer a migration prompt.
 */

export interface SourceAliasEdit {
  /** Alias name without any prefix, e.g. `glm`. */
  alias: string;
  /** Model id within the source, e.g. `glm-5.3`. */
  targetModel: string;
}

export type SourceChanges = Array<{ id: string; models: string[]; aliases: SourceAliasEdit[] }>;

export type LegacyAliasRow = { alias: string; target: string };

/**
 * Rebuild the global alias map from a freshly-fetched baseline
 * (`prevGlobal`) plus the per-source edits saved this round.
 *
 * For each source in `changes`:
 *  1. drop `change.id/*` entries whose composed target points at a model no
 *     longer in `change.models` (value form `custom:<id>:<model>`);
 *  2. write one entry per edited alias row.
 *
 * Prefixed entries of untouched sources and all bare legacy entries are
 * preserved.
 */
export function deriveSourceAliases(
  prevGlobal: Record<string, string>,
  changes: SourceChanges,
): Record<string, string> {
  const out: Record<string, string> = { ...prevGlobal };

  for (const change of changes) {
    const prefix = `${change.id}/`;
    const modelSet = new Set(change.models);

    for (const [key, value] of Object.entries(out)) {
      if (!key.startsWith(prefix)) continue;
      const modelSegment = parseTargetModel(value, change.id);
      if (modelSegment !== undefined && !modelSet.has(modelSegment)) {
        delete out[key];
      }
    }

    for (const edit of change.aliases) {
      out[`${change.id}/${edit.alias}`] = `custom:${change.id}:${edit.targetModel}`;
    }
  }

  return out;
}

/** Extract the model segment from a `custom:<id>:<model>` value; undefined if the shape does not match. */
function parseTargetModel(value: string, sourceId: string): string | undefined {
  const expectedPrefix = `custom:${sourceId}:`;
  if (!value.startsWith(expectedPrefix)) return undefined;
  const model = value.slice(expectedPrefix.length);
  return model.length > 0 ? model : undefined;
}

/** Return the prefix-less legacy entries (keys without `/`), for migration prompts. */
export function findLegacyBareAliases(global: Record<string, string>): LegacyAliasRow[] {
  return Object.entries(global)
    .filter(([key]) => !key.includes('/'))
    .map(([alias, target]) => ({ alias, target }));
}
