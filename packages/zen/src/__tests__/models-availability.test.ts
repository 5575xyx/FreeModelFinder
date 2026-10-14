import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  FAILED_MODEL_CHECK_INTERVAL_MS,
  FREE_MODEL_CHECK_INTERVAL_MS,
  ZenAvailabilityStore,
  type ZenEffortProbe,
} from '../models/availability.js';

const HOUR = FREE_MODEL_CHECK_INTERVAL_MS;
const DAY = FAILED_MODEL_CHECK_INTERVAL_MS;
const NO_EFFORT: ZenEffortProbe = {};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'zen-availability-'));
}

describe('zen availability store state machine', () => {
  it('records a successful probe on the hourly schedule', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, true, 'probe_succeeded', 'anonymous', 1_000, NO_EFFORT);
    const item = store.get('m');
    assert.equal(item.disabled, false);
    assert.equal(item.reason, 'probe_succeeded');
    assert.equal(item.channel, 'anonymous');
    assert.equal(item.nextCheck, 1_000 + HOUR);
    assert.equal(item.probeVersion, 1);
    assert.equal(store.disabled('m'), false);
  });

  it('disables a model only on an explicit model_unavailable', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, false, 'transport_error', 'zen', 1_000, NO_EFFORT);
    assert.equal(store.disabled('m'), false);
    assert.equal(store.get('m').nextCheck, 1_000 + HOUR);
    await store.record('m', 0, false, 'model_unavailable', 'zen', 2_000, NO_EFFORT);
    assert.equal(store.disabled('m'), true);
    assert.equal(store.get('m').nextCheck, 2_000 + DAY);
  });

  it('ignores a stale generation so a superseded probe cannot overwrite', async () => {
    const store = new ZenAvailabilityStore();
    await store.setManual('m', true, 1_000);
    // setManual bumps the generation to 1; a probe recorded with the old
    // generation 0 must be dropped entirely.
    await store.record('m', 0, false, 'model_unavailable', 'zen', 2_000, NO_EFFORT);
    assert.equal(store.disabled('m'), false);
    assert.equal(store.get('m').reason, 'manually_enabled');
  });

  it('freezes records while a model is under manual control', async () => {
    const store = new ZenAvailabilityStore();
    await store.setManual('m', true, 1_000);
    const generation = store.get('m').generation;
    await store.record('m', generation, false, 'model_unavailable', 'zen', 2_000, NO_EFFORT);
    const item = store.get('m');
    assert.equal(item.disabled, false);
    assert.equal(item.reason, 'manually_enabled');
  });

  it('keeps the previous disable reason and backoff on an inconclusive recheck', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, false, 'model_unavailable', 'zen', 1_000, NO_EFFORT);
    // A recheck inside the existing window fails with a transient error: the
    // model keeps the original disable reason and stays on its 24h schedule.
    await store.record('m', 0, false, 'transport_error', 'zen', 1_500, NO_EFFORT);
    const item = store.get('m');
    assert.equal(item.disabled, true);
    assert.equal(item.reason, 'model_unavailable');
    assert.equal(item.nextCheck, 1_000 + DAY);
  });

  it('restarts the failed backoff when an overdue recheck stays inconclusive', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, false, 'model_unavailable', 'zen', 1_000, NO_EFFORT);
    const overdue = 1_000 + DAY;
    await store.record('m', 0, false, 'transport_error', 'zen', overdue, NO_EFFORT);
    const item = store.get('m');
    assert.equal(item.disabled, true);
    assert.equal(item.reason, 'model_unavailable');
    // The window elapsed and the recheck proved nothing, so the schedule is
    // advanced past the current tick instead of probing again immediately.
    assert.equal(item.nextCheck, overdue + DAY);
  });

  it('setManual is idempotent and does not erase disable evidence', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, false, 'model_unavailable', 'zen', 1_000, NO_EFFORT);
    await store.setManual('m', true, 2_000);
    const generation = store.get('m').generation;
    // A repeated manual switch keeps the record untouched (no generation bump).
    await store.setManual('m', true, 3_000);
    assert.equal(store.get('m').generation, generation);
    // Switching back to automatic schedules a probe immediately (zero due).
    await store.setManual('m', false, 4_000);
    const item = store.get('m');
    assert.equal(item.manual, false);
    assert.equal(item.reason, 'auto_probe');
    assert.equal(item.nextCheck, 0);
  });

  it('restore takes the model under manual control and disables probing', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, false, 'model_unavailable', 'zen', 1_000, NO_EFFORT);
    await store.restore('m', 2_000);
    const item = store.get('m');
    assert.equal(item.disabled, false);
    assert.equal(item.manual, true);
    assert.equal(item.reason, 'manually_enabled');
  });

  it('stores the auto effort probe on success and resets it on demand', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, true, 'probe_succeeded', 'anonymous', 1_000, {
      effort: 'high',
      protocol: 'chat',
    });
    assert.deepEqual(store.get('m').autoEffort, { effort: 'high', protocol: 'chat' });
    assert.equal(store.get('m').effortCheckedAt, 1_000);
    // A reset marker (a higher level was rejected, then the recheck was
    // inconclusive) clears the ceiling instead of retaining it.
    await store.record('m', 0, true, 'probe_succeeded', 'anonymous', 2_000, { reset: true });
    assert.equal(store.get('m').autoEffort, undefined);
    assert.equal(store.get('m').effortCheckedAt, undefined);
  });

  it('does not touch autoEffort on a failed probe', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, true, 'probe_succeeded', 'anonymous', 1_000, {
      effort: 'max',
      protocol: 'chat',
    });
    await store.record('m', 0, false, 'transport_error', 'anonymous', 2_000, NO_EFFORT);
    assert.deepEqual(store.get('m').autoEffort, { effort: 'max', protocol: 'chat' });
  });
});

