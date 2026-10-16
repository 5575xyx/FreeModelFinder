import { createServer } from 'node:http';
import { redact } from '../redact.js';
import { OAUTH_SESSION_TTL_MS } from './session.js';
import { isValidState } from './state.js';

export interface LoopbackListenerOptions {
  /** 0 = 由 OS 分配端口（Google 用这个；Codex/Claude 的端口被官方应用注册死）。 */
  port: number;
  /** 例如 '/auth/callback'。 */
  path: string;
  /** 默认 OAUTH_SESSION_TTL_MS。 */
  timeoutMs?: number;
}

export interface LoopbackCallback {
  /** 'http://localhost:<port><path>'，即要写进 OAuth authorize 请求的 redirect_uri。 */
  redirectUri: string;
  /**
   * 只接受这个 `state` 的回调。
   *
   * 不设的话，本机**任何进程**（以及局域网，见下）都能往这个端口投一个形状合法
   * 但 state 不对的回调，把正在等待的会话直接打挂 —— 而它本来只是在等真实回调。
   * 设好之后不匹配的投递回 400，**不消耗**本次监听，真实回调仍能进来。
   */
  expectCallbackFor(state: string): void;
  waitForCode(): Promise<CallbackQuery>;
  close(): void;
}

/** 回调里携带的信息。provider 明确拒绝时没有 code，只有 error。 */
export interface CallbackQuery {
  code: string;
  state: string;
  /** provider 回的失败原因（`access_denied` 等）；成功时为 undefined。 */
  error?: string;
}

/**
 * 端口被别的进程占着。
 *
 * 这是用户最容易撞上的失败：官方 CLI 常常也在监听 1455 / 54545。
 * 单独一个错误类型是为了让路由层能把它翻译成"端口被占用，请先关掉 XXX"。
 */
export class LoopbackPortBusyError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(`loopback port ${port} is already in use`);
    this.name = 'LoopbackPortBusyError';
    this.port = port;
  }
}

/**
 * 回调没等到就超时了。
 *
 * 单独一个类型是为了让路由层能把原因归一成固定的 `timeout` 记号 —— UI 靠它显示
 * 本地化文案，而不是把这句英文原文糊到屏幕上。
 */
export class OAuthCallbackTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`OAuth callback timed out after ${timeoutMs}ms`);
    this.name = 'OAuthCallbackTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 把会话失败原因归一成 UI 的固定词汇。
 *
 * UI（`describeOAuthError`）只认识 `timeout` / `session already pending` / `access_denied`
 * 这几个记号，其余一律原样展示（已 redact）。所以这里必须把可归一的先归一，
 * 否则用户看到的是 `OAuth callback timed out after 600000ms` 这种没法读的东西。
 */
export function normalizeOAuthFailure(error: unknown): string {
  if (error instanceof OAuthCallbackTimeoutError) return 'timeout';
  return redact(error instanceof Error ? error.message : String(error));
}

const SUCCESS_BODY =
  '<!doctype html><meta charset="utf-8"><title>FreeModelFinder</title>' +
  '<p>授权完成，可以关闭此页。</p>';

const PLAIN_TEXT = { 'content-type': 'text/plain; charset=utf-8' } as const;

/**
 * 一次性回调服务器绝不能留 keep-alive 连接。
 *
 * 回调端口是固定复用的（1455/54545/51121）：上一条连接若留在客户端连接池里，
 * 用户取消后重试时，新的请求会被这条连到**旧 server 实例**的连接接走，
 * 新会话就永远等不到回调（表现为一直转圈）。`Connection: close` 让 Node
 * 在响应后直接关掉这条 socket。
 */
const NO_KEEPALIVE = { connection: 'close' } as const;

/** provider 明确拒绝时，跳回来的页面要说明"没有授权成功"，而不是复用成功页。 */
const DENIED_BODY =
  '<!doctype html><meta charset="utf-8"><title>FreeModelFinder</title>' +
  '<p>授权未完成，可以关闭此页并回到 FreeModelFinder 重试。</p>';

/**
 * 起一个只服务一次回调的本机监听器。
 *
 * 生命周期：`listen` 成功 → 交出 `redirectUri` → 浏览器跳回来（或超时/被关）→
 * 无论走哪条路都必须关掉监听，否则端口不会释放，用户重新点"登录"会一直撞 EADDRINUSE。
 */
