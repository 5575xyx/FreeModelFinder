export interface RetryOnQueueFullOptions {
  /** Total attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Base backoff delay in ms before the second try. Default 3000. */
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const QUEUE_FULL_PATTERNS = [/failed\s+503\b/i, /queue[_\s-]*full/i, /队列已满/] as const;

export function isQueueFullError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return QUEUE_FULL_PATTERNS.some((re) => re.test(message));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Retry transient Agnes-style "queue full" 503 failures with exponential
 * backoff. Non-queue errors are rethrown immediately without retrying.
 */
export async function retryOnQueueFull<T>(
  fn: () => Promise<T>,
  options: RetryOnQueueFullOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 3000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isQueueFullError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}
