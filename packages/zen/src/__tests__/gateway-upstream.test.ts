import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { ZenHttpClient, ZenHttpRequest, ZenHttpResponse } from '../http.js';
import { proxyHealthy, setProxyHealthy } from '../gateway/health.js';
import { ZenAttemptMonitor } from '../gateway/monitor.js';
import { ZenAnonymousPool, ZenKeyPool } from '../gateway/pool.js';
import {
  checkHealth,
  doUpstream,
  doUpstreamStream,
  isNonRetryableClientResponse,
  type ZenUpstreamOptions,
} from '../gateway/upstream.js';
import type { ZenRoute } from '../models/types.js';
import { parseProxyList } from '../proxy/spec.js';
import type { ZenRequest } from '../protocol/types.js';

function response(
  status: number,
  body: string,
  headers: IncomingHttpHeaders = {},
): ZenHttpResponse {
  const stream = Readable.from([Buffer.from(body)]);
  return { status, headers, body: stream as unknown as IncomingMessage };
}

async function readAll(stream: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

type Handler = (
  request: ZenHttpRequest,
  index: number,
) => ZenHttpResponse | Promise<ZenHttpResponse>;

class FakeClient implements ZenHttpClient {
  readonly requests: ZenHttpRequest[] = [];

  constructor(private readonly handler: Handler) {}

  async send(request: ZenHttpRequest): Promise<ZenHttpResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    return this.handler(request, index);
  }
}

const proxies = parseProxyList(['direct', 'http://127.0.0.1:7890'], '');

function anonymousRoute(overrides: Partial<ZenRoute> = {}): ZenRoute {
  return {
    id: 'm',
    tier: 'zen',
    protocol: 'chat',
    protocols: { zen: 'chat' },
    anonymous: true,
    keyTiers: ['zen'],
    ...overrides,
  };
}

function zenKeyRoute(overrides: Partial<ZenRoute> = {}): ZenRoute {
  return {
    id: 'm',
    tier: 'zen',
    protocol: 'chat',
    protocols: { zen: 'chat' },
    anonymous: false,
    keyTiers: ['zen'],
    ...overrides,
  };
}

function makeOptions(
  client: ZenHttpClient,
  extras: Partial<ZenUpstreamOptions> = {},
): ZenUpstreamOptions {
  return {
    pools: {
      zen: new ZenKeyPool(['k1', 'k2'], proxies, client, {
        cooldownBaseMs: 60_000,
        maxAttempts: 3,
      }),
      go: new ZenKeyPool(['g1', 'g2'], proxies, client, {
        cooldownBaseMs: 60_000,
        maxAttempts: 3,
      }),
    },
    anonymousPool: new ZenAnonymousPool(proxies, client),
    monitor: new ZenAttemptMonitor(),
    retry: { maxAttempts: 3 },
    upstream: { zen: 'https://zen.test', go: 'https://go.test' },
    ...extras,
  };
}

const request: ZenRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const ids = { request: 'req_1', session: 'sess_a' };