export function startLoopbackListener(opts: LoopbackListenerOptions): Promise<LoopbackCallback> {
  const timeoutMs = opts.timeoutMs ?? OAUTH_SESSION_TTL_MS;
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;

  return new Promise<LoopbackCallback>((resolve, reject) => {
    let delivered = false;
    let result: CallbackQuery | null = null;
    let failure: unknown = null;
    let expectedState: string | null = null;
    let waiter: {
      resolve: (value: CallbackQuery) => void;
      reject: (reason: unknown) => void;
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function shutdown(force: boolean): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (server.listening) server.close();
      // 只有确定没人在写响应时（超时 / 主动关闭）才强拆连接：deliver() 之后
      // 立刻强拆会把还没 flush 的回调页截断。
      if (force) server.closeAllConnections();
    }

    function deliver(value: CallbackQuery): void {
      if (delivered) return;
      delivered = true;
      result = value;
      const pending = waiter;
      waiter = null;
      shutdown(false);
      pending?.resolve(value);
    }

    function abort(error: unknown): void {
      if (delivered) return;
      delivered = true;
      failure = error;
      const pending = waiter;
      waiter = null;
      shutdown(true);
      pending?.reject(error);
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== path) {
        res.writeHead(404, { ...PLAIN_TEXT, ...NO_KEEPALIVE });
        res.end('not found');
        return;
      }
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const providerError = (
        url.searchParams.get('error') ??
        url.searchParams.get('error_description') ??
        ''
      ).trim();
      // 先验形状再看会话：畸形 state 不该有机会碰到会话存储。
      if (!code && !providerError) {
        res.writeHead(400, { ...PLAIN_TEXT, ...NO_KEEPALIVE });
        res.end('invalid callback');
        return;
      }
      if (!isValidState(state)) {
        res.writeHead(400, { ...PLAIN_TEXT, ...NO_KEEPALIVE });
        res.end('invalid callback');
        return;
      }
      // 不是本会话的 state：回 400 但**不收下、不关监听**。
      // 收下会把受害者会话打挂（本机任何进程都能投递，局域网也能，见 listen 处注释）；
      // 关监听则会让真实回调再也进不来。
      if (expectedState !== null && state !== expectedState) {
        res.writeHead(400, { ...PLAIN_TEXT, ...NO_KEEPALIVE });
        res.end('state does not match this session');
        return;
      }
      if (providerError) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...NO_KEEPALIVE });
        res.end(DENIED_BODY);
        deliver({ code: '', state, error: providerError });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...NO_KEEPALIVE });
      res.end(SUCCESS_BODY);
      deliver({ code, state });
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new LoopbackPortBusyError(opts.port));
        return;
      }
      reject(error);
    });

    // 不指定 host：Node 会绑到 IPv6 通配 `::`（双栈），localhost 解析到 ::1 还是 127.0.0.1 都能连上。
    // 参考项目也是绑 `:port`（Go 的 Addr: ":port"），但对外宣告的 redirect_uri 主机名固定是 localhost
    // —— 上游对 redirect_uri 做精确匹配，写成 127.0.0.1 会被直接拒绝。
    // ⚠️ 因此这个端口**不是仅本机可达**：局域网（乃至公网上没被防火墙挡住的机器）都能连到它。
    // 危害被两道门挡住：① 一次性、只活 10 分钟；② 内容必须带对 state 才会被收下。
    // 部署文档（docs/SERVER_MODE.md）要求端口映射只能绑宿主 127.0.0.1，绝不暴露到公网。
    server.listen(opts.port, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : opts.port;
      timer = setTimeout(() => {
        abort(new OAuthCallbackTimeoutError(timeoutMs));
      }, timeoutMs);
      // 服务关停时不能被这个 10 分钟定时器吊着不退出（测试里尤其明显）。
      timer.unref?.();
      resolve({
        redirectUri: `http://localhost:${actualPort}${path}`,
        expectCallbackFor(state) {
          expectedState = state;
        },
        waitForCode() {
          if (result !== null) return Promise.resolve(result);
          if (failure !== null) return Promise.reject(failure);
          return new Promise<CallbackQuery>((res, rej) => {
            waiter = { resolve: res, reject: rej };
          });
        },
        close() {
          abort(new Error('OAuth callback listener closed'));
        },
      });
    });
  });
}
