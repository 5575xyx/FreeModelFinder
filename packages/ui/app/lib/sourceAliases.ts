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
 * Each source in `changes` is authoritative for its own namespace:
 *  1. delete *all* `change.id/*` entries from the baseline;
 *  2. write one entry per edited alias row (`change.id/alias` →
 *     `custom:<id>:<targetModel>`), skipping any row whose target model is no
 *     longer in `change.models`.
 *
 * Because the namespace is cleared wholesale, an alias whose model still
 * exists but whose row the user removed is genuinely deleted. Step 2's model
 * guard is what stops a `来源id/*` entry pointing at a removed model from
 * surviving: the editor hydrates once per source and therefore still reports
 * the removed model's row, so the rewrite must drop it here.
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

    for (const key of Object.keys(out)) {
      if (key.startsWith(prefix)) delete out[key];
    }

    for (const edit of change.aliases) {
      if (!modelSet.has(edit.targetModel)) continue;
      out[`${change.id}/${edit.alias}`] = `custom:${change.id}:${edit.targetModel}`;
    }
  }

  return out;
}

/** Return the prefix-less legacy entries (keys without `/`), for migration prompts. */
export function findLegacyBareAliases(global: Record<string, string>): LegacyAliasRow[] {
  return Object.entries(global)
    .filter(([key]) => !key.includes('/'))
    .map(([alias, target]) => ({ alias, target }));
}
