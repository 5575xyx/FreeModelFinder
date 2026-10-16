import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

describe('gateway authentication boundary', () => {
  let app: FastifyInstance;

  before(async () => {
    const config: AppConfig = {
      version: 1,
      port: 11435,
      providers: {},
      gateway: {
        apiKey: 'fmf-test-key',
        requireAuth: true,
      },
    };
    ({ app } = await createServer({
      registry: new ProviderRegistry(config),
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app.close();
  });

  it('does not trust a spoofed UI header without a browser origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'x-fmf-client': 'ui' },
    });

    assert.equal(response.statusCode, 401);
  });

  it('trusts the UI header only from a local browser origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        origin: 'http://localhost:3000',
        'x-fmf-client': 'ui',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:3000');
  });

  it('accepts the configured gateway key for non-browser clients', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer fmf-test-key' },
    });

    assert.equal(response.statusCode, 200);
  });

  it('accepts protocol-specific API-key headers', async () => {
    const anthropicStyle = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'x-api-key': 'fmf-test-key' },
    });
    const geminiStyle = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'x-goog-api-key': 'fmf-test-key' },
    });
    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Basic not-a-bearer-token' },
    });
    assert.equal(anthropicStyle.statusCode, 200);
    assert.equal(geminiStyle.statusCode, 200);
    assert.equal(invalid.statusCode, 401);
  });

  it('trusts loopback referers and Tauri origins but rejects remote or public UI requests', async () => {
    const referer = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { referer: 'http://127.0.0.1:11435/' },
    });
    const tauri = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { origin: 'tauri://localhost', 'x-fmf-client': 'ui' },
    });
    const publicUi = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { origin: 'https://example.com', 'x-fmf-client': 'ui' },
    });
    const remote = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { origin: 'http://127.0.0.1:11435', 'x-fmf-client': 'ui' },
      remoteAddress: '192.0.2.10',
    });
    assert.equal(referer.statusCode, 200);
    assert.equal(tauri.statusCode, 200);
    assert.equal(publicUi.statusCode, 401);
    assert.equal(remote.statusCode, 401);
  });

  it('advertises the write methods the dashboard actually uses in the CORS preflight', async () => {
    // @fastify/cors 的默认 methods 只有 GET,HEAD,POST。本仓库的 dashboard 还会发
    // DELETE（取消 OAuth 会话 / 移除订阅账号）与 PUT/PATCH（switch-project 开关）。
    // 少了任何一个，浏览器都会在预检阶段就把请求拦掉 —— 真实浏览器里表现为"点了没反应"，
    // 而 app.inject 测试不过预检，所以只有这条用例能守住它。
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/subscription/oauth/session?state=x',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'x-fmf-client',
      },
    });

    assert.equal(response.statusCode, 204);
    const allowed = String(response.headers['access-control-allow-methods'] ?? '')
      .split(',')
      .map((method) => method.trim().toUpperCase());
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.ok(
        allowed.includes(method),
        `preflight must allow ${method}, got: ${allowed.join(',')}`,
      );
    }
  });

  it('does not grant CORS access to public web origins', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://example.com' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);

    const malformed = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'not a valid origin' },
    });
    assert.equal(malformed.headers['access-control-allow-origin'], undefined);
  });
});
