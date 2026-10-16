import { generateState } from './state.js';
import type { OAuthSessionRecord, SubscriptionProviderId } from './types.js';

/** 会话存活窗口；超时后即使回调才到达，也不再落账号。 */
export const OAUTH_SESSION_TTL_MS = 10 * 60_000;

/**
 * 同一家 provider 同时只允许一个 pending 会话。
 *
 * 这不只是"防重复点击"：Codex / Claude 的回调端口被官方 OAuth 应用注册死
 * （1455 / 54545），两个并发会话必然抢同一个 listener，所以这里必须拒绝而非排队。
 */
export class OAuthSessionBusyError extends Error {
  readonly provider: SubscriptionProviderId;

  constructor(provider: SubscriptionProviderId) {
    super(`an OAuth session for ${provider} is already pending`);
    this.name = 'OAuthSessionBusyError';
    this.provider = provider;
  }
}

export interface OAuthSessionStore {
  /** 返回新会话的 state；同 provider 已有 pending 会话时抛 OAuthSessionBusyError。 */
  begin(provider: SubscriptionProviderId, redirectUri: string, verifier?: string): string;
  get(state: string): OAuthSessionRecord | undefined;
  isPending(state: string): boolean;
  complete(state: string): void;
  fail(state: string, error: string): void;
  /** 删除会话；返回是否真的存在过。 */
  cancel(state: string): boolean;
  /** 由调用方驱动（模块内不起定时器，避免测试期悬挂句柄）。 */
  sweep(now?: number): void;
}

export function createOAuthSessionStore(): OAuthSessionStore {
  const sessions = new Map<string, OAuthSessionRecord>();

  function findPending(provider: SubscriptionProviderId): string | undefined {
    for (const [state, record] of sessions) {
      if (record.provider === provider && record.status === 'wait') return state;
    }
    return undefined;
  }

  function setStatus(state: string, status: 'ok' | 'error', error?: string): void {
    const record = sessions.get(state);
    if (!record) return;
    sessions.set(state, error === undefined ? { ...record, status } : { ...record, status, error });
  }

  return {
    begin(provider, redirectUri, verifier) {
      if (findPending(provider) !== undefined) {
        throw new OAuthSessionBusyError(provider);
      }
      const state = generateState();
      sessions.set(state, {
        provider,
        status: 'wait',
        redirectUri,
        createdAt: Date.now(),
        ...(verifier === undefined ? {} : { verifier }),
      });
      return state;
    },
    get: (state) => sessions.get(state),
    isPending: (state) => sessions.get(state)?.status === 'wait',
    complete: (state) => setStatus(state, 'ok'),
    fail: (state, error) => setStatus(state, 'error', error),
    // 取消即删除：迟到的回调查不到 pending 会话，自然不落账号
    //（对齐参考项目 CancelAuthSession 的语义）。
    cancel: (state) => sessions.delete(state),
    sweep(now = Date.now()) {
      for (const [state, record] of sessions) {
        if (record.status !== 'wait') continue;
        if (now - record.createdAt > OAUTH_SESSION_TTL_MS) {
          setStatus(state, 'error', 'timeout');
        }
      }
    },
  };
}
