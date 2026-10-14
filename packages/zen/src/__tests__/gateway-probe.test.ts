import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { ZenAvailabilityStore } from '../models/availability.js';
import { ZenCatalog } from '../models/catalog.js';
import type { ZenHttpClient, ZenHttpRequest, ZenHttpResponse } from '../http.js';
import { ZenAnonymousPool, ZenKeyPool } from '../gateway/pool.js';
import {
  ZenAvailabilityChecker,
  isEffortRejection,
  isModelUnavailable,
  probeFreeModel,
  resolvedEffort,
  type ZenProbeResult,
} from '../gateway/probe.js';

const PROXIES = [{ kind: 'direct' as const, label: 'direct' }];
const NOW = 10_000_000;

function catalog(reasoning = true): ZenCatalog {
  const c = new ZenCatalog('zen', {});
  c.replace({
    zen: ['m-free'],
    go: [],
    native: { zen: { 'm-free': 'chat' }, go: {} },
    unsupported: { zen: {}, go: {} },
    metadata: { zen: { 'm-free': { reasoning } }, go: {} },
  });
  return c;
}

function inbound(
  status: number,
  body: string,
  headers: IncomingHttpHeaders = { 'content-type': 'application/json' },
): ZenHttpResponse {
  return {
    status,
    headers,
    body: Readable.from([Buffer.from(body)]) as unknown as IncomingMessage,
  };
}

