import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenAttemptMonitor, type ZenAttemptRecord } from '../gateway/monitor.js';

function record(overrides: Partial<ZenAttemptRecord> = {}): ZenAttemptRecord {
  return {
    time: 1,
    requestId: 'req_1',
    model: 'm',
    tier: 'zen',
    attempt: 1,
    keyId: 'anonymous',
    channel: 'anonymous',
    anonymous: true,
    proxy: 'direct',
    status: 200,
    durationMs: 5,
    success: true,
    outcome: 'success',
    ...overrides,
  };
}

describe('zen attempt monitor', () => {
  it('keeps recorded attempts in order', () => {
    const monitor = new ZenAttemptMonitor(10);
    monitor.record(record());
    monitor.record(record({ attempt: 2, keyId: 'abc', channel: 'key', anonymous: false }));
    const list = monitor.list();
    assert.equal(list.length, 2);
    assert.equal(list[1]?.keyId, 'abc');
    assert.equal(list[1]?.anonymous, false);
  });

  it('bounds the buffer to the configured capacity keeping the newest', () => {
    const monitor = new ZenAttemptMonitor(3);
    for (let i = 1; i <= 5; i += 1) monitor.record(record({ attempt: i }));
    const list = monitor.list();
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((r) => r.attempt),
      [3, 4, 5],
    );
  });

  it('reset clears the buffer', () => {
    const monitor = new ZenAttemptMonitor(3);
    monitor.record(record());
    monitor.reset();
    assert.equal(monitor.list().length, 0);
  });
});
