const STALE_MARKERS = ['not found', 'expir', 'does not exist', 'no longer'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isStaleReasoningReference(bodyText: string): boolean {
  const text = bodyText.toLowerCase();
  if (!text.includes('reasoning item') && !text.includes('reasoning reference')) {
    return false;
  }
  return STALE_MARKERS.some((marker) => text.includes(marker));
}

export function stripStaleReasoningInputs(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  changed: boolean;
} {
  const payload: Record<string, unknown> = { ...body };
  let changed = false;
  if ('previous_response_id' in payload) {
    delete payload['previous_response_id'];
    changed = true;
  }
  const raw = payload['input'];
  if (Array.isArray(raw)) {
    const kept = raw.filter((item) => {
      const entry = asRecord(item);
      if (entry?.['type'] === 'reasoning') {
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) payload['input'] = kept;
  }
  return changed ? { body: payload, changed } : { body, changed: false };
}
