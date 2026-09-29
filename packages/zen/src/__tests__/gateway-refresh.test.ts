import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { normalizeZenConfig } from '../config/index.js';
import { readJsonCache, writeJsonCache } from '../models/cache.js';
import { ZenCatalog } from '../models/catalog.js';
import { ZenPricingStore } from '../models/pricing.js';
import { ZenRefresher } from '../gateway/refresh.js';

const config = normalizeZenConfig({
  upstream: { zen: 'https://zen.test/api', go: 'https://zen.test/api/go' },
});

const DEFAULT_ZEN_MODELS = ['zen-free', 'shared'];
const GO_MODELS = ['go-paid', 'shared'];

const CAPABILITIES = {
  opencode: {
    id: 'opencode',
    api: 'https://zen.test/api/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'zen-free': { id: 'zen-free' },
      shared: { id: 'shared' },
    },
  },
  'opencode-go': {
    id: 'opencode-go',
    api: 'https://zen.test/api/go/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'go-paid': { id: 'go-paid' },
      shared: { id: 'shared' },
    },
  },
};

const MODELS_DEV = {
  opencode: {
    id: 'opencode',
    models: {
      'free-by-cost': { id: 'free-by-cost', cost: { input: 0, output: 0 } },
      shared: { id: 'shared', cost: { input: 1, output: 1 } },
    },
  },
};

const ZEN_DOCS = [
  '| Model | Model ID | Endpoint | AI SDK Package |',
  '| --- | --- | --- | --- |',
  '| Doc Only | doc-only | `https://zen.test/api/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
].join('\n');

interface FakeState {
  fail: boolean;
  docs?: boolean;
  zenModels?: string[];
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(state: FakeState): typeof fetch {
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (state.fail) return new Response('boom', { status: 500 });
    if (url.includes('models.dev')) return jsonResponse(MODELS_DEV);
    if (url.includes('models.opencode.ai')) return jsonResponse(CAPABILITIES);
    if (url.endsWith('zen.mdx')) {
      return state.docs
        ? new Response(ZEN_DOCS, { status: 200 })
        : new Response('nope', { status: 404 });
    }
    if (url.endsWith('go.mdx')) return new Response('nope', { status: 404 });
    const zenModels = state.zenModels ?? DEFAULT_ZEN_MODELS;
    if (url.includes('/go/v1/models')) {
      return jsonResponse({ data: GO_MODELS.map((id) => ({ id })) });
    }
    if (url.includes('/v1/models')) {
      return jsonResponse({ data: zenModels.map((id) => ({ id })) });
    }
    return new Response('nope', { status: 404 });
  };
  return fetchImpl as unknown as typeof fetch;
}

describe('zen refresher', () => {
  it('merges both tiers, decodes pricing and persists caches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-refresh-'));
    try {
      const cachePaths = { catalog: join(dir, 'catalog.json'), pricing: join(dir, 'pricing.json') };
      const catalog = new ZenCatalog('go', {});
      const pricing = new ZenPricingStore();
      const refresher = new ZenRefresher({
        config,
        catalog,
        pricing,
        fetchImpl: makeFetch({ fail: false }),
        cachePaths,
      });

      await refresher.refreshOnce();

      assert.deepEqual(catalog.list(), ['go-paid', 'shared', 'zen-free']);
      const snapshot = catalog.snapshot();
      assert.equal(snapshot.zen, 2);
      assert.equal(snapshot.go, 2);
      assert.equal(snapshot.total, 3);
      assert.equal(pricing.decide('free-by-cost').allowed, true);

      assert.ok(await readJsonCache(cachePaths.catalog));
      assert.ok(await readJsonCache(cachePaths.pricing));

      const reloadedCatalog = new ZenCatalog('go', {});
      const reloadedPricing = new ZenPricingStore();
      const reloaded = new ZenRefresher({
        config,
        catalog: reloadedCatalog,
        pricing: reloadedPricing,
        fetchImpl: makeFetch({ fail: true }),
        cachePaths,
      });
      const summary = await reloaded.loadCache();
      assert.equal(summary.catalog, true);
      assert.equal(reloadedCatalog.snapshot().total, snapshot.total);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discards a catalog cache with an unsupported schema version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-refresh-'));
    try {
      const catalogPath = join(dir, 'catalog.json');
      await writeJsonCache(catalogPath, {
        schema_version: 999,
        updated_at: new Date().toISOString(),
        zen: ['x'],
        go: [],
      });
      const catalog = new ZenCatalog('go', {});
      const refresher = new ZenRefresher({
        config,
        catalog,
        pricing: new ZenPricingStore(),
        fetchImpl: makeFetch({ fail: true }),
        cachePaths: { catalog: catalogPath },
      });
      const summary = await refresher.loadCache();
      assert.equal(summary.catalog, false);
      assert.equal(catalog.snapshot().total, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps previous catalog data and records lastError when refresh fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-refresh-'));
    try {
      const state: FakeState = { fail: false };
      const catalog = new ZenCatalog('go', {});
      const refresher = new ZenRefresher({
        config,
        catalog,
        pricing: new ZenPricingStore(),
        fetchImpl: makeFetch(state),
        cachePaths: { catalog: join(dir, 'catalog.json') },
      });
      await refresher.refreshOnce();
      const before = catalog.snapshot().total;
      assert.equal(before, 3);

      state.fail = true;
      const result = await refresher.refreshOnce();
      assert.ok(result.errors.length > 0);
      assert.ok(refresher.lastError.length > 0);
      assert.equal(catalog.snapshot().total, before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fills protocols from the .mdx endpoint tables when the catalog lacks a model', async () => {
    const catalog = new ZenCatalog('go', {});
    const refresher = new ZenRefresher({
      config,
      catalog,
      pricing: new ZenPricingStore(),
      fetchImpl: makeFetch({
        fail: false,
        docs: true,
        zenModels: ['zen-free', 'shared', 'doc-only'],
      }),
    });
    await refresher.refreshOnce();

    assert.ok(catalog.list().includes('doc-only'));
    assert.equal(catalog.protocolFor('doc-only', 'zen'), 'chat');
  });
});
