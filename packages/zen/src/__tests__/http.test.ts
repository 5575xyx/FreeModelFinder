import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { createNodeHttpClient, resolveAgent } from '../http.js';
import { parseProxy } from '../proxy/spec.js';

let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/hang') return;
      if (req.url === '/slow-headers') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }, 120);
        return;
      }
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        res.end('data: two\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

after(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
);

const direct = { kind: 'direct' as const, label: 'direct' };

describe('zen http client', () => {
  it('sends a POST and reads the JSON body', async () => {
    const client = createNodeHttpClient();
    const res = await client.send({
      url: `http://127.0.0.1:${port}/echo`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hi: 1 }),
      proxy: direct,
    });
    assert.equal(res.status, 200);
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(chunk as Buffer);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      method: 'POST',
      body: '{"hi":1}',
    });
  });

  it('streams an SSE body incrementally', async () => {
    const client = createNodeHttpClient();
    const res = await client.send({
      url: `http://127.0.0.1:${port}/stream`,
      method: 'GET',
      proxy: direct,
    });
    let text = '';
    for await (const chunk of res.body) text += String(chunk);
    assert.equal(text, 'data: one\n\ndata: two\n\n');
  });

  it('rejects when the request is aborted before the response', async () => {
    const client = createNodeHttpClient();
    const controller = new AbortController();
    const promise = client.send({
      url: `http://127.0.0.1:${port}/echo`,
      method: 'GET',
      proxy: direct,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(promise);
  });

  it('rejects when the per-attempt timeout elapses', async () => {
    const client = createNodeHttpClient();
    await assert.rejects(
      client.send({
        url: `http://127.0.0.1:${port}/hang`,
        method: 'GET',
        proxy: direct,
        attemptTimeoutMs: 30,
      }),
    );
  });

  it('rejects when the connect timeout elapses', async () => {
    const client = createNodeHttpClient();
    await assert.rejects(
      client.send({
        url: `http://127.0.0.1:${port}/hang`,
        method: 'GET',
        proxy: direct,
        connectTimeoutMs: 30,
      }),
    );
  });

  it('survives a slow first byte once the socket is connected', async () => {
    const client = createNodeHttpClient();
    const res = await client.send({
      url: `http://127.0.0.1:${port}/slow-headers`,
      method: 'GET',
      proxy: direct,
      connectTimeoutMs: 30,
    });
    assert.equal(res.status, 200);
    res.body.resume();
  });
  it('gives up on a connected peer that stays silent past the first byte window', async () => {
    const client = createNodeHttpClient();
    await assert.rejects(
      client.send({
        url: `http://127.0.0.1:${port}/hang`,
        method: 'GET',
        proxy: direct,
        connectTimeoutMs: 500,
        firstByteTimeoutMs: 30,
      }),
      /first byte timeout/i,
    );
  });

  it('selects an agent by target scheme and proxy kind', () => {
    assert.equal(resolveAgent(direct, 'https://opencode.ai'), undefined);
    assert.ok(
      resolveAgent(parseProxy('http://p:1')!, 'https://opencode.ai') instanceof HttpsProxyAgent,
    );
    assert.ok(resolveAgent(parseProxy('http://p:1')!, 'http://x') instanceof HttpProxyAgent);
    assert.ok(resolveAgent(parseProxy('https://p:1')!, 'http://x') instanceof HttpsProxyAgent);
    assert.ok(
      resolveAgent(parseProxy('socks5://p:1')!, 'https://opencode.ai') instanceof SocksProxyAgent,
    );
    assert.ok(
      resolveAgent(parseProxy('socks5h://p:1')!, 'https://opencode.ai') instanceof SocksProxyAgent,
    );
  });
});
