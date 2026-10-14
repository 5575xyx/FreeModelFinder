import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CallLogger, startOfBucket } from '../call-logger.js';
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

  it('cleans up files older than the 90-day retention window', async () => {
    // Own directory: the shared logger's files from other cases would be
    // deleted too, so the exact removal count could not be asserted.
    const cleanupDir = await mkdtemp(join(tmpdir(), 'fmf-call-logger-cleanup-'));
    const own = new CallLogger(cleanupDir);
    own.record(entry({ ts: Date.now() - 91 * 86_400_000, model: 'ancient' }));
    own.record(entry({ ts: Date.now() - 89 * 86_400_000, model: 'recent' }));
    await own.flush();

    const removed = await own.cleanup(Date.now());
    assert.equal(removed, 1, '只有 91 天前的文件被删');

    // The 89-day-old entry is still readable (from memory or disk).
    const kept = await own.list({ model: 'recent' });
    assert.ok(kept.length >= 1);
    await rm(cleanupDir, { recursive: true, force: true });
  });

  it('pages by cursor without losing or repeating entries that share a timestamp', async () => {
    // Its own directory: the shared logger's JSONL files (other cases record at
    // Date.now()) would otherwise appear in the newest-first pages.
    const pagedDir = await mkdtemp(join(tmpdir(), 'fmf-call-logger-page-'));
    const paged = new CallLogger(pagedDir);
    const sameTs = 1_700_000_000_000;
    for (const model of ['a', 'b', 'c']) {
      paged.record(entry({ ts: sameTs, model }));
    }
    paged.record(entry({ ts: sameTs - 1, model: 'd' }));
    await paged.flush();

    const seen: string[] = [];
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await paged.listPage({ limit: 2, cursor });
      pages.push(page.data.map((e) => e.model));
      seen.push(...page.data.map((e) => e.model));
      if (!page.nextCursor) {
        assert.equal(page.nextCursor, null, '最后一页必须没有 nextCursor');
        break;
      }
      cursor = page.nextCursor;
    }
    // Nothing lost: every entry exactly once, across all pages.
    assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd']);
    // Nothing repeated: the union of pages covers 4 entries over 2 pages.
    assert.equal(seen.length, 4);
    assert.equal(pages[0]?.length, 2);
    assert.equal(pages[1]?.length, 2);
    await rm(pagedDir, { recursive: true, force: true });
  });

  it('starts from the beginning when the cursor is malformed', async () => {
    const pagedDir = await mkdtemp(join(tmpdir(), 'fmf-call-logger-page-'));
    const paged = new CallLogger(pagedDir);
    paged.record(entry({ ts: 2, model: 'cursor-fixture' }));
    await paged.flush();
    const page = await paged.listPage({ limit: 10, cursor: 'abc' });
    assert.ok(page.data.some((e) => e.model === 'cursor-fixture'));
    const all = await paged.list({ limit: 10 });
    assert.equal(page.data.length, all.length);
    await rm(pagedDir, { recursive: true, force: true });
  });

  it('buckets a series by local day and zero-fills empty days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmf-call-logger-series-'));
    const logger = new CallLogger(dir);
    const now = new Date(2026, 9, 14, 12, 0, 0).getTime(); // 2026-10-14 本地
    logger.record(
      entry({
        ts: new Date(2026, 9, 12, 9, 0, 0).getTime(),
        model: 'series-a',
        promptTokens: 10,
      }),
    );
    logger.record(
      entry({
        ts: new Date(2026, 9, 14, 9, 0, 0).getTime(),
        model: 'series-a',
        status: 'error',
        promptTokens: 5,
      }),
    );
    await logger.flush();

    const series = await logger.series('7d', 'day', now);
    assert.equal(series.points.length, 8, '7 天范围应含 8 个日桶（10-07..10-14）');
    const byDate = new Map(series.points.map((p) => [new Date(p.start).getDate(), p]));
    assert.equal(byDate.get(13)!.calls, 0, '空缺日必须补 0');
    assert.equal(byDate.get(12)!.calls, 1);
    assert.equal(byDate.get(14)!.calls, 1);
    assert.equal(byDate.get(14)!.errors, 1);
    assert.equal(byDate.get(14)!.promptTokens, 5);
    await rm(dir, { recursive: true, force: true });
  });

  it('starts weeks on Monday in local time', () => {
    const sunday = new Date(2026, 9, 11, 23, 59, 0).getTime(); // 周日
    const monday = new Date(2026, 9, 12, 0, 1, 0).getTime(); // 周一
    assert.notEqual(startOfBucket(sunday, 'week'), startOfBucket(monday, 'week'));
    assert.equal(new Date(startOfBucket(monday, 'week')).getDay(), 1);
  });

  it('starts months at the local first day', () => {
    const monthEnd = new Date(2026, 8, 30, 23, 59, 0).getTime();
    const nextMonth = new Date(2026, 9, 1, 0, 1, 0).getTime();
    assert.notEqual(startOfBucket(monthEnd, 'month'), startOfBucket(nextMonth, 'month'));
    assert.equal(new Date(startOfBucket(nextMonth, 'month')).getDate(), 1);
  });
});
