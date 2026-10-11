export type AliasValidationResult =
  { ok: true; aliases: Record<string, string> } | { ok: false; error: string };

/**
 * Validate a model-alias map before persisting it. Alias names are external
 * identifiers, so they must stay free of ':' (which the gemini route splits on
 * and the "provider:model" prefix parser consumes), must not shadow the
 * reserved routing keywords, and must not collide with a real model id.
 *
 * Targets are deliberately NOT required to exist in the catalog: the model
 * list refreshes continuously, so an alias may be configured before its
 * target appears. A missing target surfaces as a normal resolve error.
 *
 * Validation is fail-fast: the first offending entry aborts the whole map, so
 * a rejected map reports exactly one error and nothing else about it.
 *
 * @param knownIds Model ids an alias must not shadow. Callers must pass BOTH
 * the composed and the bare form of every catalog entry, e.g.
 * `new Set(models.flatMap((m) => [m.id, bareModelId(m.provider, m.id)]))`,
 * because OpenAI-compatible providers store bare ids and a user alias is far
 * more likely to collide with the bare form.
 */
export function validateModelAliases(input: unknown, knownIds: Set<string>): AliasValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'modelAliases must be an object' };
  }
  const out: Record<string, string> = {};
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
    if (knownIds.has(alias)) {
      return { ok: false, error: `alias "${alias}" conflicts with an existing model id` };
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      return { ok: false, error: `alias "${alias}" must point to a model id` };
    }
    const target = rawValue.trim();
    if (target === 'auto' || target === 'default') {
      return { ok: false, error: `alias "${alias}" cannot point to "${target}"` };
    }
    if (Object.hasOwn(out, target)) {
      return { ok: false, error: `alias "${alias}" points back to "${target}"` };
    }
    out[alias] = target;
  }
  return { ok: true, aliases: out };
}
