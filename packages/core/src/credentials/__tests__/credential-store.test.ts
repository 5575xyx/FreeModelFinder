import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { CredentialAccountEntry, AppConfig } from '../../types.js';

const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-credentials-'));
process.env.FREEMODELFINDER_HOME = testHome;

const { CONFIG_PATH, loadMasterKey } = await import('../../config/store.js');
const { encryptString } = await import('../../config/crypto.js');
const { getPool, upsertAccount, removeAccount, saveSettings } =
  await import('../credential-store.js');

function account(overrides: Partial<CredentialAccountEntry> = {}): CredentialAccountEntry {
  return {
    id: 'acc-1',
    label: 'user@example.com',
    status: 'active',
    addedAt: 1_700_000_000_000,
    payload: {
      refreshToken: 'plain-refresh-secret',
      email: 'user@example.com',
      baseUrl: 'https://example.test',
    },
    ...overrides,
  };
}

async function resetHome(): Promise<void> {
  await rm(testHome, { recursive: true, force: true });
  await mkdir(testHome, { recursive: true, mode: 0o700 });
}

async function readRawConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

describe('credential-store encryption boundary', () => {
  beforeEach(resetHome);

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  it('encrypts refreshToken as v3 ciphertext on disk and returns plaintext on read', async () => {
    await upsertAccount('cline', account());

    const raw = await readFile(CONFIG_PATH, 'utf8');
    assert.ok(!raw.includes('plain-refresh-secret'), 'plaintext refreshToken leaked to disk');
    const persisted = (await readRawConfig()).credentials.cline.accounts[0];
    const stored = persisted.payload.refreshToken as string;
    assert.ok(stored.startsWith('v3:'), `expected v3 ciphertext, got ${stored.slice(0, 8)}`);
    assert.ok(!stored.startsWith('v2:'));

    const pool = await getPool('cline');
    assert.equal(pool.accounts[0]?.payload.refreshToken, 'plain-refresh-secret');
    assert.equal(pool.accounts[0]?.payload.email, 'user@example.com');
  });

  it('keeps non-sensitive payload fields in plaintext', async () => {
    await upsertAccount('cline', account());
    const persisted = (await readRawConfig()).credentials.cline.accounts[0];
    assert.equal(persisted.payload.email, 'user@example.com');
    assert.equal(persisted.payload.baseUrl, 'https://example.test');
  });

  it('decrypts multi-layer legacy ciphertext through decryptSecret', async () => {
    const masterKey = await loadMasterKey();
    const nested = encryptString(encryptString('nested-secret', masterKey), masterKey);
    const config: AppConfig = {
      version: 2,
      port: 11435,
      providers: {},
      credentials: {
        cline: {
          accounts: [
            {
              id: 'acc-nested',
              status: 'active',
              addedAt: 1_700_000_000_000,
              payload: { refreshToken: nested },
            },
          ],
        },
      },
    };
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });

    const pool = await getPool('cline');
    assert.equal(pool.accounts[0]?.payload.refreshToken, 'nested-secret');
  });

  it('persists invalid status across write and read', async () => {
    await upsertAccount('cline', account());
    await upsertAccount('cline', account({ status: 'invalid' }));

    const persisted = (await readRawConfig()).credentials.cline.accounts[0];
    assert.equal(persisted.status, 'invalid');
    const pool = await getPool('cline');
    assert.equal(pool.accounts[0]?.status, 'invalid');
    assert.equal(pool.accounts.length, 1);
  });
});

describe('credential-store pool operations', () => {
  beforeEach(resetHome);

  it('removes an account by id and keeps the rest', async () => {
    await upsertAccount('cline', account());
    await upsertAccount('cline', account({ id: 'acc-2', label: 'second' }));

    await removeAccount('cline', 'acc-1');
    const pool = await getPool('cline');
    assert.deepEqual(
      pool.accounts.map((entry) => entry.id),
      ['acc-2'],
    );
  });

  it('saves pool settings without touching accounts', async () => {
    await upsertAccount('cline', account());
    await saveSettings('cline', { strategy: 'fill', cooldownFallbackMinutes: 9 });

    const pool = await getPool('cline');
    assert.equal(pool.strategy, 'fill');
    assert.equal(pool.cooldownFallbackMinutes, 9);
    assert.equal(pool.accounts.length, 1);
    assert.equal(pool.accounts[0]?.payload.refreshToken, 'plain-refresh-secret');
  });

  it('returns an empty pool when credentials or accounts are missing', async () => {
    const empty: AppConfig = { version: 2, port: 11435, providers: {}, credentials: {} };
    await writeFile(CONFIG_PATH, JSON.stringify(empty, null, 2), { mode: 0o600 });
    assert.deepEqual(await getPool('cline'), { accounts: [] });

    const noAccounts: AppConfig = {
      version: 2,
      port: 11435,
      providers: {},
      credentials: { cline: {} as never },
    };
    await writeFile(CONFIG_PATH, JSON.stringify(noAccounts, null, 2), { mode: 0o600 });
    assert.deepEqual(await getPool('cline'), { accounts: [] });

    const badAccounts: AppConfig = {
      version: 2,
      port: 11435,
      providers: {},
      credentials: { cline: { accounts: 'nope' } as never },
    };
    await writeFile(CONFIG_PATH, JSON.stringify(badAccounts, null, 2), { mode: 0o600 });
    assert.deepEqual(await getPool('cline'), { accounts: [] });
  });
});
