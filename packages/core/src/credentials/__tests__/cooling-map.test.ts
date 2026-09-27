import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CoolingMap, DEFAULT_COOLDOWN_MINUTES } from '../cooling-map.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CoolingMap reset priority', () => {
  it('prefers an explicit resetAt over text duration and fallback minutes', () => {
    const cooling = new CoolingMap();
    const explicit = Date.now() + 120_000;
    const resetAt = cooling.enter('acc-1', 'model-a', {
      resetAt: explicit,
      message: 'try again in 45s',
      fallbackMinutes: 10,
    });
    assert.equal(resetAt, explicit);
    assert.equal(cooling.active('acc-1', 'model-a'), true);
  });

  it('parses a text duration when no explicit resetAt is given', () => {
    const cooling = new CoolingMap();
    const before = Date.now();
    const resetAt = cooling.enter('acc-1', 'model-a', {
      message: 'Too many requests, try again in 45s',
      fallbackMinutes: 10,
    });
    const after = Date.now();
    assert.ok(resetAt >= before + 45_000, `resetAt ${resetAt} too early`);
    assert.ok(resetAt <= after + 45_000, `resetAt ${resetAt} too late`);
  });

  it('parses larger text units (minutes/hours)', () => {
    const cooling = new CoolingMap();
    const before = Date.now();
    const resetAt = cooling.enter('acc-1', 'model-a', { message: 'retry after 2 minutes' });
    const after = Date.now();
    assert.ok(resetAt >= before + 120_000);
    assert.ok(resetAt <= after + 120_000);
  });

  it('uses fallback minutes when nothing else resolves a reset time', () => {
    const cooling = new CoolingMap();
    const before = Date.now();
    const resetAt = cooling.enter('acc-1', 'model-a', {
      message: 'quota exceeded',
      fallbackMinutes: 7,
    });
    const after = Date.now();
    assert.ok(resetAt >= before + 7 * 60_000);
    assert.ok(resetAt <= after + 7 * 60_000);
  });

  it('defaults the fallback to DEFAULT_COOLDOWN_MINUTES', () => {
    const cooling = new CoolingMap();
    const before = Date.now();
    const resetAt = cooling.enter('acc-1', 'model-a');
    const after = Date.now();
    assert.ok(resetAt >= before + DEFAULT_COOLDOWN_MINUTES * 60_000);
    assert.ok(resetAt <= after + DEFAULT_COOLDOWN_MINUTES * 60_000);
  });

  it('treats an already-expired explicit resetAt as not cooling', () => {
    const cooling = new CoolingMap();
    cooling.enter('acc-1', 'model-a', { resetAt: Date.now() - 1_000 });
    assert.equal(cooling.active('acc-1', 'model-a'), false);
  });
});

describe('CoolingMap wildcard and scoping', () => {
  it("cools every model of the account when model is '*'", () => {
    const cooling = new CoolingMap();
    cooling.enter('acc-1', '*', { resetAt: Date.now() + 60_000 });
    assert.equal(cooling.active('acc-1', 'model-a'), true);
    assert.equal(cooling.active('acc-1', 'model-b'), true);
    assert.equal(cooling.active('acc-2', 'model-a'), false);
  });

  it('keeps model-specific cooldowns scoped to that model', () => {
    const cooling = new CoolingMap();
    cooling.enter('acc-1', 'model-a', { resetAt: Date.now() + 60_000 });
    assert.equal(cooling.active('acc-1', 'model-a'), true);
    assert.equal(cooling.active('acc-1', 'model-b'), false);
  });

  it('lists every cooldown of an account including the wildcard', () => {
    const cooling = new CoolingMap();
    const star = Date.now() + 60_000;
    cooling.enter('acc-1', '*', { resetAt: star });
    cooling.enter('acc-1', 'model-a', { resetAt: star + 1_000 });
    cooling.enter('acc-2', 'model-a', { resetAt: star });
    const list = cooling.listForAccount('acc-1');
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((entry) => entry.model).sort(), ['*', 'model-a']);
  });
});

describe('CoolingMap cleanup and manual reset', () => {
  it('lazily drops expired entries', async () => {
    const cooling = new CoolingMap();
    cooling.enter('acc-1', 'model-a', { resetAt: Date.now() + 40 });
    cooling.enter('acc-1', 'model-b', { resetAt: Date.now() + 60_000 });
    assert.equal(cooling.active('acc-1', 'model-a'), true);
    await sleep(60);
    assert.equal(cooling.active('acc-1', 'model-a'), false);
    const list = cooling.listForAccount('acc-1');
    assert.deepEqual(
      list.map((entry) => entry.model),
      ['model-b'],
    );
  });

  it('clearAccount removes all cooldowns of one account and reports the count', () => {
    const cooling = new CoolingMap();
    cooling.enter('acc-1', '*', { resetAt: Date.now() + 60_000 });
    cooling.enter('acc-1', 'model-a', { resetAt: Date.now() + 60_000 });
    cooling.enter('acc-2', 'model-a', { resetAt: Date.now() + 60_000 });
    const cleared = cooling.clearAccount('acc-1');
    assert.equal(cleared, 2);
    assert.equal(cooling.active('acc-1', 'model-a'), false);
    assert.equal(cooling.active('acc-1', 'model-b'), false);
    assert.equal(cooling.active('acc-2', 'model-a'), true);
  });

  it('clearAll drops every cooldown', () => {
    const cooling = new CoolingMap();
    cooling.enter('acc-1', 'model-a', { resetAt: Date.now() + 60_000 });
    cooling.enter('acc-2', 'model-b', { resetAt: Date.now() + 60_000 });
    cooling.clearAll();
    assert.equal(cooling.active('acc-1', 'model-a'), false);
    assert.equal(cooling.active('acc-2', 'model-b'), false);
    assert.equal(cooling.listForAccount('acc-1').length, 0);
  });
});
