import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccountPool } from '../account-pool.js';
import { CoolingMap } from '../cooling-map.js';
import type {
  CredentialAccountEntry,
  CredentialPlatform,
  CredentialPoolConfig,
} from '../../types.js';

const asPlatform = (name: string): CredentialPlatform => name as CredentialPlatform;

function accounts(...ids: string[]): CredentialAccountEntry[] {
  return ids.map((id) => ({
    id,
    status: 'active' as const,
    addedAt: 1_700_000_000_000,
    payload: {},
  }));
}

interface ChangeRecord {
  accountId: string;
  kind: 'meta' | 'status';
}

function makePool(
  poolConfig: CredentialPoolConfig,
  options: { random?: () => number; cooling?: CoolingMap } = {},
) {
  const cooling = options.cooling ?? new CoolingMap();
  const changes: ChangeRecord[] = [];
  const pool = new AccountPool({
    getPool: (platform) => (platform === 'cline' ? poolConfig : undefined),
    cooling: () => cooling,
    onAccountChange: (_platform, entry, kind) => changes.push({ accountId: entry.id, kind }),
    random: options.random,
  });
  return { pool, cooling, changes };
}

describe('AccountPool strategy rotation', () => {
  it('round_robin cycles through the ring in order', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a', 'b', 'c') };
    const { pool } = makePool(config);
    const order = Array.from({ length: 6 }, () => pool.next('cline', 'model-x')?.id);
    assert.deepEqual(order, ['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('fill keeps the same account until it becomes unavailable', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a', 'b', 'c'), strategy: 'fill' };
    const { pool, cooling } = makePool(config);
    assert.equal(pool.next('cline', 'model-x')?.id, 'a');
    assert.equal(pool.next('cline', 'model-x')?.id, 'a');
    assert.equal(pool.next('cline', 'model-x')?.id, 'a');
    cooling.enter('a', 'model-x', { resetAt: Date.now() + 60_000 });
    assert.equal(pool.next('cline', 'model-x')?.id, 'b');
    assert.equal(pool.next('cline', 'model-x')?.id, 'b');
  });

  it('random picks through an injectable RNG', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a', 'b', 'c'), strategy: 'random' };
    const first = makePool(config, { random: () => 0 });
    assert.equal(first.pool.next('cline', 'model-x')?.id, 'a');
    const last = makePool(config, { random: () => 0.999 });
    assert.equal(last.pool.next('cline', 'model-x')?.id, 'c');
  });
});

describe('AccountPool availability filtering', () => {
  it('skips invalid accounts', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a', 'b') };
    config.accounts[0]!.status = 'invalid';
    const { pool } = makePool(config);
    assert.equal(pool.next('cline', 'model-x')?.id, 'b');
  });

  it('skips accounts with a matching active cooldown only', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a', 'b') };
    const { pool, cooling } = makePool(config);
    cooling.enter('a', 'model-x', { resetAt: Date.now() + 60_000 });
    assert.equal(pool.next('cline', 'model-x')?.id, 'b');
    assert.equal(pool.next('cline', 'model-y')?.id, 'a');
  });

  it('returns null when every account is unusable', () => {
    const invalid: CredentialPoolConfig = { accounts: accounts('a', 'b') };
    invalid.accounts.forEach((entry) => {
      entry.status = 'invalid';
    });
    const { pool: invalidPool } = makePool(invalid);
    assert.equal(invalidPool.next('cline', 'model-x'), null);

    const cooled: CredentialPoolConfig = { accounts: accounts('a', 'b') };
    const { pool: cooledPool, cooling } = makePool(cooled);
    cooling.enter('a', '*', { resetAt: Date.now() + 60_000 });
    cooling.enter('b', '*', { resetAt: Date.now() + 60_000 });
    assert.equal(cooledPool.next('cline', 'model-x'), null);
  });

  it('returns null for an unknown platform', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a') };
    const { pool } = makePool(config);
    assert.equal(pool.next(asPlatform('other'), 'model-x'), null);
  });
});

describe('AccountPool reports', () => {
  it('reportRateLimit blocks that account for that model immediately', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a', 'b') };
    const { pool, cooling } = makePool(config);
    assert.equal(pool.next('cline', 'model-x')?.id, 'a');
    pool.reportRateLimit('cline', 'a', 'model-x', { resetAt: Date.now() + 60_000 });
    assert.equal(pool.next('cline', 'model-x')?.id, 'b');
    assert.equal(cooling.active('a', 'model-x'), true);
  });

  it('reportInvalid flips status and marks a status change', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a', 'b') };
    const { pool, changes } = makePool(config);
    pool.reportInvalid('cline', 'a');
    assert.equal(config.accounts[0]?.status, 'invalid');
    assert.deepEqual(changes, [{ accountId: 'a', kind: 'status' }]);
    assert.equal(pool.next('cline', 'model-x')?.id, 'b');
  });

  it('reportSuccess refreshes lastUsedAt and marks a meta change', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a') };
    const { pool, changes } = makePool(config);
    const before = Date.now();
    pool.reportSuccess('cline', 'a');
    assert.ok((config.accounts[0]?.lastUsedAt ?? 0) >= before);
    assert.deepEqual(changes, [{ accountId: 'a', kind: 'meta' }]);
  });

  it('next updates lastUsedAt and reports only a meta change', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a') };
    const { pool, changes } = makePool(config);
    const before = Date.now();
    const picked = pool.next('cline', 'model-x');
    assert.ok((picked?.lastUsedAt ?? 0) >= before);
    assert.equal(picked, config.accounts[0]);
    assert.deepEqual(changes, [{ accountId: 'a', kind: 'meta' }]);
  });

  it('reportRateLimit for an unknown account still records the cooldown', () => {
    const config: CredentialPoolConfig = { accounts: accounts('a') };
    const { pool, cooling } = makePool(config);
    pool.reportRateLimit('cline', 'ghost', 'model-x', { resetAt: Date.now() + 60_000 });
    assert.equal(cooling.active('ghost', 'model-x'), true);
    assert.equal(cooling.active('a', 'model-x'), false);
  });
});
