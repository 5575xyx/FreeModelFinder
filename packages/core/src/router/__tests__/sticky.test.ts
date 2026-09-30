import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AutoRouter, resetStickyStore } from '../auto-router.js';
import { makeRouter } from './fixtures.js';

function router(): AutoRouter {
  return makeRouter().router;
}

describe('AutoRouter sticky store', () => {
  beforeEach(() => resetStickyStore());

  it('stores and returns a sticky pick until it expires', () => {
    const r = router();
    assert.equal(r.getSticky('s1'), null);
    r.setSticky('s1', 'openrouter', 'big-70b');
    assert.deepEqual(r.getSticky('s1'), { provider: 'openrouter', modelId: 'big-70b' });
  });

  it('clears a single key and all keys', () => {
    const r = router();
    r.setSticky('s1', 'openrouter', 'a');
    r.setSticky('s2', 'openrouter', 'b');
    assert.equal(r.clearSticky('s1'), true);
    assert.equal(r.getSticky('s1'), null);
    assert.notEqual(r.getSticky('s2'), null);
    resetStickyStore();
    assert.equal(r.getSticky('s2'), null);
  });

  it('drops expired entries on read', () => {
    const r = router();
    r.setSticky('s1', 'openrouter', 'a', -1);
    assert.equal(r.getSticky('s1'), null);
  });

  it('evicts oldest entry beyond the capacity cap', () => {
    const r = router();
    for (let i = 0; i < 1001; i++) r.setSticky(`k${i}`, 'openrouter', `m${i}`);
    assert.equal(r.getSticky('k0'), null);
    assert.notEqual(r.getSticky('k1000'), null);
  });
});
