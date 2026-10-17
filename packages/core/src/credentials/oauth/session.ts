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
  /**
   * 这家是否已有 pending 会话。
   *
   * 路由层必须先问这个再申请本机端口：codex/claude 的回调端口被官方应用注册死
   * （1455/54545），先起监听的话，第二次点击只会撞 EADDRINUSE（500），
   * 永远走不到"同家已有会话"的 409 分支。
   */
  hasPending(provider: SubscriptionProviderId): boolean;
  get(state: string): OAuthSessionRecord | undefined;
  isPending(state: string): boolean;
  complete(state: string): void;
  fail(state: string, error: string): void;
  /** 取消还 pending 的会话；已完成/已失败/未知的返回 false（记录保留，UI 仍能读最终结果）。 */
  cancel(state: string): boolean;
  /** 由调用方驱动（模块内不起定时器，避免测试期悬挂句柄）：超时的标错、结束的回收。 */
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
    hasPending: (provider) => findPending(provider) !== undefined,
    isPending: (state) => sessions.get(state)?.status === 'wait',
    complete: (state) => setStatus(state, 'ok'),
    fail: (state, error) => setStatus(state, 'error', error),
    // 只有还 pending 的才谈得上"取消"：对齐参考项目 CancelAuthSession
    //（对已完成/已失败的会话返回 false 且保留记录，UI 才能继续读到最终结果）。
    cancel(state) {
      const record = sessions.get(state);
      if (!record || record.status !== 'wait') return false;
      sessions.delete(state);
      return true;
    },
    sweep(now = Date.now()) {
      for (const [state, record] of sessions) {
        if (now - record.createdAt <= OAUTH_SESSION_TTL_MS) continue;
        // 还在等的标记超时（UI 靠这个 `timeout` 记号显示本地化文案）；
        // 已经结束的则直接回收，避免 Map 随每次登录单调增长。
        if (record.status === 'wait') setStatus(state, 'error', 'timeout');
        else sessions.delete(state);
      }
    },
  };
}
