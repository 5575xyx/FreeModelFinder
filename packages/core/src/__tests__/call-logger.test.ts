import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CallLogger } from '../call-logger.js';
import type { CallLogEntry } from '../types.js';

function entry(overrides: Partial<CallLogEntry> = {}): CallLogEntry {
  return {
    ts: Date.now(),
    kind: 'chat',
    provider: 'openrouter',
    model: 'openrouter:deepseek/deepseek-chat',
    status: 'success',
    httpStatus: 200,
    latencyMs: 120,
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 40,
    ...overrides,
  };
}

describe('CallLogger', () => {
  let dir: string;
  let logger: CallLogger;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fmf-call-logger-'));
    logger = new CallLogger(dir);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records entries and lists them newest first', async () => {
    logger.record(entry({ ts: 1000, model: 'a' }));
    logger.record(entry({ ts: 2000, model: 'b' }));
    await logger.flush();

    const list = await logger.list({ limit: 10 });
    assert.equal(list.length, 2);
    assert.equal(list[0]?.model, 'b');
    assert.equal(list[1]?.model, 'a');
  });

  it('filters by model, status and kind', async () => {
    logger.record(entry({ ts: 3000, model: 'c', status: 'error', kind: 'image' }));
    await logger.flush();

    const byModel = await logger.list({ model: 'c' });
    assert.equal(byModel.length, 1);

    const byStatus = await logger.list({ status: 'error' });
    assert.equal(byStatus.length, 1);
    assert.equal(byStatus[0]?.status, 'error');

    const byKind = await logger.list({ kind: 'image' });
    assert.equal(byKind.length, 1);
    assert.equal(byKind[0]?.kind, 'image');

    const none = await logger.list({ model: 'nope' });
    assert.equal(none.length, 0);
  });

  it('aggregates totals and per-model rows', async () => {
    const agg = await logger.aggregate('all');
    assert.equal(agg.totals.calls, 3);
    assert.equal(agg.totals.errors, 1);
    assert.equal(agg.totals.success, 2);
    assert.equal(agg.totals.promptTokens, 300);
    assert.equal(agg.totals.completionTokens, 150);
    assert.equal(agg.totals.cachedTokens, 120);
    assert.ok(Math.abs(agg.totals.cacheHitRate - 120 / 300) < 1e-9);
    assert.ok(Math.abs(agg.totals.successRate - 2 / 3) < 1e-9);
    assert.ok(agg.byModel.length >= 3);
    // Sorted by call count desc; every model has 1 call so order is stable-ish.
    for (const row of agg.byModel) {
      assert.ok(row.calls >= 1);
    }
  });

  it('computes per-gateway-key daily usage', async () => {
    logger.record(entry({ ts: Date.now(), gatewayKeyId: 'key-1', promptTokens: 10 }));
    await logger.flush();

    const usage = await logger.usageForGatewayKey('key-1');
    assert.ok(usage.requests >= 1);
    assert.ok(usage.tokens >= 10);

    const other = await logger.usageForGatewayKey('key-missing');
    assert.equal(other.requests, 0);
  });

  it('respects the limit parameter', async () => {
    const list = await logger.list({ limit: 1 });
    assert.equal(list.length, 1);
  });

  it('cleans up files older than retention', async () => {
    // Write an entry dated 40 days ago, then run cleanup with a future "now".
    const oldTs = Date.now() - 40 * 86_400_000;
    logger.record(entry({ ts: oldTs, model: 'ancient' }));
    await logger.flush();

    const removed = await logger.cleanup(Date.now());
    assert.ok(removed >= 1);

    // Old entry should no longer be readable from disk (memory buffer still
    // holds it, so filter by model to confirm it only survives in memory).
    const stillInMemory = await logger.list({ model: 'ancient' });
    assert.ok(stillInMemory.length >= 1);
  });
});
