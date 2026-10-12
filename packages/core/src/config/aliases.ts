export type AliasValidationResult =
  { ok: true; aliases: Record<string, string> } | { ok: false; error: string };

/**
 * Validate a model-alias map before persisting it. Alias names are external
 * identifiers, so they must stay free of ':' (which the gemini route splits on
 * and the "provider:model" prefix parser consumes) and must not shadow the
 * reserved routing keywords.
 *
 * Alias names are deliberately allowed to equal a real model id. The one
 * alias per model guarantee that matters for the reverse lookup held by
 * `toClientFacingModel` is enforced separately via duplicate-target
 * rejection below; shadowing a model id is a safe no-op there because the
 * exact-target branch matches it directly.
 *
 * Targets are deliberately NOT required to exist in the catalog: the model
 * list refreshes continuously, so an alias may be configured before its
 * target appears. A missing target surfaces as a normal resolve error.
 *
 * Validation is fail-fast: the first offending entry aborts the whole map, so
 * a rejected map reports exactly one error and nothing else about it.
 *
 * The mapping is one alias per model: an alias whose target is already claimed
 * by another alias is rejected, because the reverse lookup that renders a model
 * back to a client returns a single name per model and would otherwise pick an
 * arbitrary one of the aliases.
 *
 * An alias may point at another alias (chained aliases are allowed and are
 * resolved recursively). Self-pointing aliases and alias cycles are rejected
 * for a different reason: they would recurse forever. Cycles are detected by
 * walking the finished alias graph, so the verdict does not depend on the order
 * in which the keys happen to be iterated.
 *
 * @param knownIds Reserved for future use (e.g. rejecting shadowed alias
 * targets). Callers still pass the composed and bare form of every catalog
 * entry, e.g. `new Set(models.flatMap((m) => [m.id, bareModelId(m.provider, m.id)]))`.
 * Currently accepted but NOT enforced: alias names may safely equal model ids.
 */
export function validateModelAliases(
  input: unknown,
  _knownIds?: Set<string>,
): AliasValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'modelAliases must be an object' };
  }
  const out: Record<string, string> = {};
  const targets = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const alias = rawKey.trim();
    if (!alias) return { ok: false, error: 'alias name must not be empty' };
    if (alias in Object.prototype) {
      return { ok: false, error: `alias "${alias}" is not a valid identifier` };
    }
    if (alias.includes(':')) {
      return { ok: false, error: `alias "${alias}" must not contain ":"` };
    }
    if (alias === 'auto' || alias === 'default') {
      return { ok: false, error: `alias "${alias}" is a reserved routing keyword` };
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      return { ok: false, error: `alias "${alias}" must point to a model id` };
    }
    const target = rawValue.trim();
    if (target === 'auto' || target === 'default') {
      return { ok: false, error: `alias "${alias}" cannot point to "${target}"` };
    }
    if (target === alias) {
      return { ok: false, error: `alias "${alias}" cannot point to itself` };
    }
    if (Object.hasOwn(out, alias)) {
      return { ok: false, error: `duplicate alias name "${alias}" after trimming` };
    }
    if (targets.has(target)) {
      return {
        ok: false,
        error: `alias "${alias}" duplicates an existing alias target "${target}"`,
      };
    }
    out[alias] = target;
    targets.add(target);
  }
  for (const [alias, target] of Object.entries(out)) {
    const seen = new Set<string>([alias]);
    let cur: string | undefined = target;
    while (cur !== undefined && Object.hasOwn(out, cur)) {
      if (seen.has(cur)) {
        return { ok: false, error: `alias "${alias}" is part of an alias cycle` };
      }
      seen.add(cur);
      cur = out[cur];
    }
  }
  return { ok: true, aliases: out };
}