function sseSuccess(): ZenHttpResponse {
  const frame = (delta: string, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: 'c1',
      model: 'm-free',
      created: 1,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: finish }],
    })}\n\n`;
  return inbound(200, `${frame('o', null)}${frame('', 'stop')}data: [DONE]\n\n`, {
    'content-type': 'text/event-stream',
  });
}

function sentBody(request: ZenHttpRequest): Record<string, unknown> {
  return JSON.parse(request.body ?? '{}') as Record<string, unknown>;
}

class ScriptedClient implements ZenHttpClient {
  readonly requests: ZenHttpRequest[] = [];

  constructor(private readonly respond: (request: ZenHttpRequest) => ZenHttpResponse) {}

  async send(request: ZenHttpRequest): Promise<ZenHttpResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

function probeOptions(
  client: ZenHttpClient,
  forcedEffort: (model: string) => string = () => '',
  anonymous = true,
  zenKeys: string[] = ['zk1'],
) {
  return {
    catalog: catalog(),
    availability: new ZenAvailabilityStore(),
    pools: {
      zen: new ZenKeyPool(zenKeys, PROXIES, client, { cooldownBaseMs: 0, maxAttempts: 3 }),
    },
    anonymousPool: anonymous ? new ZenAnonymousPool(PROXIES, client) : undefined,
    anonymous,
    upstream: { zen: 'https://up.test/zen', go: 'https://up.test/go' },
    forcedEffort,
    now: () => NOW,
  };
}

describe('probe failure markers', () => {
  it('recognises model-unavailability only for the documented statuses', () => {
    assert.equal(isModelUnavailable(404, 'model_not_found'), true);
    assert.equal(isModelUnavailable(400, 'unknown model "x"'), true);
    assert.equal(isModelUnavailable(410, 'model has been retired'), true);
    assert.equal(isModelUnavailable(422, 'model is no longer available'), true);
    assert.equal(isModelUnavailable(429, 'model_not_found'), false);
    assert.equal(isModelUnavailable(404, 'route missing'), false);
    assert.equal(isModelUnavailable(500, 'model_not_found'), false);
  });

  it('recognises effort rejections only on 400/422 with effort wording', () => {
    assert.equal(isEffortRejection(400, 'effort is unsupported'), true);
    assert.equal(isEffortRejection(422, 'reasoning must be one of allowed values'), true);
    assert.equal(isEffortRejection(400, 'thinking is not allowed'), true);
    assert.equal(isEffortRejection(429, 'effort unsupported'), false);
    assert.equal(isEffortRejection(400, 'invalid request'), false);
    assert.equal(isEffortRejection(400, 'effort accepted'), false);
  });
});

describe('probeFreeModel', () => {
  it('marks a healthy anonymous probe as succeeded', async () => {
    const client = new ScriptedClient(() => sseSuccess());
    // Only the anonymous lane is configured, so it owns the observation.
    const result = await probeFreeModel(
      probeOptions(client, () => '', true, []),
      'm-free',
    );
    assert.equal(result.success, true);
    assert.equal(result.reason, 'probe_succeeded');
    assert.equal(result.channel, 'anonymous');
    assert.equal(result.attempted, true);
    // The probe pins a canonical availability session so upstream affinity
    // does not collide with real conversations.
    const session = client.requests[0]?.headers?.['x-opencode-session'] ?? '';
    assert.match(session, /^ses_/);
    assert.equal(sentBody(client.requests[0]!).stream, true);
  });

  it('falls back to a zen key lane when the anonymous lane is off', async () => {
    const client = new ScriptedClient(() => sseSuccess());
    const result = await probeFreeModel(
      probeOptions(client, () => '', false),
      'm-free',
    );
    assert.equal(result.success, true);
    assert.equal(result.channel, 'zen');
  });

  it('reports no_probe_channel without any usable lane', async () => {
    const client = new ScriptedClient(() => sseSuccess());
    const options = probeOptions(client, () => '', false);
    options.pools.zen = new ZenKeyPool([], PROXIES, client, { cooldownBaseMs: 0, maxAttempts: 3 });
    const result = await probeFreeModel(options, 'm-free');
    assert.equal(result.attempted, false);
    assert.equal(result.reason, 'no_probe_channel');
  });

  it('classifies a model-marker 404 as model_unavailable', async () => {
    const client = new ScriptedClient(() => inbound(404, '{"error":{"code":"model_not_found"}}'));
    const result = await probeFreeModel(probeOptions(client), 'm-free');
    assert.equal(result.success, false);
    assert.equal(result.reason, 'model_unavailable');
  });

  it('keeps a transport error inconclusive', async () => {
    const client: ZenHttpClient = {
      send(): Promise<ZenHttpResponse> {
        return Promise.reject(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
      },
    };
    const result = await probeFreeModel(probeOptions(client), 'm-free');
    assert.equal(result.success, false);
    assert.equal(result.reason, 'transport_error');
  });

  it('rejects a 2xx with an upstream error envelope', async () => {
    const client = new ScriptedClient(() => inbound(200, '{"error":{"message":"nope"}}'));
    const result = await probeFreeModel(probeOptions(client), 'm-free');
    assert.equal(result.success, false);
    assert.equal(result.reason, 'invalid_or_incomplete_response');
  });

  it('rejects a 2xx whose schema lacks the protocol response field', async () => {
    const client = new ScriptedClient(() => inbound(200, '{"object":"weird"}'));
    const result = await probeFreeModel(probeOptions(client), 'm-free');
    assert.equal(result.success, false);
    assert.equal(result.reason, 'invalid_or_incomplete_response');
  });

  it('skips models outside the free tier and the catalog', async () => {
    const client = new ScriptedClient(() => sseSuccess());
    const notFree = await probeFreeModel(probeOptions(client), 'paid-model');
    assert.equal(notFree.reason, 'not_free');
    assert.equal(notFree.attempted, false);
    const unsupported = await probeFreeModel(probeOptions(client), 'ghost-free');
    assert.equal(unsupported.reason, 'unsupported_probe');
  });

  it('does not probe when the forced effort is not auto', async () => {
    const client = new ScriptedClient(() => sseSuccess());
    const result = await probeFreeModel(
      probeOptions(client, () => 'high', true, []),
      'm-free',
    );
    assert.deepEqual(result.effort, {});
    assert.equal(client.requests.length, 1);
  });

  it('walks the effort ladder and records the highest accepted level', async () => {
    const client = new ScriptedClient((request) => {
      const effort = sentBody(request)['reasoning_effort'];
      if (typeof effort === 'string') {
        return effort === 'xhigh' ? sseSuccess() : inbound(400, 'effort value is invalid');
      }
      return sseSuccess();
    });
    const result = await probeFreeModel(
      probeOptions(client, () => 'auto', true, []),
      'm-free',
    );
    assert.equal(result.success, true);
    assert.deepEqual(result.effort, { effort: 'xhigh', protocol: 'chat' });
    const trials = client.requests
      .map((request) => sentBody(request)['reasoning_effort'])
      .filter((value) => typeof value === 'string');
    assert.deepEqual(trials, ['max', 'xhigh']);
  });

  it('keeps the baseline when every level down to minimal is rejected', async () => {
    const client = new ScriptedClient((request) => {
      const effort = sentBody(request)['reasoning_effort'];
      if (typeof effort === 'string') return inbound(422, 'unsupported reasoning effort');
      return sseSuccess();
    });
    const result = await probeFreeModel(
      probeOptions(client, () => 'auto', true, []),
      'm-free',
    );
    assert.deepEqual(result.effort, { effort: 'none', protocol: 'chat' });
  });

  it('keeps previous observations when the very first trial is inconclusive', async () => {
    const client = new ScriptedClient((request) => {
      const effort = sentBody(request)['reasoning_effort'];
      if (effort === 'max') return inbound(500, 'boom');
      return sseSuccess();
    });
    const result = await probeFreeModel(
      probeOptions(client, () => 'auto', true, []),
      'm-free',
    );
    assert.equal(result.success, true);
    // A rate limit says nothing about the effort the model accepts, so no
    // ceiling is recorded and none is invalidated.
    assert.deepEqual(result.effort, {});
    // The inconclusive max failure stops the ladder: no further trials fire.
    assert.equal(client.requests.length, 2);
  });

  it('drops a confirmed ceiling once a later trial turns inconclusive', async () => {
    const client = new ScriptedClient((request) => {
      const effort = sentBody(request)['reasoning_effort'];
      if (effort === 'max') return inbound(400, 'effort is unsupported');
      if (effort === 'xhigh') return inbound(500, 'boom');
      return sseSuccess();
    });
    const result = await probeFreeModel(
      probeOptions(client, () => 'auto', true, []),
      'm-free',
    );
    assert.equal(result.success, true);
    // max was explicitly rejected, so an inconclusive xhigh must not let an
    // older ceiling survive.
    assert.deepEqual(result.effort, { reset: true });
    assert.equal(client.requests.length, 3);
  });

  it('only lets an unanimous model_unavailable disable across lanes', async () => {
    // The anonymous lane proves the model answers while the key lane claims it
    // is gone: a single lane's verdict can never establish unavailability.
    const client = new ScriptedClient((request) =>
      request.headers?.['authorization'] === 'Bearer public'
        ? sseSuccess()
        : inbound(404, '{"error":{"code":"model_not_found"}}'),
    );
    const result = await probeFreeModel(probeOptions(client), 'm-free');
    assert.equal(result.success, false);
    assert.equal(result.reason, 'probe_succeeded');
  });

  it('records none for a model without reasoning metadata', async () => {
    const options = probeOptions(new ScriptedClient(() => sseSuccess()), () => 'auto');
    options.catalog = catalog(false);
    const result = await probeFreeModel(options, 'm-free');
    assert.deepEqual(result.effort, { effort: 'none', protocol: 'chat' });
  });
});

describe('resolvedEffort auto semantics', () => {
  const deps = (store: ZenAvailabilityStore, effort = 'auto') => ({
    forcedEffort: () => effort,
    availability: store,
    catalog: catalog(),
    now: () => NOW,
  });

  it('returns a non-auto forced effort verbatim', () => {
    const store = new ZenAvailabilityStore();
    assert.equal(resolvedEffort(deps(store, 'high'), 'm-free', 'zen', 'chat'), 'high');
  });

  it('uses the probed effort for an auto model', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m-free', 0, true, 'probe_succeeded', 'anonymous', NOW, {
      effort: 'low',
      protocol: 'chat',
    });
    assert.equal(resolvedEffort(deps(store), 'm-free', 'zen', 'chat'), 'low');
  });

  it('injects nothing for disabled, mismatched, stale or absent probes', async () => {
    const store = new ZenAvailabilityStore();
    // No record at all.
    assert.equal(resolvedEffort(deps(store), 'm-free', 'zen', 'chat'), '');
    await store.record('m-free', 0, true, 'probe_succeeded', 'anonymous', NOW, {
      effort: 'low',
      protocol: 'chat',
    });
    // A stale observation (older than two check intervals) is not trusted.
    const stale = resolvedEffort(
      { ...deps(store), now: () => NOW + 3 * 60 * 60 * 1000 },
      'm-free',
      'zen',
      'chat',
    );
    assert.equal(stale, '');
    // A probe taken on another protocol must not transfer.
    assert.equal(resolvedEffort(deps(store), 'm-free', 'zen', 'anthropic'), '');
    // The go tier and non-free models are never probed.
    assert.equal(resolvedEffort(deps(store), 'm-free', 'go', 'chat'), '');
    // A model that only accepted the baseline keeps it un-forced.
    const none = new ZenAvailabilityStore();
    await none.record('m-free', 0, true, 'probe_succeeded', 'anonymous', NOW, {
      effort: 'none',
      protocol: 'chat',
    });
    assert.equal(resolvedEffort(deps(none), 'm-free', 'zen', 'chat'), '');
  });

  it('injects nothing while the model is disabled', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m-free', 0, true, 'probe_succeeded', 'anonymous', NOW, {
      effort: 'low',
      protocol: 'chat',
    });
    await store.record('m-free', 0, false, 'model_unavailable', 'anonymous', NOW + 1, {});
    assert.equal(resolvedEffort(deps(store), 'm-free', 'zen', 'chat'), '');
  });
});

describe('ZenAvailabilityChecker', () => {
  it('probes due free models and records the result', async () => {
    const store = new ZenAvailabilityStore();
    // A successful record schedules the next check one hour out; advance the
    // clock past it so the model is due again.
    await store.record('m-free', 0, true, 'probe_succeeded', 'anonymous', 1_000, {});
    const probeCalls: string[] = [];
    const checker = new ZenAvailabilityChecker({
      store,
      catalog: catalog(),
      probe: async (model) => {
        probeCalls.push(model);
        return {
          success: false,
          attempted: true,
          effortRejected: false,
          reason: 'model_unavailable',
          channel: 'zen',
          effort: {},
        } satisfies ZenProbeResult;
      },
      now: () => 1_000 + 2 * 60 * 60 * 1000,
    });
    await checker.checkOnce();
    assert.deepEqual(probeCalls, ['m-free']);
    assert.equal(store.disabled('m-free'), true);
  });

  it('skips manual models and models that are not due', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m-free', 0, true, 'probe_succeeded', 'anonymous', 1_000, {});
    await store.setManual('m-free', true, 1_500);
    const probeCalls: string[] = [];
    const checker = new ZenAvailabilityChecker({
      store,
      catalog: catalog(),
      probe: async (model) => {
        probeCalls.push(model);
        return {
          success: true,
          attempted: true,
          effortRejected: false,
          reason: 'probe_succeeded',
          channel: 'zen',
          effort: {},
        };
      },
      now: () => 1_000 + 2 * 60 * 60 * 1000,
    });
    await checker.checkOnce();
    assert.deepEqual(probeCalls, []);
    assert.equal(store.disabled('m-free'), false);
  });

  it('does not record an unattempted probe', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m-free', 0, true, 'probe_succeeded', 'anonymous', 1_000, {});
    const checker = new ZenAvailabilityChecker({
      store,
      catalog: catalog(),
      probe: async () => ({
        success: false,
        attempted: false,
        effortRejected: false,
        reason: 'no_probe_channel',
        channel: '',
        effort: {},
      }),
      now: () => 1_000 + 2 * 60 * 60 * 1000,
    });
    await checker.checkOnce();
    // The hourly schedule from the previous record survives an unattempted run.
    assert.equal(store.get('m-free').nextCheck, 1_000 + 60 * 60 * 1000);
  });
});
