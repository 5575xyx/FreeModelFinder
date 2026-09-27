import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { UsageAggregator } from '../usage-aggregator.js';
import type { CredentialPlatform } from '../../types.js';

const asPlatform = (name: string): CredentialPlatform => name as CredentialPlatform;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('UsageAggregator', () => {
  let dir: string;
  let usageFile: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fmf-usage-'));
    usageFile = join(dir, 'credentials-usage.json');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accumulates requests and tokens per account', async () => {
    const usage = new UsageAggregator({ dir });
    usage.record('cline', 'acc-1', { promptTokens: 100, completionTokens: 20 });
    usage.record('cline', 'acc-1', { promptTokens: 50, completionTokens: 10, requests: 3 });
    usage.record('cline', 'acc-2', { promptTokens: 7 });
    usage.record(asPlatform('other'), 'acc-9', { promptTokens: 1 });

    const rows = usage.snapshot('cline');
    assert.equal(rows.length, 2);
    const acc1 = rows.find((row) => row.accountId === 'acc-1');
    assert.equal(acc1?.requests, 4);
    assert.equal(acc1?.promptTokens, 150);
    assert.equal(acc1?.completionTokens, 30);
    const acc2 = rows.find((row) => row.accountId === 'acc-2');
    assert.equal(acc2?.requests, 1);
    assert.equal(usage.snapshot(asPlatform('other')).length, 1);
    assert.deepEqual(usage.snapshot(asPlatform('missing')), []);
    await usage.flush();
  });

  it('defaults to one request per record call', async () => {
    const usage = new UsageAggregator({ dir });
    usage.record(asPlatform('defaults'), 'acc-1', {});
    const rows = usage.snapshot(asPlatform('defaults'));
    assert.equal(rows[0]?.requests, 1);
    assert.equal(rows[0]?.promptTokens, 0);
    assert.equal(rows[0]?.completionTokens, 0);
    await usage.flush();
  });

  it('writes to disk only after the throttle window elapses', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'fmf-usage-throttle-'));
    try {
      const freshFile = join(fresh, 'credentials-usage.json');
      const usage = new UsageAggregator({ dir: fresh, throttleMs: 50 });
      usage.record(asPlatform('throttled'), 'acc-1', { promptTokens: 5 });
      assert.equal(existsSync(freshFile), false);
      await sleep(150);
      assert.equal(existsSync(freshFile), true);
      const persisted = JSON.parse(await readFile(freshFile, 'utf8'));
      assert.equal(persisted.throttled['acc-1'].promptTokens, 5);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('flushes immediately on demand', async () => {
    const usage = new UsageAggregator({ dir, throttleMs: 60_000 });
    usage.record(asPlatform('manual'), 'acc-1', { promptTokens: 11 });
    await usage.flush();
    const persisted = JSON.parse(await readFile(usageFile, 'utf8'));
    assert.equal(persisted.manual['acc-1'].promptTokens, 11);
  });

  it('reloads persisted usage on restart', async () => {
    const first = new UsageAggregator({ dir });
    first.record(asPlatform('restart'), 'acc-1', { promptTokens: 30, completionTokens: 12 });
    await first.flush();

    const second = new UsageAggregator({ dir });
    await second.load();
    const rows = second.snapshot(asPlatform('restart'));
    assert.equal(rows[0]?.promptTokens, 30);
    assert.equal(rows[0]?.completionTokens, 12);
    second.record(asPlatform('restart'), 'acc-1', { promptTokens: 5 });
    const merged = second.snapshot(asPlatform('restart'));
    assert.equal(merged[0]?.promptTokens, 35);
    await second.flush();
  });

  it('stores only the latest error with secrets redacted', async () => {
    const usage = new UsageAggregator({ dir });
    const token = 'eyJhbGciOiJIUzI1NiJ9'.repeat(4);
    usage.record('cline', 'acc-err', { error: `401 failed, Bearer ${token}` });
    usage.record('cline', 'acc-err', {
      error: `refresh_token=${'B'.repeat(50)} retry later`,
    });
    const rows = usage.snapshot('cline');
    const row = rows.find((entry) => entry.accountId === 'acc-err');
    assert.ok(row?.lastError?.includes('retry later'));
    assert.ok(!row?.lastError?.includes('B'.repeat(50)));
    assert.match(row?.lastError ?? '', /refresh_token=\[REDACTED\]/);

    usage.record('cline', 'acc-err2', { error: `upstream 401 Bearer ${'C'.repeat(60)}` });
    const row2 = usage.snapshot('cline').find((entry) => entry.accountId === 'acc-err2');
    assert.match(row2?.lastError ?? '', /Bearer \[REDACTED\]/);
    assert.ok(!row2?.lastError?.includes('C'.repeat(60)));
    await usage.flush();
  });

  it('tolerates a missing usage file on load', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'fmf-usage-missing-'));
    try {
      const usage = new UsageAggregator({ dir: fresh });
      await usage.load();
      assert.deepEqual(usage.snapshot('cline'), []);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
