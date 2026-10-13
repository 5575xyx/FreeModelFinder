/**
 * Model-page alias helpers (pure functions).
 *
 * The alias map is the global `config.modelAliases`:
 * key = 别名名, value = composed model id (e.g. `custom:novay:glm-5.3`).
 * One model may have at most ONE alias. Alias names may contain `/`
 * (legacy `novaway/glm` stays legal) and may equal a real model id, but
 * may not contain `:` (collides with the composed-id separator), may not
 * be the reserved routing keywords `auto`/`default`, and may not be an
 * `Object.prototype` key (plain-object alias maps would misbehave).
 */

export type AliasNameError = {
  /** i18n key, e.g. `finder.alias.error.taken` (copy added by a later task). */
  key: string;
  params?: Record<string, string | number>;
};

/** Invert the alias map: composed target → 别名名 (one alias per model). */
export function invertAliases(aliases: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, target] of Object.entries(aliases)) {
    out.set(target, name);
  }
  return out;
}

/**
 * Validate a new alias name for `target`. `name` is trimmed before every
 * check; an empty (after trim) name is not an error — it means "clear the
 * alias". Returns `null` when the name is usable.
 *
 * Check order (first match wins): empty → colon → reserved →
 * Object.prototype key → taken by another model.
 */
export function validateAliasName(
  name: string,
  target: string,
  aliases: Record<string, string>,
): AliasNameError | null {
  const trimmed = name.trim();

  if (trimmed === '') return null;
  if (trimmed.includes(':')) return { key: 'finder.alias.error.colon' };
  if (trimmed === 'auto' || trimmed === 'default') {
    return { key: 'finder.alias.error.reserved', params: { name: trimmed } };
  }
  if (trimmed in Object.prototype) {
    return { key: 'finder.alias.error.invalid', params: { name: trimmed } };
  }
  const owner = aliases[trimmed];
  if (owner !== undefined && owner !== target) {
    return { key: 'finder.alias.error.taken', params: { name: trimmed, model: owner } };
  }
  return null;
}

/**
 * Apply one alias edit for `target`: first delete EVERY entry whose value
 * is `target` (rename semantics — leaving the old name behind would make
 * the server reject the whole map with "duplicates an existing alias
 * target"), then write `trimmed → target` unless the trimmed name is empty
 * (empty means "clear the alias"). Returns a NEW object; never mutates the
 * input.
 */
export function applyAliasEdit(
  aliases: Record<string, string>,
  target: string,
  name: string,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(aliases)) {
    if (value !== target) out[key] = value;
  }

  const trimmed = name.trim();
  if (trimmed !== '') out[trimmed] = target;

  return out;
}
