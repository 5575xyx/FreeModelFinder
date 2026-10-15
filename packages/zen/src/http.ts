import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ATTEMPT_TIMEOUT_CODE, PhasedError, type AttemptPhase } from './gateway/first-event.js';
import type { ProxySpec } from './proxy/spec.js';

export interface ZenHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  proxy: ProxySpec;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  /**
   * Hard budget for the whole attempt, measured up to and including response
   * headers. Once the headers arrive it is disarmed and the body is bounded
   * only by the caller's request-level signal, so a healthy but slow model is
   * not cut off mid-stream (#64).
   */
  attemptTimeoutMs?: number;
  /**
   * Inactivity budget for an already connected socket, measured from response
   * headers to the first body byte. Defaults well above connectTimeoutMs so a
   * model that spends seconds thinking is not mistaken for a dead connection.
   */
  firstByteTimeoutMs?: number;
}

export interface ZenHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
  /**
   * Response headers reached the client, so the attempt deadline has been
   * disarmed and the body now belongs to the caller's request-level budget.
   * Always true for a resolved response; a request that never reached its
   * headers rejects instead of resolving.
   */
  committed: boolean;
}

export interface ZenHttpClient {
  send(request: ZenHttpRequest): Promise<ZenHttpResponse>;
}

export const FIRST_BYTE_TIMEOUT_MS = 30_000;

export function resolveAgent(proxy: ProxySpec, targetUrl: string): Agent | undefined {
  if (proxy.kind === 'direct') return undefined;
  if (proxy.kind === 'socks5' || proxy.kind === 'socks5h') {
    return new SocksProxyAgent(proxy.url);
  }
  if (targetUrl.startsWith('https:') || proxy.kind === 'https') {
    return new HttpsProxyAgent(proxy.url);
  }
  return new HttpProxyAgent(proxy.url);
}

export function createNodeHttpClient(): ZenHttpClient {
  const cache = new Map<string, Agent>();

  const agentFor = (proxy: ProxySpec, targetUrl: string): Agent | undefined => {
    if (proxy.kind === 'direct') return undefined;
    const target = targetUrl.startsWith('https:') ? 'https' : 'http';
    const key = `${proxy.kind}\u0000${proxy.url}\u0000${target}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const agent = resolveAgent(proxy, targetUrl);
    if (agent) cache.set(key, agent);
    return agent;
  };

  return {
    send(request) {
      return new Promise<ZenHttpResponse>((resolve, reject) => {
        const url = new URL(request.url);
        const transport = url.protocol === 'https:' ? https : http;
        // How far this attempt got before it died. Go reads these from
        // httptrace; Node exposes only coarse socket / request events, so each
        // boundary is an approximation. Only 'first_event' is set by callers,
        // after they have read the model's first SSE event.
        let phase: AttemptPhase = 'dial';
        let attemptTimer: ReturnType<typeof setTimeout> | undefined;
        const disarmAttemptDeadline = (): void => {
          if (attemptTimer === undefined) return;
          clearTimeout(attemptTimer);
          attemptTimer = undefined;
        };
        const signals: AbortSignal[] = [];
        if (request.signal) signals.push(request.signal);
        const signal =
          signals.length === 0
            ? undefined
            : signals.length === 1
              ? signals[0]
              : AbortSignal.any(signals);
        const connectMs = request.connectTimeoutMs ?? 0;
        const firstByteMs = request.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
        const req = transport.request(
          url,
          {
            method: request.method,
            headers: request.headers,
            agent: agentFor(request.proxy, request.url),
            signal,
          },
          (response) => {
            // Headers are in: the attempt deadline no longer applies. Keeping it
            // armed (the old AbortSignal.timeout behaviour) would destroy a
            // healthy stream the moment its model finished slow.
            disarmAttemptDeadline();
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: response,
              committed: true,
            });
          },
        );
        const attemptMs = request.attemptTimeoutMs ?? 0;
        if (attemptMs > 0) {
          attemptTimer = setTimeout(() => {
            attemptTimer = undefined;
            if (req.destroyed) return;
            req.destroy(
              Object.assign(new Error(`upstream attempt timed out after ${attemptMs}ms`), {
                name: 'TimeoutError',
                code: ATTEMPT_TIMEOUT_CODE,
              }),
            );
          }, attemptMs);
        }
        let connected = false;
        const fail = (): void => {
          if (req.destroyed) return;
          req.destroy(
            connected
              ? new Error(`upstream first byte timeout after ${firstByteMs}ms`)
              : new Error(`upstream connect timeout after ${connectMs}ms`),
          );
        };
        if (connectMs > 0) {
          // One timer, one callback, re-armed as the request progresses: Node
          // fires req.setTimeout on socket inactivity, so arming a second
          // callback on the same socket would let whichever registered first
          // win. The Go reference only wraps the dialer, so the window widens
          // once the socket is up: a model may spend seconds thinking before
          // its first byte, which is not a connection failure.
          req.setTimeout(connectMs, fail);
        }
        req.on('socket', (socket) => {
          socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
            if (phase === 'dial') phase = 'write';
            connected = true;
            if (connectMs > 0) req.setTimeout(firstByteMs, fail);
          });
        });
        // Once the request bytes are flushed, the wait is on response headers.
        req.on('finish', () => {
          if (phase === 'write') phase = 'headers';
        });
        req.on('error', (error) => {
          disarmAttemptDeadline();
          if ((error as { code?: unknown }).code === ATTEMPT_TIMEOUT_CODE) {
            reject(new PhasedError(phase, error));
            return;
          }
          reject(error);
        });
        if (request.body !== undefined) req.write(request.body);
        req.end();
      });
    },
  };
}
