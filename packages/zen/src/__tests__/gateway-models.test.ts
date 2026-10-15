import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REASONING_LEVELS } from '../config/index.js';
import { reasoningEfforts } from '../gateway/models.js';

const MODEL = 'm-free';
const TIER = 'zen' as const;
const PROTOCOL = 'chat' as const;

describe('reasoningEfforts', () => {
  it('caps the ladder at the resolved level when forcedEffort is auto', () => {
    assert.deepEqual(
      reasoningEfforts(MODEL, TIER, PROTOCOL, {
        forcedEffort: () => 'auto',
        resolvedEffort: () => 'high',
      }),
      ['minimal', 'low', 'medium', 'high'],
    );
  });

  it('returns the full ladder when the resolved level is max', () => {
    assert.deepEqual(
      reasoningEfforts(MODEL, TIER, PROTOCOL, {
        forcedEffort: () => 'auto',
        resolvedEffort: () => 'max',
      }),
      [...REASONING_LEVELS],
    );
  });

  it('returns the full ladder when forcedEffort is not auto', () => {
    assert.deepEqual(
      reasoningEfforts(MODEL, TIER, PROTOCOL, {
        forcedEffort: () => 'high',
        resolvedEffort: () => 'low',
      }),
      [...REASONING_LEVELS],
    );
  });

  it('returns the full ladder when the resolved level is empty or unknown', () => {
    assert.deepEqual(
      reasoningEfforts(MODEL, TIER, PROTOCOL, {
        forcedEffort: () => 'auto',
        resolvedEffort: () => '',
      }),
      [...REASONING_LEVELS],
    );
    assert.deepEqual(
      reasoningEfforts(MODEL, TIER, PROTOCOL, {
        forcedEffort: () => 'auto',
        resolvedEffort: () => 'bogus',
      }),
      [...REASONING_LEVELS],
    );
  });

  it('excludes none and auto from the ladder', () => {
    const levels: string[] = [...REASONING_LEVELS];
    assert.equal(levels.length, 6);
    assert.ok(!levels.includes('none'));
    assert.ok(!levels.includes('auto'));
  });
});
