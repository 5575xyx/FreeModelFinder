import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenCatalog } from '../models/catalog.js';
import type { PricingDecider } from '../models/types.js';

function catalog(): ZenCatalog {
  const c = new ZenCatalog('go', {});
  c.replace({
    zen: ['m-free', 'shared'],
    go: ['shared', 'go-only'],
    native: {
      zen: { 'm-free': 'chat', shared: 'anthropic' },
      go: { shared: 'chat', 'go-only': 'responses' },
    },
    unsupported: { zen: {}, go: {} },
    metadata: {
      zen: { 'm-free': { contextWindow: 1000, reasoning: true } },
      go: {},
    },
  });
  return c;
}

describe('zen catalog state', () => {
  it('lists the union of both tiers sorted', () => {
    assert.deepEqual(catalog().list(), ['go-only', 'm-free', 'shared']);
  });

  it('reports availability via supported()', () => {
    const c = catalog();
    assert.equal(c.supported('shared'), true);
    assert.equal(c.supported('missing'), false);
  });

  it('snapshots counts', () => {
    const snap = catalog().snapshot();
    assert.equal(snap.zen, 2);
    assert.equal(snap.go, 2);
    assert.equal(snap.total, 3);
    assert.equal(snap.stale, false);
  });

  it('exposes per-tier metadata', () => {
    const c = catalog();
    assert.equal(c.metadataForTier('m-free', 'zen')?.contextWindow, 1000);
    assert.equal(c.metadataForTier('m-free', 'go')?.contextWindow, undefined);
  });

  it('marks a tier unsupported when the protocol is unknown', () => {
    const c = new ZenCatalog('zen', {});
    c.replace({
      zen: ['x'],
      go: [],
      native: { zen: {}, go: {} },
      unsupported: { zen: { x: true }, go: {} },
      metadata: { zen: {}, go: {} },
    });
    assert.equal(c.supported('x'), false);
  });

  it('preserves tiers omitted from an incremental replace', () => {
    const c = new ZenCatalog('zen', {});
    c.replace({
      zen: ['a'],
      go: ['b'],
      native: { zen: { a: 'chat' }, go: { b: 'responses' } },
      unsupported: { zen: {}, go: {} },
      metadata: { zen: {}, go: {} },
    });
    c.replace({ zen: ['a', 'c'], native: { zen: { a: 'chat', c: 'chat' } } });
    assert.equal(c.protocolFor('b', 'go'), 'responses');
    assert.equal(c.supported('b'), true);
  });

  it('does not leak metadata mutations in or out', () => {
    const c = new ZenCatalog('zen', {});
    const md = { contextWindow: 1000 };
    c.replace({
      zen: ['a'],
      native: { zen: { a: 'chat' } },
      metadata: { zen: { a: md } },
    });
    md.contextWindow = 999;
    assert.equal(c.metadataForTier('a', 'zen')?.contextWindow, 1000);
    const returned = c.metadataForTier('a', 'zen');
    if (returned) returned.contextWindow = 777;
    assert.equal(c.metadataForTier('a', 'zen')?.contextWindow, 1000);
  });

  it('reports exposed and cacheSource in the snapshot', () => {
    const c = catalog();
    const snap = c.snapshot();
    assert.equal(snap.exposed, 3);
    assert.equal(snap.cacheSource, 'live');
  });
});

function freeStore(free: string[]): PricingDecider {
  return {
    decide: (model: string) =>
      free.includes(model)
        ? {
            allowed: true,
            source: 'metadata_free',
            known: true,
            deprecated: false,
            inputCost: 0,
            outputCost: 0,
          }
        : {
            allowed: false,
            source: 'metadata_paid',
            known: true,
            deprecated: false,
            inputCost: 1,
            outputCost: 1,
          },
  };
}

