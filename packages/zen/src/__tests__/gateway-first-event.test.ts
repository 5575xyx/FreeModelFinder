import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PhasedError,
  classifyAttemptError,
  upstreamAccepted,
  type AttemptPhase,
} from '../gateway/first-event.js';

function timeout(name = 'TimeoutError'): Error {
  return Object.assign(new Error('deadline'), { name });
}

describe('PhasedError', () => {
  it('carries the phase and unwraps to the original error', () => {
    const cause = new Error('boom');
    const err = new PhasedError('dial', cause);
    assert.equal(err.phase, 'dial');
    assert.equal((err as { cause?: unknown }).cause, cause);
    assert.ok(err.message.includes('dial'));
  });
});

describe('upstreamAccepted', () => {
  it('is true only when the attempt died after the first event', () => {
    assert.equal(upstreamAccepted(new PhasedError('first_event', new Error('slow'))), true);
    for (const phase of ['dial', 'write', 'headers'] as AttemptPhase[]) {
      assert.equal(upstreamAccepted(new PhasedError(phase, timeout())), false);
    }
  });

  it('is false for a non-phased error', () => {
    assert.equal(upstreamAccepted(new Error('generic')), false);
  });
});

describe('classifyAttemptError', () => {
  it('labels an attempt-deadline timeout with its phase', () => {
    const cause = Object.assign(new Error('attempt timed out'), { code: 'ERR_ATTEMPT_TIMEOUT' });
    assert.equal(classifyAttemptError(new PhasedError('dial', cause)), 'attempt_timeout_dial');
    assert.equal(
      classifyAttemptError(new PhasedError('headers', cause)),
      'attempt_timeout_headers',
    );
  });

  it('labels a first-event timeout as first_event regardless of phase', () => {
    const cause = Object.assign(new Error('first SSE event timed out'), {
      code: 'ERR_FIRST_EVENT_TIMEOUT',
    });
    assert.equal(classifyAttemptError(new PhasedError('headers', cause)), 'first_event');
  });

  it('labels a plain deadline as a timeout with its phase', () => {
    assert.equal(classifyAttemptError(new PhasedError('write', timeout())), 'timeout_write');
  });

  it('labels a transport failure with its phase', () => {
    assert.equal(
      classifyAttemptError(new PhasedError('dial', new Error('ECONNREFUSED'))),
      'transport_dial',
    );
  });

  it('has no phase suffix for a non-phased error', () => {
    assert.equal(classifyAttemptError(new Error('generic')), 'transport');
  });
});
