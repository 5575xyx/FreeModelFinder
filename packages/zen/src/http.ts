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
        const req = transport.request(
          url,
          {
            method: request.method,
            headers: request.headers,
            agent: agentFor(request.proxy, request.url),
            signal: request.signal,
          },
          (response) => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: response,
            });
          },
        );
        req.on('error', reject);
        if (request.body !== undefined) req.write(request.body);
        req.end();
      });
    },
  };
}
