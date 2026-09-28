import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeviceAuthManager } from '../device-auth.js';

describe('DeviceAuthManager state machine', () => {
  it('walks start → poll pending → complete', async () => {
    const manager = new DeviceAuthManager();
    let upstream: 'pending' | 'complete' | 'denied' = 'pending';
    const handle = manager.start({
      check: async () => ({ status: upstream }),
      meta: { userCode: 'ABCD-1234', verificationUri: 'https://example.test/verify' },
    });
    assert.equal(handle.status, 'pending');
    assert.ok(handle.expiresAt > Date.now());
    assert.equal(handle.meta?.userCode, 'ABCD-1234');

    const first = await manager.poll(handle.flowId);
    assert.equal(first.status, 'pending');

    upstream = 'complete';
    const done = await manager.poll(handle.flowId);
    assert.equal(done.status, 'complete');

    const again = await manager.poll(handle.flowId);
    assert.equal(again.status, 'expired');
    assert.equal(again.expiresAt, 0);
  });

  it('carries the upstream result through on completion', async () => {
    const manager = new DeviceAuthManager();
    const handle = manager.start({
      check: async () => ({
        status: 'complete' as const,
        result: { accountId: 'acc-9', label: 'user@example.com' },
      }),
    });
    const done = await manager.poll(handle.flowId);
    assert.equal(done.status, 'complete');
    assert.deepEqual(done.result, { accountId: 'acc-9', label: 'user@example.com' });
  });

  it('expires a pending flow once its deadline passes', async () => {
    let clock = 1_700_000_000_000;
    const manager = new DeviceAuthManager({ now: () => clock, ttlMs: 1_000 });
    let checks = 0;
    const handle = manager.start({
      check: async () => {
        checks += 1;
        return { status: 'pending' as const };
      },
    });
    assert.equal(handle.expiresAt, clock + 1_000);

    const first = await manager.poll(handle.flowId);
    assert.equal(first.status, 'pending');

    clock += 1_500;
    const expired = await manager.poll(handle.flowId);
    assert.equal(expired.status, 'expired');
    assert.equal(checks, 1);
  });

  it('marks a denied flow', async () => {
    const manager = new DeviceAuthManager();
    const handle = manager.start({
      check: async () => ({ status: 'denied' as const, reason: 'user rejected the request' }),
    });
    const denied = await manager.poll(handle.flowId);
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reason, 'user rejected the request');
  });

  it('keeps polling as pending when the upstream check fails transiently', async () => {
    const manager = new DeviceAuthManager();
    let calls = 0;
    const handle = manager.start({
      check: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network down');
        return { status: 'complete' as const, result: 'ok' };
      },
    });
    const transient = await manager.poll(handle.flowId);
    assert.equal(transient.status, 'pending');
    const done = await manager.poll(handle.flowId);
    assert.equal(done.status, 'complete');
    assert.equal(done.result, 'ok');
  });

  it('reports an unknown flow as expired', async () => {
    const manager = new DeviceAuthManager();
    const missing = await manager.poll('no-such-flow');
    assert.equal(missing.status, 'expired');
    assert.equal(missing.flowId, 'no-such-flow');
  });

  it('drops expired flows when another one starts', async () => {
    let clock = 1_700_000_000_000;
    const manager = new DeviceAuthManager({ now: () => clock, maxFlows: 2 });
    const check = async () => ({ status: 'pending' as const });
    const longLived = manager.start({ check, expiresInMs: 10_000 });
    manager.start({ check, expiresInMs: 1_000 });
    clock += 2_000;

    const next = manager.start({ check, expiresInMs: 10_000 });
    const stillAlive = await manager.poll(longLived.flowId);
    const newest = await manager.poll(next.flowId);
    assert.equal(stillAlive.status, 'pending');
    assert.equal(newest.status, 'pending');
  });

  it('evicts the oldest flow once the live count hits the cap', async () => {
    let sequence = 0;
    const manager = new DeviceAuthManager({ idFactory: () => `flow-${sequence++}`, maxFlows: 2 });
    const check = async () => ({ status: 'pending' as const });
    const first = manager.start({ check });
    manager.start({ check });
    const third = manager.start({ check });

    const evicted = await manager.poll(first.flowId);
    assert.equal(evicted.status, 'expired');
    assert.equal(evicted.expiresAt, 0);
    const newest = await manager.poll(third.flowId);
    assert.equal(newest.status, 'pending');
  });

  it('generates unique flow ids by default', () => {
    const manager = new DeviceAuthManager();
    const check = async () => ({ status: 'pending' as const });
    const a = manager.start({ check });
    const b = manager.start({ check });
    assert.notEqual(a.flowId, b.flowId);
  });

  it('regenerates when the id factory collides with a live flow', () => {
    const ids = ['taken', 'taken', 'free'];
    const manager = new DeviceAuthManager({ idFactory: () => ids.shift() ?? 'exhausted' });
    const check = async () => ({ status: 'pending' as const });
    const first = manager.start({ check });
    assert.equal(first.flowId, 'taken');
    const second = manager.start({ check });
    assert.equal(second.flowId, 'free');
    assert.notEqual(first.flowId, second.flowId);
  });

  it('throws instead of silently overwriting when collisions never resolve', () => {
    const manager = new DeviceAuthManager({ idFactory: () => 'always-dup' });
    const check = async () => ({ status: 'pending' as const });
    manager.start({ check });
    assert.throws(() => manager.start({ check }), /collision/);
  });
});
