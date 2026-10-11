export interface AliasValidationResult {
  ok: boolean;
  error?: string;
  aliases?: Record<string, string>;
}

/**
 * Validate a model-alias map before persisting it. Alias names are external
 * identifiers, so they must stay free of ':' (which the gemini route splits on
 * and the "provider:model" prefix parser consumes), must not shadow the
 * reserved routing keywords, and must not collide with a real model id.
 *
 * Targets are deliberately NOT required to exist in the catalog: the model
 * list refreshes continuously, so an alias may be configured before its
 * target appears. A missing target surfaces as a normal resolve error.
 */
export function validateModelAliases(input: unknown, knownIds: Set<string>): AliasValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'modelAliases must be an object' };
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const alias = rawKey.trim();
    if (!alias) return { ok: false, error: 'alias name must not be empty' };
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
    out[alias] = rawValue.trim();
  }
  return { ok: true, aliases: out };
}
