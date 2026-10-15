import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SessionUsageTracker } from '../gateway/usage.js';

describe('session usage tracker', () => {
  it('evicts the least recently seen session when capacity is reached', () => {
    const t = new SessionUsageTracker(3);
    t.record('a', 10);
    t.record('b', 20);
    t.record('c', 30);
    t.record('a', 5); // touch a so it becomes most recent
    t.record('d', 40); // full → evict b, the least recently seen
    const snapshot = t.snapshot();
    assert.equal(snapshot.has('b'), false);
    assert.equal(snapshot.get('a')?.total, 15);
    assert.equal(snapshot.get('c')?.total, 30);
    assert.equal(snapshot.get('d')?.total, 40);
  });

  it('does not evict while below capacity', () => {
    const t = new SessionUsageTracker(3);
    t.record('a', 10);
    t.record('b', 20);
    t.record('c', 30);
    assert.equal(t.snapshot().size, 3);
    assert.equal(t.snapshot().has('a'), true);
    assert.equal(t.snapshot().has('b'), true);
    assert.equal(t.snapshot().has('c'), true);
  });

  it('defaults to a capacity of 500', () => {
    const t = new SessionUsageTracker();
    for (let i = 0; i < 501; i += 1) t.record(`s${i}`, 1);
    const snapshot = t.snapshot();
    assert.equal(snapshot.size, 500);
    // The very first session is evicted by the LRU policy.
    assert.equal(snapshot.has('s0'), false);
    assert.equal(snapshot.has('s500'), true);
    assert.equal(snapshot.get('s500')?.total, 1);
  });

  it('accumulates tokens on repeated records instead of overwriting', () => {
    const t = new SessionUsageTracker(3);
    t.record('a', 10);
    t.record('a', 5);
    assert.equal(t.snapshot().get('a')?.total, 15);
  });

  it('accumulates TokenCounts fields when a struct is passed', () => {
    const t = new SessionUsageTracker(3);
    t.record('a', { input: 2, output: 3, cached: 1, reasoning: 4, total: 10 });
    t.record('a', 6);
    const counts = t.snapshot().get('a');
    assert.equal(counts?.input, 2);
    assert.equal(counts?.output, 3);
    assert.equal(counts?.cached, 1);
    assert.equal(counts?.reasoning, 4);
    assert.equal(counts?.total, 16);
  });

  it('ignores empty session ids', () => {
    const t = new SessionUsageTracker(3);
    t.record('', 10);
    assert.equal(t.snapshot().size, 0);
  });

  it('snapshot returns a copy that is independent of further records', () => {
    const t = new SessionUsageTracker(3);
    t.record('a', 10);
    const snapshot = t.snapshot();
    t.record('a', 5);
    assert.equal(snapshot.get('a')?.total, 10);
    assert.equal(t.snapshot().get('a')?.total, 15);
  });
});
