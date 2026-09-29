import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createNodeHttpClient, resolveAgent } from '../http.js';
import { parseProxy } from '../proxy/spec.js';

let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
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

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

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

  it('selects an agent per proxy kind and none for direct', () => {
    assert.equal(resolveAgent(direct), undefined);
    assert.ok(resolveAgent(parseProxy('http://127.0.0.1:7890')!));
    assert.ok(resolveAgent(parseProxy('https://127.0.0.1:7890')!));
    assert.ok(resolveAgent(parseProxy('socks5://127.0.0.1:1080')!));
    assert.ok(resolveAgent(parseProxy('socks5h://127.0.0.1:1080')!));
  });
});