describe('zen upstream execution', () => {
  it('uses an anonymous proxy and records one successful anonymous attempt', async () => {
    const client = new FakeClient(() => response(200, '{"ok":true}'));
    const options = makeOptions(client);
    const result = await doUpstream(options, anonymousRoute(), request, ids);
    assert.equal(result.response?.status, 200);
    assert.equal(result.effectiveRoute.tier, 'zen');
    assert.equal(result.attempts, 1);
    const records = options.monitor!.list();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.channel, 'anonymous');
    assert.equal(records[0]!.anonymous, true);
    assert.equal(records[0]!.success, true);
    assert.equal(records[0]!.outcome, 'success');
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0]!.headers!['authorization'], 'Bearer public');
  });

  it('applies the forced reasoning effort to the anonymous body', async () => {
    const client = new FakeClient(() => response(200, '{}'));
    const options = makeOptions(client, { reasoning: { effort: 'high' } });
    const result = await doUpstream(options, anonymousRoute(), request, ids);
    assert.equal(result.response?.status, 200);
    const body = JSON.parse(client.requests[0]!.body!) as Record<string, unknown>;
    assert.equal(body['reasoning_effort'], 'high');
    assert.equal(body['stream'], true);
  });

  it('moves to the next anonymous proxy after a 403', async () => {
    const client = new FakeClient((_req, index) =>
      index === 0 ? response(403, '{"error":{"message":"FreeTierError"}}') : response(200, '{}'),
    );
    const options = makeOptions(client);
    const result = await doUpstream(options, anonymousRoute(), request, ids);
    assert.equal(result.response?.status, 200);
    assert.equal(result.attempts, 2);
    assert.equal(client.requests.length, 2);
    const records = options.monitor!.list();
    assert.equal(records.length, 2);
    assert.equal(records[0]!.success, false);
    assert.equal(records[1]!.success, true);
    assert.ok(records.every((record) => record.channel === 'anonymous'));
  });

  it('falls back to a key tier after every anonymous proxy fails', async () => {
    const client = new FakeClient((req) =>
      req.headers!['authorization'] === 'Bearer public'
        ? response(403, '{"error":{"message":"FreeTierError"}}')
        : response(200, '{}'),
    );
    const options = makeOptions(client);
    const result = await doUpstream(options, anonymousRoute(), request, ids);
    assert.equal(result.response?.status, 200);
    assert.equal(result.attempts, 3);
    assert.equal(result.effectiveRoute.anonymous, false);
    assert.equal(result.effectiveRoute.tier, 'zen');
    const records = options.monitor!.list();
    assert.deepEqual(
      records.map((record) => record.channel),
      ['anonymous', 'anonymous', 'key'],
    );
    assert.equal(records[2]!.success, true);
  });

  it('tries key tiers in prefer order and stops rotating a tier after a 4xx', async () => {
    const client = new FakeClient((req) => {
      if (req.url.startsWith('https://go.test')) {
        return response(400, '{"error":{"message":"invalid_request"}}');
      }
      return response(200, '{}');
    });
    const options = makeOptions(client, { retry: { maxAttempts: 3 } });
    const route: ZenRoute = {
      id: 'm',
      tier: 'go',
      protocol: 'chat',
      protocols: { go: 'chat', zen: 'chat' },
      anonymous: false,
      keyTiers: ['go', 'zen'],
    };
    const result = await doUpstream(options, route, request, ids);
    assert.equal(result.response?.status, 200);
    assert.equal(result.effectiveRoute.tier, 'zen');
    assert.equal(result.attempts, 2);
    assert.deepEqual(
      options.monitor!.list().map((record) => record.tier),
      ['go', 'zen'],
    );
  });

  it('rotates keys inside a tier up to retry.maxAttempts', async () => {
    const client = new FakeClient((_req, index) =>
      index === 0 ? response(500, '{}') : response(200, '{}'),
    );
    const options = makeOptions(client, { retry: { maxAttempts: 2 } });
    const result = await doUpstream(options, zenKeyRoute(), request, ids);
    assert.equal(result.response?.status, 200);
    assert.equal(result.attempts, 2);
    assert.equal(client.requests.length, 2);
    assert.ok(options.monitor!.list().every((record) => record.channel === 'key'));
  });

  it('does not rotate keys after a non-retryable 4xx response', async () => {
    const client = new FakeClient(() => response(400, '{"error":{"message":"invalid_request"}}'));
    const options = makeOptions(client);
    const result = await doUpstream(options, zenKeyRoute(), request, ids);
    assert.equal(result.response?.status, 400);
    assert.equal(result.attempts, 1);
    assert.equal(client.requests.length, 1);
    assert.equal(options.monitor!.list()[0]!.outcome, 'rejected');
  });

  it('strips stale reasoning references and replays once for responses', async () => {
    const client = new FakeClient((_req, index) =>
      index === 0
        ? response(
            400,
            '{"error":{"message":"Referenced reasoning item rs_1 was not found or has expired"}}',
          )
        : response(200, '{"id":"resp_2","output":[]}'),
    );
    const options = makeOptions(client);
    const route = zenKeyRoute({
      protocol: 'responses',
      protocols: { zen: 'responses' },
    });
    const responsesRequest: ZenRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      raw: {
        model: 'm',
        previous_response_id: 'resp_1',
        input: [
          { type: 'reasoning', id: 'rs_1' },
          { type: 'message', role: 'user', content: 'hi' },
        ],
      },
    };
    const result = await doUpstream(options, route, responsesRequest, ids);
    assert.equal(result.response?.status, 200);
    assert.equal(result.attempts, 2);
    assert.equal(client.requests.length, 2);
    const first = JSON.parse(client.requests[0]!.body!) as Record<string, unknown>;
    assert.equal(first['previous_response_id'], 'resp_1');
    const second = JSON.parse(client.requests[1]!.body!) as Record<string, unknown>;
    assert.equal('previous_response_id' in second, false);
    assert.deepEqual(second['input'], [{ type: 'message', role: 'user', content: 'hi' }]);
  });

  it('does not replay stripped reasoning for a non-responses protocol', async () => {
    const client = new FakeClient((_req, index) =>
      index === 0
        ? response(400, '{"error":{"message":"reasoning item was not found"}}')
        : response(200, '{}'),
    );
    const options = makeOptions(client);
    const raw = {
      model: 'm',
      previous_response_id: 'resp_1',
      input: [{ type: 'reasoning', id: 'rs_1' }],
    };
    const result = await doUpstream(
      options,
      zenKeyRoute(),
      { ...request, raw, rawProtocol: 'openai' },
      ids,
    );
    assert.equal(result.response?.status, 400);
    assert.equal(client.requests.length, 1);
  });

  it('stops without touching nodes when the request is already aborted', async () => {
    const client = new FakeClient(() => {
      throw new Error('should not be sent');
    });
    const options = makeOptions(client);
    const signal = AbortSignal.abort();
    const result = await doUpstream(options, zenKeyRoute(), request, { ...ids, signal });
    assert.equal(result.response, undefined);
    assert.ok(result.error !== undefined);
    assert.equal(client.requests.length, 0);
    assert.equal(options.monitor!.list().length, 0);
    assert.ok(options.pools.zen!.all().every((node) => node.cooldownUntil === 0));
    assert.ok(options.pools.go!.all().every((node) => node.cooldownUntil === 0));
  });

  it('records no attempt when the request is aborted while in flight', async () => {
    const controller = new AbortController();
    const client = new FakeClient(() => {
      controller.abort();
      throw new Error('aborted');
    });
    const options = makeOptions(client);
    const result = await doUpstream(options, zenKeyRoute(), request, {
      ...ids,
      signal: controller.signal,
    });
    assert.equal(client.requests.length, 1);
    assert.equal(options.monitor!.list().length, 0);
    assert.ok(options.pools.zen!.all().every((node) => node.cooldownUntil === 0));
    assert.ok(result.error !== undefined);
  });

  it('returns the underlying stream body on a successful streamed attempt', async () => {
    const client = new FakeClient(() =>
      response(200, 'data: {"ok":true}\n\n', { 'content-type': 'text/event-stream' }),
    );
    const options = makeOptions(client);
    const streamed = await doUpstreamStream(options, anonymousRoute(), request, ids);
    assert.equal(streamed.status, 200);
    assert.equal(streamed.effectiveRoute.tier, 'zen');
    assert.equal(await readAll(streamed.body), 'data: {"ok":true}\n\n');
  });
});

