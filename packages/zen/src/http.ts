import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { ProxySpec } from './proxy/spec.js';

export interface ZenHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  proxy: ProxySpec;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  attemptTimeoutMs?: number;
}

export interface ZenHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

export interface ZenHttpClient {
  send(request: ZenHttpRequest): Promise<ZenHttpResponse>;
}

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
        const signals: AbortSignal[] = [];
        if (request.signal) signals.push(request.signal);
        const attemptMs = request.attemptTimeoutMs ?? 0;
        if (attemptMs > 0) signals.push(AbortSignal.timeout(attemptMs));
        const signal =
          signals.length === 0
            ? undefined
            : signals.length === 1
              ? signals[0]
              : AbortSignal.any(signals);
        const connectMs = request.connectTimeoutMs ?? 0;
        const req = transport.request(
          url,
          {
            method: request.method,
            headers: request.headers,
            agent: agentFor(request.proxy, request.url),
            signal,
          },
          (response) => {
            if (connectMs > 0) req.setTimeout(0);
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: response,
            });
          },
        );
        if (connectMs > 0) {
          req.setTimeout(connectMs, () => {
            req.destroy(new Error(`upstream connect timeout after ${connectMs}ms`));
          });
        }
        req.on('error', reject);
        if (request.body !== undefined) req.write(request.body);
        req.end();
      });
    },
  };
}
