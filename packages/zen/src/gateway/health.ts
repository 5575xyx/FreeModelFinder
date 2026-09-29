export interface ZenProxyHealth {
  healthy: boolean;
}

export interface ZenCooldownFields {
  failures: number;
  cooldownUntil: number;
}

const MAX_FAILURE_SHIFT = 3;

const RETRYABLE_STATUSES = new Set([401, 403, 429]);

export function healthyProxy(): ZenProxyHealth {
  return { healthy: true };
}

export function proxyHealthy(health: ZenProxyHealth): boolean {
  return health.healthy;
}

export function setProxyHealthy(health: ZenProxyHealth, healthy: boolean): boolean {
  const previous = health.healthy;
  health.healthy = healthy;
  return previous;
}

export function cooldownDelayMs(baseMs: number, failures: number, retryAfterMs = 0): number {
  const shift = Math.min(Math.max(failures - 1, 0), MAX_FAILURE_SHIFT);
  const delay = baseMs * 2 ** shift;
  return retryAfterMs > delay ? retryAfterMs : delay;
}

export function maxCooldownMs(baseMs: number): number {
  return cooldownDelayMs(baseMs, MAX_FAILURE_SHIFT + 1);
}

export function parseRetryAfter(value: string | undefined, nowMs: number = Date.now()): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds > 0 ? seconds * 1000 : 0;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return 0;
  return Math.max(when - nowMs, 0);
}

export function cooldownActive(state: ZenCooldownFields, nowMs: number): boolean {
  return state.cooldownUntil > nowMs;
}

export function resetCooldown(state: ZenCooldownFields): void {
  state.failures = 0;
  state.cooldownUntil = 0;
}

export function applyCooldown(
  state: ZenCooldownFields,
  baseMs: number,
  retryAfterMs = 0,
  nowMs: number = Date.now(),
): number {
  state.failures += 1;
  state.cooldownUntil = nowMs + cooldownDelayMs(baseMs, state.failures, retryAfterMs);
  return state.cooldownUntil;
}

export function shouldCooldown(status: number | undefined, error: unknown): boolean {
  if (error === undefined || error === null) {
    if (status === undefined) return true;
    return RETRYABLE_STATUSES.has(status) || status >= 500;
  }
  return true;
}
