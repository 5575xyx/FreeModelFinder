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

const EXTRA = {
  other: { id: 'other', models: { skip: { id: 'skip' } } },
  'my-opencode-custom': {
    id: '',
    name: 'my-opencode-custom',
    models: { alias: { id: 'alias', cost: { input: 0, output: 0 } } },
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

describe('models.dev edge cases', () => {
  it('falls back to a rank-1 provider whose id contains opencode', () => {
    const models = decodeModelsDev(EXTRA);
    assert.ok(models['alias']);
  });

  it('classifies a zero-cost model without "free" in the name as metadata_free', () => {
    const store = new ZenPricingStore();
    store.replace({ cheapo: { id: 'cheapo', input: 0, output: 0, deprecated: false } }, Date.now());
    const decision = store.decide('cheapo');
    assert.equal(decision.allowed, true);
    assert.equal(decision.source, 'metadata_free');
  });

  it('classifies a name-free paid model as name_free', () => {
    const store = new ZenPricingStore();
    store.replace(
      { 'paid-free': { id: 'paid-free', input: 1, output: 2, deprecated: false } },
      Date.now(),
    );
    const decision = store.decide('paid-free');
    assert.equal(decision.allowed, true);
    assert.equal(decision.source, 'name_free');
  });

  it('reports partial cost as cost_unknown', () => {
    const store = new ZenPricingStore();
    store.replace({ half: { id: 'half', input: 0, deprecated: false } }, Date.now());
    const decision = store.decide('half');
    assert.equal(decision.allowed, false);
    assert.equal(decision.known, false);
    assert.equal(decision.source, 'metadata_cost_unknown');
  });

  it('treats a non-object payload and a payload without opencode as errors', () => {
    assert.throws(() => decodeModelsDev(null));
    assert.throws(() => decodeModelsDev({ other: { id: 'other', models: { x: { id: 'x' } } } }));
  });

  it('detects deprecation via lifecycle when status is empty', () => {
    assert.equal(
      decodeModelsDev({
        opencode: {
          id: 'opencode',
          models: { d: { id: 'd', status: '', lifecycle: 'deprecated' } },
        },
      })['d']?.deprecated,
      true,
    );
  });

  it('ignores non-string and padded status values', () => {
    const decoded = decodeModelsDev({
      opencode: {
        id: 'opencode',
        models: {
          a: { id: 'a', status: 123, lifecycle: 'retired' },
          b: { id: 'b', status: '  ', lifecycle: 'deprecated' },
          c: { id: 'c', status: '  deprecated  ' },
        },
      },
    });
    assert.equal(decoded['a']?.deprecated, true);
    assert.equal(decoded['b']?.deprecated, true);
    assert.equal(decoded['c']?.deprecated, true);
  });

  it('surfaces errors and staleness in the snapshot', () => {
    const store = new ZenPricingStore();
    store.replace(
      { a: { id: 'a', input: 0, output: 0, deprecated: false } },
      Date.now() - 25 * 60 * 60 * 1000,
    );
    assert.equal(store.snapshot().stale, true);
    store.recordError('boom');
    assert.equal(store.snapshot().lastError, 'boom');
  });

  it('reports paid models with known cost and prices', () => {
    const store = new ZenPricingStore();
    store.replace({ p: { id: 'p', input: 3, output: 4, deprecated: false } }, Date.now());
    const decision = store.decide('p');
    assert.equal(decision.known, true);
    assert.equal(decision.inputCost, 3);
    assert.equal(decision.outputCost, 4);
  });
});

// models.dev publishes per-model limits under "limit". The opencode capability
// catalog omits them, so discovery clients only learn a model's context and
// output ceilings from here.
describe('models.dev limits', () => {
  it('reads per-model context and output limits', () => {
    const models = decodeModelsDev({
      opencode: {
        id: 'opencode',
        models: {
          m: {
            id: 'm',
            cost: { input: 0, output: 0 },
            limit: { context: 128000, input: 100000, output: 8192 },
          },
        },
      },
    });
    assert.equal(models['m']?.contextWindow, 128000);
    assert.equal(models['m']?.maxInput, 100000);
    assert.equal(models['m']?.maxOutput, 8192);
  });

  it('omits limits models.dev did not publish', () => {
    const models = decodeModelsDev({
      opencode: { id: 'opencode', models: { m: { id: 'm' } } },
    });
    assert.equal(models['m']?.contextWindow, undefined);
    assert.equal(models['m']?.maxInput, undefined);
    assert.equal(models['m']?.maxOutput, undefined);
  });

  it('merges secondary opencode providers instead of stopping at the first', () => {
    const models = decodeModelsDev({
      opencode: {
        id: 'opencode',
        models: { shared: { id: 'shared', cost: { input: 1, output: 2 } } },
      },
      'my-opencode-custom': {
        id: '',
        name: 'my-opencode-custom',
        models: {
          shared: { id: 'shared', cost: { input: 9, output: 9 } },
          extra: { id: 'extra', cost: { input: 0, output: 0 } },
        },
      },
    });
    // the primary block alone must not end the scan: later opencode providers
    // still contribute models it did not list.
    assert.ok(models['extra'], 'model from a secondary opencode provider was dropped');
    // and the primary stays authoritative for a duplicate id.
    assert.equal(models['shared']?.input, 1);
  });

  it('exposes limits through the pricing store', () => {
    const store = new ZenPricingStore();
    store.replace(
      decodeModelsDev({
        opencode: {
          id: 'opencode',
          models: { m: { id: 'm', limit: { context: 1000, output: 500 } } },
        },
      }),
      Date.now(),
    );
    assert.deepEqual(store.limits('m'), { contextWindow: 1000, maxOutput: 500 });
    assert.equal(store.limits('absent'), undefined);
  });
});