describe('zen availability store persistence', () => {
  it('round-trips records through the disk file', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'availability.json');
      const first = new ZenAvailabilityStore(path);
      await first.record('m', 0, false, 'model_unavailable', 'zen', 1_000, NO_EFFORT);
      await first.record('n', 0, true, 'probe_succeeded', 'anonymous', 1_000, {
        effort: 'low',
        protocol: 'chat',
      });

      const second = new ZenAvailabilityStore(path);
      await second.load();
      assert.equal(second.disabled('m'), true);
      assert.equal(second.get('m').nextCheck, 1_000 + DAY);
      assert.deepEqual(second.get('n').autoEffort, { effort: 'low', protocol: 'chat' });
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      assert.equal((raw['m'] as Record<string, unknown>)['disabled'], true);
      assert.equal(typeof (raw['m'] as Record<string, unknown>)['next_check'], 'string');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('migrates legacy disabled records from pre-probe-version data', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'availability.json');
      await writeFile(
        path,
        JSON.stringify({
          m: {
            model: 'm',
            disabled: true,
            next_check: new Date(0).toISOString(),
            reason: 'model_unavailable',
          },
        }),
        'utf8',
      );
      const store = new ZenAvailabilityStore(path);
      await store.load();
      const item = store.get('m');
      // Legacy probes used invalid session IDs; their records cannot
      // establish unavailability and must be re-probed from scratch.
      assert.equal(item.disabled, false);
      assert.equal(item.reason, 'legacy_probe_recheck');
      assert.equal(item.nextCheck, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a manual restore under manual control after the flag migration', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'availability.json');
      await writeFile(
        path,
        JSON.stringify({
          m: {
            model: 'm',
            disabled: false,
            next_check: new Date(0).toISOString(),
            reason: 'manually_enabled',
          },
        }),
        'utf8',
      );
      const store = new ZenAvailabilityStore(path);
      await store.load();
      assert.equal(store.get('m').manual, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing file as an empty store', async () => {
    const dir = await tempDir();
    try {
      const store = new ZenAvailabilityStore(join(dir, 'missing.json'));
      await store.load();
      assert.equal(store.disabled('nothing'), false);
      assert.equal(store.get('nothing').nextCheck, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns copies so callers cannot mutate the store', async () => {
    const store = new ZenAvailabilityStore();
    await store.record('m', 0, true, 'probe_succeeded', 'zen', 1_000, NO_EFFORT);
    const item = store.get('m');
    item.disabled = true;
    assert.equal(store.disabled('m'), false);
  });
});
