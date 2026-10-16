import { createServer } from 'node:http';
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
  waitForCode(): Promise<{ code: string; state: string }>;
  close(): void;
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

interface CallbackQuery {
  code: string;
  state: string;
}

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
      // 先验形状再看会话：畸形 state 不该有机会碰到会话存储。
      if (!code || !isValidState(state)) {
        res.writeHead(400, { ...PLAIN_TEXT, ...NO_KEEPALIVE });
        res.end('invalid callback');
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
    server.listen(opts.port, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : opts.port;
      timer = setTimeout(() => {
        abort(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      resolve({
        redirectUri: `http://localhost:${actualPort}${path}`,
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
