import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenCatalog } from '../models/catalog.js';

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
