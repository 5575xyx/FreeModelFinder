function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Decode a models.dev payload into a provider-agnostic `model id -> context
 * window` table, used to backfill context windows that a provider never
 * published (Cline's recommended-models list carries no context_length, for
 * one). The same model appears under many providers with disagreeing limits,
 * so each key is a majority vote over every occurrence — ties resolve to the
 * smaller window, because the router treats contextWindow as a hard ceiling
 * (`inputTokens <= contextWindow * 0.95`) and an inflated one routes requests
 * upstream only to be truncated.
 *
 * Both the record id and its `canonical_model_id` are indexed: gateway-facing
 * ids arrive bare (`deepseek-v4.1-flash`) or source-prefixed
 * (`deepseek/deepseek-v4-flash`), and only a second index answers the latter.
 *
 * Throws on a payload that yields nothing: an empty table would otherwise be
 * cached over a good one, silently wiping every context window we knew.
 */
export function decodeContextTable(data: unknown): Map<string, number> {
  const providers = asRecord(data);
  if (!providers) throw new Error('models.dev payload is not an object');
  const votes = new Map<string, Map<number, number>>();
  for (const provider of Object.values(providers)) {
    const models = asRecord(asRecord(provider)?.['models']);
    if (!models) continue;
    for (const [recordKey, raw] of Object.entries(models)) {
      const model = asRecord(raw);
      if (!model) continue;
      const context = asRecord(model['limit'])?.['context'];
      if (typeof context !== 'number' || context <= 0) continue;
      const rawId = model['id'];
      const primary = typeof rawId === 'string' && rawId.trim() ? rawId : recordKey;
      const canonical = model['canonical_model_id'];
      const keys =
        typeof canonical === 'string' && canonical.trim() ? [primary, canonical] : [primary];
      for (const key of keys) {
        const perKey = votes.get(key) ?? new Map<number, number>();
        perKey.set(context, (perKey.get(context) ?? 0) + 1);
        votes.set(key, perKey);
      }
    }
  }
  const table = new Map<string, number>();
  for (const [key, perKey] of votes) {
    let best: number | undefined;
    let bestCount = -1;
    for (const [context, count] of perKey) {
      if (count > bestCount || (count === bestCount && context < (best ?? Infinity))) {
        best = context;
        bestCount = count;
      }
    }
    if (best !== undefined) table.set(key, best);
  }
  if (table.size === 0) throw new Error('models.dev contains no context metadata');
  return table;
}