describe('zen catalog routing', () => {
  it('routes a free model through the anonymous Zen lane', () => {
    const c = catalog();
    c.setPricing(freeStore(['m-free']));
    const route = c.route('m-free', true, true, true);
    assert.equal(route.anonymous, true);
    assert.equal(route.tier, 'zen');
    assert.equal(route.protocol, 'chat');
    assert.deepEqual(route.keyTiers, ['zen']);
  });

  it('routes a paid model through the preferred key tier', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    const route = c.route('shared', true, true, true);
    assert.equal(route.anonymous, false);
    assert.equal(route.tier, 'go');
    assert.equal(route.protocol, 'chat');
  });

  it('keeps per-tier protocols for cross-tier re-encoding', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    const route = c.route('shared', true, true, false);
    assert.equal(route.protocols.zen, 'anthropic');
    assert.equal(route.protocols.go, 'chat');
  });

  it('only builds a key route for tiers that can serve the model', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    const route = c.route('go-only', true, true, false);
    assert.deepEqual(route.keyTiers, ['go']);
    assert.equal(route.tier, 'go');
  });

  it('throws when no tier can serve the model', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    assert.throws(() => c.route('missing', true, true, false));
  });

  it('does not enter the anonymous lane when disabled', () => {
    const c = catalog();
    c.setPricing(freeStore(['m-free']));
    const route = c.route('m-free', true, true, false);
    assert.equal(route.anonymous, false);
  });

  it('honors a protocol override', () => {
    const c = new ZenCatalog('go', { 'm-free': 'responses' });
    c.replace({
      zen: ['m-free'],
      go: [],
      native: { zen: { 'm-free': 'chat' }, go: {} },
      unsupported: { zen: {}, go: {} },
      metadata: { zen: {}, go: {} },
    });
    c.setPricing(freeStore(['m-free']));
    assert.equal(c.route('m-free', true, false, true).protocol, 'responses');
  });

  it('routeForTier pins a single tier', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    const route = c.routeForTier('shared', 'zen', true, true);
    assert.equal(route.anonymous, false);
    assert.equal(route.tier, 'zen');
    assert.deepEqual(route.keyTiers, ['zen']);
    assert.equal(route.protocol, 'anthropic');
  });

  it('routeForTier rejects tiers without keys', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    assert.throws(() => c.routeForTier('shared', 'zen', false, true));
  });

  it('takes the anonymous Zen lane even when the model is advertised only on Go', () => {
    const c = catalog();
    c.setPricing(freeStore(['go-only']));
    const route = c.route('go-only', true, true, true);
    assert.equal(route.anonymous, true);
    assert.equal(route.tier, 'zen');
    assert.deepEqual(route.keyTiers, ['go']);
  });

  it('follows the prefer order for key tiers', () => {
    const c = new ZenCatalog('zen', {});
    c.replace({
      zen: ['shared'],
      go: ['shared'],
      native: { zen: { shared: 'chat' }, go: { shared: 'chat' } },
      unsupported: { zen: {}, go: {} },
      metadata: { zen: {}, go: {} },
    });
    c.setPricing(freeStore([]));
    const route = c.route('shared', true, true, false);
    assert.equal(route.anonymous, false);
    assert.equal(route.tier, 'zen');
    assert.deepEqual(route.keyTiers, ['zen', 'go']);
  });

  it('prefers the anonymous lane regardless of the key-pool prefer order', () => {
    const withKeys = (prefer: 'go' | 'zen') => {
      const c = new ZenCatalog(prefer, {});
      c.replace({
        zen: ['m-free'],
        go: ['m-free'],
        native: { zen: { 'm-free': 'chat' }, go: { 'm-free': 'chat' } },
        unsupported: { zen: {}, go: {} },
        metadata: { zen: {}, go: {} },
      });
      c.setPricing(freeStore(['m-free']));
      return c.route('m-free', true, true, true);
    };
    const go = withKeys('go');
    assert.equal(go.anonymous, true);
    assert.equal(go.tier, 'zen');
    assert.deepEqual(go.keyTiers, ['go', 'zen']);
    const zen = withKeys('zen');
    assert.equal(zen.anonymous, true);
    assert.equal(zen.tier, 'zen');
    assert.deepEqual(zen.keyTiers, ['zen', 'go']);
  });
});
