import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { CredentialAccountEntry } from '../../types.js';

const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-runtime-'));
process.env.FREEMODELFINDER_HOME = testHome;

const { CONFIG_PATH } = await import('../../config/store.js');
const { createTestRuntime, getCredentialRuntime } = await import('../runtime.js');

function account(overrides: Partial<CredentialAccountEntry> = {}): CredentialAccountEntry {
  return {
    id: 'acc-1',
    label: 'user@example.com',
    status: 'active',
    addedAt: 1_700_000_000_000,
    payload: { refreshToken: 'plain-refresh-secret', email: 'user@example.com' },
    ...overrides,
  };
}

async function readRawConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

async function resetHome(): Promise<void> {
  await rm(testHome, { recursive: true, force: true });
  await mkdir(testHome, { recursive: true, mode: 0o700 });
}

describe('CredentialRuntime lifecycle', () => {
  beforeEach(resetHome);

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  it('runs the full upsert → active → next → invalid chain', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    assert.equal(runtime.hasActiveAccounts('cline'), false);

    await runtime.upsertAccount('cline', account());
    assert.equal(runtime.hasActiveAccounts('cline'), true);

    const picked = runtime.nextAccount('cline', 'model-x');
    assert.equal(picked?.id, 'acc-1');
    assert.equal(picked?.payload.refreshToken, 'plain-refresh-secret');

    runtime.reportInvalid('cline', 'acc-1');
    assert.equal(runtime.hasActiveAccounts('cline'), false);
    assert.equal(runtime.nextAccount('cline', 'model-x'), null);
    await runtime.waitForPersist();

    const persisted = (await readRawConfig()).credentials.cline.accounts[0];
    assert.equal(persisted.status, 'invalid');
  });

  it('serves sync methods from the in-memory mirror right after upsert resolves', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    await runtime.upsertAccount('cline', account({ id: 'mirror-1' }));

    assert.equal(runtime.hasActiveAccounts('cline'), true);
    assert.equal(runtime.nextAccount('cline', 'model-x')?.id, 'mirror-1');
    const pool = await runtime.getPool('cline');
    assert.equal(pool.accounts[0]?.payload.refreshToken, 'plain-refresh-secret');
    const persisted = (await readRawConfig()).credentials.cline.accounts[0];
    assert.ok(
      (persisted.payload.refreshToken as string).startsWith('v3:'),
      'disk copy must stay encrypted',
    );
  });

  it('persists lastUsedAt only after the throttle while invalid lands immediately', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    await runtime.upsertAccount('cline', account());
    await runtime.waitForPersist();

    const before = (await readRawConfig()).credentials.cline.accounts[0];
    assert.equal(before.lastUsedAt, undefined);

    runtime.nextAccount('cline', 'model-x');
    const throttled = (await readRawConfig()).credentials.cline.accounts[0];
    assert.equal(throttled.lastUsedAt, undefined, 'meta write must stay throttled');

    runtime.reportInvalid('cline', 'acc-1');
    await runtime.waitForPersist();
    const after = (await readRawConfig()).credentials.cline.accounts[0];
    assert.equal(after.status, 'invalid');
    assert.ok((after.lastUsedAt ?? 0) > 0);
  });

  it('wires rate-limit cooldowns through list and clear', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    await runtime.upsertAccount('cline', account());

    const resetAt = Date.now() + 60_000;
    runtime.reportRateLimit('cline', 'acc-1', 'model-x', resetAt);
    const listed = runtime.listAccountCooldowns('cline', 'acc-1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.model, 'model-x');
    assert.equal(listed[0]?.resetAt, resetAt);
    assert.equal(runtime.nextAccount('cline', 'model-x'), null);
    assert.equal(runtime.nextAccount('cline', 'model-y')?.id, 'acc-1');

    const cleared = runtime.clearAccountCooldowns('cline', 'acc-1');
    assert.equal(cleared, 1);
    assert.deepEqual(runtime.listAccountCooldowns('cline', 'acc-1'), []);
    assert.equal(runtime.nextAccount('cline', 'model-x')?.id, 'acc-1');
  });

  it('records usage and flushes it to disk', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    runtime.recordUsage('cline', 'acc-1', 'model-x', { promptTokens: 40, completionTokens: 6 });
    runtime.recordUsage('cline', 'acc-1', 'model-x', { promptTokens: 10, error: 'upstream 429' });

    const rows = runtime.snapshotUsage('cline');
    assert.equal(rows[0]?.requests, 2);
    assert.equal(rows[0]?.promptTokens, 50);
    assert.equal(rows[0]?.completionTokens, 6);
    assert.match(rows[0]?.lastError ?? '', /429/);

    await runtime.waitForPersist();
    const usageFile = JSON.parse(await readFile(join(testHome, 'credentials-usage.json'), 'utf8'));
    assert.equal(usageFile.cline['acc-1'].promptTokens, 50);
    assert.ok(!JSON.stringify(usageFile).includes('refreshToken'));
  });

  it('removes accounts from memory and disk', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    await runtime.upsertAccount('cline', account({ id: 'keep' }));
    await runtime.upsertAccount('cline', account({ id: 'drop' }));

    await runtime.removeAccount('cline', 'drop');
    assert.equal(runtime.hasActiveAccounts('cline'), true);
    assert.equal(runtime.nextAccount('cline', 'model-x')?.id, 'keep');
    const pool = await runtime.getPool('cline');
    assert.deepEqual(
      pool.accounts.map((entry) => entry.id),
      ['keep'],
    );
    const persisted = (await readRawConfig()).credentials.cline.accounts;
    assert.deepEqual(
      persisted.map((entry: { id: string }) => entry.id),
      ['keep'],
    );

    await runtime.removeAccount('cline', 'keep');
    assert.equal(runtime.hasActiveAccounts('cline'), false);
    assert.equal(runtime.nextAccount('cline', 'model-x'), null);
  });

  it('saves pool settings to memory and disk', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    await runtime.upsertAccount('cline', account());
    await runtime.saveSettings('cline', { strategy: 'fill', cooldownFallbackMinutes: 3 });

    const pool = await runtime.getPool('cline');
    assert.equal(pool.strategy, 'fill');
    assert.equal(pool.cooldownFallbackMinutes, 3);
    const persisted = (await readRawConfig()).credentials.cline;
    assert.equal(persisted.strategy, 'fill');
    assert.equal(persisted.cooldownFallbackMinutes, 3);
    assert.equal(persisted.accounts.length, 1);
  });

  it('reloads the persisted pool into a fresh runtime instance', async () => {
    const first = createTestRuntime({ throttleMs: 60_000 });
    await first.upsertAccount('cline', account({ id: 'warm' }));
    await first.waitForPersist();

    const second = createTestRuntime({ throttleMs: 60_000 });
    const pool = await second.getPool('cline');
    assert.equal(pool.accounts.length, 1);
    assert.equal(second.hasActiveAccounts('cline'), true);
    const picked = second.nextAccount('cline', 'model-x');
    assert.equal(picked?.id, 'warm');
    assert.equal(picked?.payload.refreshToken, 'plain-refresh-secret');
  });

  it('returns an empty pool for unknown platforms', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    const pool = await runtime.getPool('cline');
    assert.deepEqual(pool, { accounts: [] });
    assert.equal(runtime.hasActiveAccounts('cline'), false);
    assert.equal(runtime.nextAccount('cline', 'model-x'), null);
    assert.deepEqual(runtime.listAccountCooldowns('cline', 'ghost'), []);
    assert.equal(runtime.clearAccountCooldowns('cline', 'ghost'), 0);
    assert.deepEqual(runtime.snapshotUsage('cline'), []);
  });

  it('exposes a process singleton through getCredentialRuntime', async () => {
    const first = getCredentialRuntime();
    await first.getPool('cline');
    const second = getCredentialRuntime();
    assert.equal(first, second);
  });

  it('survives a corrupt config at startup and recovers after the disk is fixed', async () => {
    await writeFile(CONFIG_PATH, '{"version":2,', { mode: 0o600 });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const runtime = createTestRuntime({ throttleMs: 60_000 });
      await assert.rejects(() => runtime.getPool('cline'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(rejections.length, 0);

      await writeFile(CONFIG_PATH, JSON.stringify({ version: 2, port: 11435, providers: {} }), {
        mode: 0o600,
      });
      const pool = await runtime.getPool('cline');
      assert.deepEqual(pool, { accounts: [] });
      await runtime.upsertAccount('cline', account({ id: 'recovered' }));
      assert.equal(runtime.hasActiveAccounts('cline'), true);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('keeps saveSettings visible in memory before and after upsert', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    await runtime.saveSettings('cline', { strategy: 'fill', cooldownFallbackMinutes: 4 });

    const pool = await runtime.getPool('cline');
    assert.equal(pool.strategy, 'fill');
    assert.equal(pool.cooldownFallbackMinutes, 4);

    await runtime.upsertAccount('cline', account());
    const after = await runtime.getPool('cline');
    assert.equal(after.strategy, 'fill');
    assert.equal(after.accounts.length, 1);

    const persisted = (await readRawConfig()).credentials.cline;
    assert.equal(persisted.strategy, 'fill');
    assert.equal(persisted.accounts.length, 1);
  });

  it('keeps the disk clean when an account is removed after being marked dirty', async () => {
    const runtime = createTestRuntime({ throttleMs: 60_000 });
    await runtime.upsertAccount('cline', account({ id: 'gone' }));
    await runtime.waitForPersist();

    runtime.nextAccount('cline', 'model-x');
    await runtime.removeAccount('cline', 'gone');
    await runtime.waitForPersist();

    const persisted = (await readRawConfig()).credentials.cline.accounts;
    assert.deepEqual(persisted, []);
    assert.equal(runtime.hasActiveAccounts('cline'), false);
  });
});
