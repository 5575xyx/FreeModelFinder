import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { __resetCatalogCacheForTests, listClineCatalogModels } from '../cline-catalog.js';

const UPSTREAM_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models';

const FREE_PAYLOAD = {
  free: [{ id: 'a', context_length: 4096 }],
  recommended: [{ id: 'paid' }],
  clinePass: [{ id: 'pass' }],
  clineCloud: [{ id: 'cloud' }],
};

function responseOf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sequenceFetch(bodies: unknown[]): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)];
    calls += 1;
    return responseOf(body);
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('cline catalog', () => {
  beforeEach(() => {
    __resetCatalogCacheForTests();
  });

  it('keeps only the free group from the upstream payload', async () => {
    const models = await listClineCatalogModels({
      fetchImpl: sequenceFetch([FREE_PAYLOAD]).fetchImpl,
    });
    assert.deepEqual(models, [{ id: 'a', contextWindow: 4096 }]);
  });

  it('requests the recommended-models endpoint with the required headers', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return responseOf(FREE_PAYLOAD);
    }) as typeof fetch;
    await listClineCatalogModels({ fetchImpl });
    assert.equal(requestedUrl, UPSTREAM_URL);
    assert.equal(requestedInit?.method, 'GET');
    const headers = new Headers(requestedInit?.headers);
    assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('User-Agent'), 'Mozilla/5.0 (cline2api)');
    assert.ok(requestedInit?.signal, 'a timeout signal must be attached');
  });

  it('serves a fresh cache without refetching', async () => {
    const { fetchImpl, calls } = sequenceFetch([FREE_PAYLOAD]);
    const first = await listClineCatalogModels({ fetchImpl });
    const second = await listClineCatalogModels({ fetchImpl });
    assert.equal(calls(), 1);
    assert.deepEqual(first, [{ id: 'a', contextWindow: 4096 }]);
    assert.deepEqual(second, first);
  });

  it('refreshes once the ttl elapses', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const { fetchImpl, calls } = sequenceFetch([
      { free: [{ id: 'old' }] },
      { free: [{ id: 'new' }] },
    ]);
    const first = await listClineCatalogModels({ fetchImpl, now });
    clock += 31 * 60_000;
    const second = await listClineCatalogModels({ fetchImpl, now });
    assert.equal(calls(), 2);
    assert.deepEqual(first, [{ id: 'old' }]);
    assert.deepEqual(second, [{ id: 'new' }]);
  });

  it('falls back to the previous cache when a refresh fails', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    let failing = false;
    const fetchImpl = (async () => {
      if (failing) throw new Error('network down');
      return responseOf({ free: [{ id: 'old' }] });
    }) as typeof fetch;
    const first = await listClineCatalogModels({ fetchImpl, now });
    clock += 31 * 60_000;
    failing = true;
    const second = await listClineCatalogModels({ fetchImpl, now });
    assert.deepEqual(first, [{ id: 'old' }]);
    assert.deepEqual(second, [{ id: 'old' }]);
  });

  it('returns null when the first fetch fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    assert.equal(await listClineCatalogModels({ fetchImpl }), null);
  });

  it('shares a single inflight request across concurrent expired calls', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return responseOf({ free: [{ id: 'a' }] });
    }) as typeof fetch;
    const [first, second] = await Promise.all([
      listClineCatalogModels({ fetchImpl }),
      listClineCatalogModels({ fetchImpl }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(first, [{ id: 'a' }]);
    assert.deepEqual(first, second);
  });

  it('short-circuits to null when dynamic models are disabled', async () => {
    const { fetchImpl, calls } = sequenceFetch([FREE_PAYLOAD]);
    assert.equal(await listClineCatalogModels({ fetchImpl, dynamicModels: false }), null);
    assert.equal(calls(), 0);
    assert.deepEqual(await listClineCatalogModels({ fetchImpl }), [
      { id: 'a', contextWindow: 4096 },
    ]);
    assert.equal(calls(), 1);
    assert.equal(await listClineCatalogModels({ fetchImpl, dynamicModels: false }), null);
    assert.equal(calls(), 1);
  });

  it('treats an empty free group as a failed refresh', async () => {
    const models = await listClineCatalogModels({
      fetchImpl: sequenceFetch([{ free: [] }]).fetchImpl,
    });
    assert.equal(models, null);
  });

  it('treats a payload without a free group as a failed refresh', async () => {
    const models = await listClineCatalogModels({
      fetchImpl: sequenceFetch([{ recommended: [{ id: 'paid' }] }]).fetchImpl,
    });
    assert.equal(models, null);
  });

  it('treats free entries without an id as a failed refresh', async () => {
    const models = await listClineCatalogModels({
      fetchImpl: sequenceFetch([{ free: [{ name: 'nameless' }] }]).fetchImpl,
    });
    assert.equal(models, null);
  });

  it('treats a non-2xx response as a failed refresh', async () => {
    const fetchImpl = (async () => responseOf({ free: [] }, 500)) as typeof fetch;
    assert.equal(await listClineCatalogModels({ fetchImpl }), null);
  });

  it('treats a non-JSON body as a failed refresh', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    assert.equal(await listClineCatalogModels({ fetchImpl }), null);
  });

  it('treats an oversized body as a failed refresh', async () => {
    const oversized = 'x'.repeat(4 * 1024 * 1024 + 1);
    const fetchImpl = (async () => new Response(oversized, { status: 200 })) as typeof fetch;
    assert.equal(await listClineCatalogModels({ fetchImpl }), null);
  });

  it('converges an invalid fetch implementation to null instead of throwing', async () => {
    const fetchImpl = {} as unknown as typeof fetch;
    assert.equal(await listClineCatalogModels({ fetchImpl }), null);
  });

  it('normalizes optional fields and drops non-string metadata', async () => {
    const models = await listClineCatalogModels({
      fetchImpl: sequenceFetch([
        {
          free: [
            { id: 'x', context_length: 0 },
            { id: 'y', name: '  Why  ', description: 'desc', context_length: 8192 },
            { id: 'z' },
            { id: 'w', name: 42, description: 42 },
          ],
        },
      ]).fetchImpl,
    });
    assert.deepEqual(models, [
      { id: 'x' },
      { id: 'y', name: 'Why', description: 'desc', contextWindow: 8192 },
      { id: 'z' },
      { id: 'w' },
    ]);
  });
});
