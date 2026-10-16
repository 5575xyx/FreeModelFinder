import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  LoopbackPortBusyError,
  OAuthSessionBusyError,
  SUBSCRIPTION_ADAPTERS,
  SUBSCRIPTION_OAUTH,
  createOAuthSessionStore,
  generatePkce,
  isValidState,
  normalizeSubscriptionProvider,
  redact,
  startLoopbackListener,
  type LoopbackCallback,
  type ProviderRegistry,
  type SubscriptionProviderId,
} from '@freemodelfinder/core';
import { landSubscriptionAccount } from './subscription.js';

/** 浏览器侧的收尾页：只告知"可以关掉了"，不回声任何凭据。 */
const CALLBACK_SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>FreeModelFinder</title>' +
  '<p>授权完成，可以关闭此页。</p>';

interface CallbackPayload {
  code: string;
  state: string;
}

interface CallbackInput {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  redirect_url?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function html(reply: FastifyReply, status: number): FastifyReply {
  return reply.code(status).header('content-type', 'text/html; charset=utf-8');
}

/**
 * 从查询/表单里取出 code + state。
 *
 * 除了直接给 `code`/`state`，也支持参考项目那条 `redirect_url` 路径：用户把浏览器地址栏
 * 里那条"打不开"的回调整条粘进来，由服务端自己拆参数。provider 若回了 `error`，
 * 优先当作失败处理。
 */
function readCallback(input: CallbackInput): CallbackPayload & { error: string } {
  let code = (input.code ?? '').trim();
  let state = (input.state ?? '').trim();
  let error = (input.error ?? input.error_description ?? '').trim();
  const redirect = (input.redirect_url ?? '').trim();
  if (redirect) {
    try {
      const parsed = new URL(redirect);
      if (!state) state = (parsed.searchParams.get('state') ?? '').trim();
      if (!code) code = (parsed.searchParams.get('code') ?? '').trim();
      if (!error) {
        error = (
          parsed.searchParams.get('error') ??
          parsed.searchParams.get('error_description') ??
          ''
        ).trim();
      }
    } catch {
      error = 'invalid redirect_url';
    }
  }
  return { code, state, error };
}

/**
 * 订阅账号的 OAuth 交互登录端点（严格对齐参考项目 v8 的契约）。
 *
 * 与文件导入的关系：这里只负责"拿到一份可落库的凭据"，落库一定走
 * `landSubscriptionAccount`，即与 `POST /credentials` 完全同一条路径。
 */
export function registerSubscriptionOAuthRoutes(
  app: FastifyInstance,
  getRegistry: () => ProviderRegistry,
): void {
  const store = createOAuthSessionStore();
  /** state → 正在监听的回环服务器；取消时要主动关掉，否则端口不会释放。 */
  const listeners = new Map<string, LoopbackCallback>();
  /** state → `/oauth/callback` 端点的投递口（浏览器不回环时走这条路）。 */
  const waiters = new Map<string, (payload: CallbackPayload) => void>();

  /**
   * 会话收尾：等回调 → 换 token → 落账号。
   *
   * 所有"不该落账号"的路径都必须在这里被挡住：state 不匹配（CSRF / 过期标签页）、
   * 会话已被取消、会话已超时。缺一条就会写出"用户点了取消，账号却冒出来"这种 bug。
   */
  async function finishSession(
    provider: SubscriptionProviderId,
    state: string,
    listener: LoopbackCallback,
    verifier: string | undefined,
  ): Promise<void> {
    try {
      const callback = await Promise.race([
        listener.waitForCode(),
        new Promise<CallbackPayload>((resolve) => {
          waiters.set(state, resolve);
        }),
      ]);

      if (callback.state !== state) {
        store.fail(state, `state mismatch (expected the state this session was started with)`);
        return;
      }
      if (!store.isPending(state)) return;

      const parsed = await SUBSCRIPTION_ADAPTERS[provider].exchangeCode({
        code: callback.code,
        redirectUri: listener.redirectUri,
        ...(verifier === undefined ? {} : { verifier }),
        state,
      });
      // 换 token 是网络往返，期间用户可能已经取消
      if (!store.isPending(state)) return;
      await landSubscriptionAccount(provider, parsed, getRegistry);
      store.complete(state);
    } catch (error) {
      store.fail(state, redact(messageOf(error)));
    } finally {
      waiters.delete(state);
      listeners.delete(state);
      listener.close();
    }
  }

  app.get<{ Querystring: { provider?: string } }>(
    '/api/subscription/oauth/auth-url',
    async (req, reply) => {
      const raw = req.query.provider ?? '';
      if (!raw.trim()) {
        return reply.code(400).send({ status: 'error', error: 'provider is required' });
      }
      // 参考项目对 provider 查询参数做 ToLower(TrimSpace)；antigravity 是 google 的别名。
      const provider = normalizeSubscriptionProvider(raw);
      if (!provider) {
        return reply.code(400).send({ status: 'error', error: 'provider_not_found' });
      }
      // 必须先查会话再申请端口：codex/claude 的端口被官方应用注册死，先起监听的话
      // 第二次点击只会撞 EADDRINUSE（500），永远走不到"同家已有会话"的 409 分支。
      if (store.hasPending(provider)) {
        return reply.code(409).send({ status: 'error', error: 'session already pending' });
      }

      const cfg = SUBSCRIPTION_OAUTH[provider];
      let listener: LoopbackCallback;
      try {
        listener = await startLoopbackListener({ port: cfg.callbackPort, path: cfg.callbackPath });
      } catch (error) {
        if (error instanceof LoopbackPortBusyError) {
          return reply.code(500).send({
            status: 'error',
            error:
              `port ${error.port} is already in use; ` +
              'close whatever is listening on it (usually the official CLI) and retry',
          });
        }
        return reply.code(500).send({ status: 'error', error: redact(messageOf(error)) });
      }

      const verifier = cfg.usesPkce ? generatePkce().verifier : undefined;
      let state: string;
      try {
        state = store.begin(provider, listener.redirectUri, verifier);
      } catch (error) {
        listener.close();
        if (error instanceof OAuthSessionBusyError) {
          return reply.code(409).send({ status: 'error', error: 'session already pending' });
        }
        throw error;
      }

      listeners.set(state, listener);
      const url = SUBSCRIPTION_ADAPTERS[provider].buildAuthUrl({
        state,
        redirectUri: listener.redirectUri,
        ...(verifier === undefined ? {} : { verifier }),
      });

      // 后台等回调，不阻塞 auth-url 的响应。
      void finishSession(provider, state, listener, verifier);
      return reply.send({ status: 'ok', url, state });
    },
  );

  app.get<{ Querystring: { state?: string } }>(
    '/api/subscription/oauth/status',
    async (req, reply) => {
      const state = (req.query.state ?? '').trim();
      if (!isValidState(state)) {
        return reply.code(400).send({ status: 'error', error: 'invalid state' });
      }
      const record = store.get(state);
      if (!record) {
        return reply.send({ status: 'error', error: 'unknown or expired state' });
      }
      if (record.status === 'wait') return reply.send({ status: 'wait' });
      if (record.status === 'ok') return reply.send({ status: 'ok' });
      return reply.send({ status: 'error', error: record.error ?? 'unknown error' });
    },
  );

  app.delete<{ Querystring: { state?: string } }>(
    '/api/subscription/oauth/session',
    async (req, reply) => {
      const state = (req.query.state ?? '').trim();
      if (!state) {
        return reply.code(400).send({ status: 'error', error: 'missing state' });
      }
      if (!isValidState(state)) {
        return reply.code(400).send({ status: 'error', error: 'invalid state' });
      }
      const cancelled = store.cancel(state);
      // 取消即删会话（迟到的回调查不到 pending 会话，自然不会落账号），
      // 同时必须关掉监听，否则用户取消后重试会一直撞 EADDRINUSE。
      listeners.get(state)?.close();
      listeners.delete(state);
      return reply.send({ status: 'ok', cancelled });
    },
  );

  const callbackHandler = async (
    input: CallbackInput,
  ): Promise<{ ok: boolean; error?: string }> => {
    const { code, state, error } = readCallback(input);
    if (error === 'invalid redirect_url') return { ok: false, error };
    if (!isValidState(state)) return { ok: false, error: 'invalid state' };
    const waiter = waiters.get(state);
    if (!waiter || !store.isPending(state)) {
      return { ok: false, error: 'unknown or expired state' };
    }
    if (error) {
      // provider 明确回了失败：让会话带着原因收尾，别拿空 code 去换 token。
      store.fail(state, error);
      waiters.delete(state);
      listeners.get(state)?.close();
      listeners.delete(state);
      return { ok: false, error };
    }
    waiter({ code, state });
    return { ok: true };
  };

  app.get<{ Querystring: CallbackInput }>(
    '/api/subscription/oauth/callback',
    async (req, reply) => {
      const result = await callbackHandler(req.query);
      if (!result.ok) {
        return reply.code(400).send({ status: 'error', error: result.error });
      }
      return html(reply, 200).send(CALLBACK_SUCCESS_HTML);
    },
  );

  app.post<{ Querystring: CallbackInput; Body: CallbackInput }>(
    '/api/subscription/oauth/callback',
    async (req, reply) => {
      const result = await callbackHandler({ ...req.query, ...(req.body ?? {}) });
      if (!result.ok) {
        return reply.code(400).send({ status: 'error', error: result.error });
      }
      return html(reply, 200).send(CALLBACK_SUCCESS_HTML);
    },
  );
}
