import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenPricingStore, decodeModelsDev } from '../models/pricing.js';

const FIXTURE = {
  opencode: {
    id: 'opencode',
    models: {
      'free-by-cost': { id: 'free-by-cost', cost: { input: 0, output: 0 } },
      paid: { id: 'paid', cost: { input: 1, output: 2 } },
      unknown: { id: 'unknown' },
      dead: { id: 'dead', cost: { input: 0, output: 0 }, deprecated: true },
    },
  },
  other: {
    id: 'other',
    models: { nope: { id: 'nope', cost: { input: 0, output: 0 } } },
  },
};

describe('models.dev decoding', () => {
  it('prefers the opencode provider block', () => {
    const models = decodeModelsDev(FIXTURE);
    assert.ok(models['free-by-cost']);
    assert.equal(models['nope'], undefined);
  });

  it('treats zero cost and non-deprecated as anonymous-eligible', () => {
    const store = new ZenPricingStore();
    store.replace(decodeModelsDev(FIXTURE), Date.now());
    assert.equal(store.decide('free-by-cost').allowed, true);
    assert.equal(store.decide('paid').allowed, false);
    assert.equal(store.decide('unknown').allowed, false);
    assert.equal(store.decide('unknown').known, false);
    assert.equal(store.decide('dead').allowed, false);
    assert.equal(store.decide('dead').deprecated, true);
  });

  it('falls back to the -free name convention before metadata arrives', () => {
    const store = new ZenPricingStore();
    assert.equal(store.decide('something-free').allowed, true);
    assert.equal(store.decide('something-free').source, 'metadata_pending');
    assert.equal(store.decide('something-paid').allowed, false);
  });

  it('reports a snapshot', () => {
    const store = new ZenPricingStore();
    store.replace(decodeModelsDev(FIXTURE), Date.now());
    const snap = store.snapshot();
    assert.equal(snap.ready, true);
    assert.equal(snap.models, 4);
    assert.equal(snap.stale, false);
  });
});