describe('zen upstream error classification', () => {
  it('treats 4xx except auth/throttle as non-retryable', () => {
    assert.equal(isNonRetryableClientResponse(400), true);
    assert.equal(isNonRetryableClientResponse(404), true);
    assert.equal(isNonRetryableClientResponse(401), false);
    assert.equal(isNonRetryableClientResponse(403), false);
    assert.equal(isNonRetryableClientResponse(429), false);
    assert.equal(isNonRetryableClientResponse(500), false);
    assert.equal(isNonRetryableClientResponse(400, new Error('boom')), false);
    assert.equal(isNonRetryableClientResponse(undefined), false);
  });
});

describe('zen proxy health checks', () => {
  it('rechecks only unhealthy proxies and restores a reachable one', async () => {
    const client = new FakeClient(() => response(204, ''));
    const options = makeOptions(client);
    const pool = options.anonymousPool!;
    const proxy = pool.nodes()[0]!.proxy;
    setProxyHealthy(proxy.health, false);
    const results = await checkHealth(
      pool.nodes().map((node) => node.proxy),
      'https://check.test/trace',
      1_000,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]!.failed, false);
    assert.equal(results[0]!.wasHealthy, false);
    assert.equal(proxyHealthy(proxy.health), true);
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0]!.method, 'GET');
  });
});
