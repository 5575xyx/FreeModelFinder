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

export function resolveAgent(proxy: ProxySpec): Agent | undefined {
  switch (proxy.kind) {
    case 'direct':
      return undefined;
    case 'http':
      return new HttpProxyAgent(proxy.url as string);
    case 'https':
      return new HttpsProxyAgent(proxy.url as string);
    case 'socks5':
    case 'socks5h':
      return new SocksProxyAgent(proxy.url as string);
  }
}

export function createNodeHttpClient(): ZenHttpClient {
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
            agent: resolveAgent(request.proxy),
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
