const EXPIRY_MS_THRESHOLD = 1e12;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * 把 fetch 的失败描述成一句人能用的错误。
 *
 * undici 的网络层失败一律抛泛泛的 `TypeError: fetch failed`，真正可行动的信息（DNS 失败 /
 * 连接超时 / 证书错误 / 代理拒绝）藏在 `cause` 里。真实账号验收时卡在这一层的概率最高
 * —— 目标域名被墙、需要代理、DNS 污染都会走到这里 —— 只报 `fetch failed` 等于什么都没说。
 *
 * 说明：调用方最终会经过 `redact()`，且 undici 的 cause 文本只有主机名与超时信息，不含凭据。
 */
export function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
  if (typeof cause === 'string' && cause.length > 0) return `${error.message}: ${cause}`;
  return error.message;
}

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
 * 跨调用方共享的单飞缓存（模块级）。
 *
 * 轮换型 OAuth 下，同一个 refresh_token 被并发发送两次会被上游判为
 * `refresh_token_reused` / `invalid_grant`，账号直接报废。provider 内部的强刷与 server 的
 * 手动刷新接口若各用各的缓存，"用户点刷新 + 一次请求触发后台刷新"就能撞上同一次轮换，
 * 因此两者必须共用这一把锁。
 *
 * 每次调用前都应重新读取运行时池里的最新账号副本：单飞只对**在途**刷新去重，settled 后
 * key 立即剔除，若之后仍拿旧对象里的 refresh token 去刷，同样会二次消费。
 */
const sharedFlights = new Map<string, Promise<unknown>>();

/** 单飞 key 统一为 `${provider}:${accountId}`，保证 provider 与 server 路由命中同一条目。 */
export function subscriptionFlightKey(provider: string, accountId: string): string {
  return `${provider}:${accountId}`;
}

export function runSharedFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = sharedFlights.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fn().finally(() => {
    sharedFlights.delete(key);
  });
  sharedFlights.set(key, promise);
  return promise as Promise<T>;
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
