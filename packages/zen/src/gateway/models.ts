import type { ZenTier } from '../models/types.js';
import type { ZenProtocol } from '../protocol/types.js';
import { REASONING_LEVELS } from '../config/index.js';

/**
 * List the reasoning effort levels a model can be asked for. When an `auto`
 * probe has already resolved the highest level the upstream accepts, the list
 * stops there so clients do not offer levels that would be rejected. Mirrors
 * `reasoningEfforts` in upstream `internal/gateway/health.go`.
 */
export function reasoningEfforts(
  model: string,
  tier: ZenTier,
  protocol: ZenProtocol,
  deps: {
    /** Mirrors cfg.ForcedEffort: returns '' when nothing is configured. */
    forcedEffort: (m: string) => string;
    resolvedEffort: (m: string, t: ZenTier, p: ZenProtocol) => string;
  },
): string[] {
  if (deps.forcedEffort(model) === 'auto') {
    const resolved = deps.resolvedEffort(model, tier, protocol);
    const index = REASONING_LEVELS.findIndex((level) => level === resolved);
    if (index >= 0) return REASONING_LEVELS.slice(0, index + 1);
  }
  return [...REASONING_LEVELS];
}
