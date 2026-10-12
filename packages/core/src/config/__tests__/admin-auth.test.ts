import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertAdminPasswordUsable,
  hashAdminPassword,
  MIN_ADMIN_PASSWORD_LENGTH,
  verifyAdminPassword,
  type AdminAuthSettings,
} from '../admin-auth.js';

const PASSWORD = 'correct-horse-battery';

describe('hashAdminPassword', () => {
  it('produces a verifier that accepts its own password', async () => {
    const admin = await hashAdminPassword(PASSWORD);
    await assert.doesNotReject(() => verifyAdminPassword(PASSWORD, admin));
    assert.equal(await verifyAdminPassword(PASSWORD, admin), true);
  });

  it('never echoes the password back into the stored settings', async () => {
    const admin = await hashAdminPassword(PASSWORD);
    assert.ok(!admin.passwordHash.includes(PASSWORD));
    assert.ok(!admin.passwordSalt.includes(PASSWORD));
    assert.ok(admin.createdAt > 0);
  });

  it('salt is random, so equal passwords produce different verifiers', async () => {
    const [a, b] = await Promise.all([hashAdminPassword(PASSWORD), hashAdminPassword(PASSWORD)]);
    assert.notEqual(a.passwordSalt, b.passwordSalt);
    assert.notEqual(a.passwordHash, b.passwordHash);
  });

  it('rejects passwords shorter than the minimum', async () => {
    assert.throws(() => assertAdminPasswordUsable('short'), /at least/);
    await assert.rejects(() => hashAdminPassword('short'));
  });

  it('accepts exactly the minimum length', async () => {
    const admin = await hashAdminPassword('x'.repeat(MIN_ADMIN_PASSWORD_LENGTH));
    assert.equal(await verifyAdminPassword('x'.repeat(MIN_ADMIN_PASSWORD_LENGTH), admin), true);
  });
});

describe('verifyAdminPassword', () => {
  it('rejects a wrong password', async () => {
    const admin = await hashAdminPassword(PASSWORD);
    assert.equal(await verifyAdminPassword('correct-horse-stapler', admin), false);
  });

  it('returns false rather than throwing when nothing is configured', async () => {
    assert.equal(await verifyAdminPassword(PASSWORD, undefined), false);
  });

  it('returns false for empty or non-string input', async () => {
    const admin = await hashAdminPassword(PASSWORD);
    assert.equal(await verifyAdminPassword('', admin), false);
    assert.equal(await verifyAdminPassword(undefined as unknown as string, admin), false);
  });

  it('fails closed on every shape of hand-edited stored state', async () => {
    const admin = await hashAdminPassword(PASSWORD);
    // A hand-edited config must be able to lock the panel out, never crash the
    // gateway, and never report success — so every absent or malformed field is
    // exercised here as plain JSON that could actually sit on disk.
    const broken: Array<[string, Partial<AdminAuthSettings>]> = [
      ['missing hash', { ...admin, passwordHash: undefined }],
      ['blank hash', { ...admin, passwordHash: '' }],
      ['missing salt', { ...admin, passwordSalt: undefined }],
      ['blank salt', { ...admin, passwordSalt: '' }],
      ['undecodable hash', { ...admin, passwordHash: '%%%not-base64%%%' }],
      ['zero-length hash', { ...admin, passwordHash: Buffer.from('').toString('base64') }],
    ];
    for (const [label, settings] of broken) {
      assert.equal(await verifyAdminPassword(PASSWORD, settings), false, label);
    }
  });
});

describe('config persistence', () => {
  it('survives a save/load round trip without being encrypted or stripped', async () => {
    const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-admin-auth-'));
    process.env.FREEMODELFINDER_HOME = testHome;
    const { readFile } = await import('node:fs/promises');
    const { CONFIG_PATH, loadConfig, saveConfig } = await import('../store.js');

    const admin = await hashAdminPassword(PASSWORD);
    await saveConfig({
      version: 2,
      port: 11435,
      providers: {},
      gateway: { requireAuth: true, apiKey: 'gateway-secret' },
      adminAuth: admin,
    });

    const loaded = await loadConfig();
    assert.deepEqual(loaded.adminAuth, admin);
    assert.equal(await verifyAdminPassword(PASSWORD, loaded.adminAuth), true);

    const raw = await readFile(CONFIG_PATH, 'utf8');
    const persisted = JSON.parse(raw) as Record<string, unknown> & {
      adminAuth: AdminAuthSettings;
    };
    assert.ok(!raw.includes(PASSWORD), 'password must not be written in plaintext');
    // encryptProviders must leave adminAuth untouched: the verifier sits in the
    // config as a bare scrypt hash, not wrapped as an encrypted secret.
    assert.ok(!persisted.adminAuth.passwordHash.startsWith('v3:'), 'hash must not be encrypted');
    assert.ok(!persisted.adminAuth.passwordSalt.startsWith('v3:'), 'salt must not be encrypted');
  });
});
