const EXPIRY_MS_THRESHOLD = 1e12;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * 飞行中请求去重：同一 key 并发调用共享同一 Promise，settled 后自动剔除以便重试。
 */
export function createFlightCache<T>(): {
  run(key: string, fn: () => Promise<T>): Promise<T>;
} {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = inflight.get(key);
      if (existing) return existing;
      const promise = fn().finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, promise);
      return promise;
    },
  };
}

/**
 * 解析过期时间为毫秒时间戳。
 * 空/非法 → now（视同过期，触发刷新）；>1e12 视为毫秒原样返回；<1e12 视为秒 ×1000；ISO 字符串走 Date.parse。
 */
export function parseExpiryMs(raw: string | undefined, now: number = Date.now()): number {
  const trimmed = raw?.trim();
  if (!trimmed) return now;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric >= EXPIRY_MS_THRESHOLD ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? now : parsed;
}

/**
 * base64url 解码 JWT 中段 payload（仅用于身份展示，不验签）。
 * 畸形 token 一律返回 null。
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const segment = parts[1];
  if (!segment || !BASE64URL_SEGMENT.test(segment)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
