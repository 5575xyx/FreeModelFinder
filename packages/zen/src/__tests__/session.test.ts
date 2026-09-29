import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalSessionId, isCanonicalSessionId } from '../identity/session.js';

const SHAPED = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

describe('zen session canonicalization', () => {
  it('keeps an already canonical session unchanged', () => {
    const id = 'ses_3f9a1c2b7d4e0123456789ABCD';
    assert.equal(isCanonicalSessionId(id), true);
    assert.equal(canonicalSessionId(id), id);
  });

  it('maps arbitrary signals into the canonical shape deterministically', () => {
    const a = canonicalSessionId('conversation-abc');
    const b = canonicalSessionId('conversation-abc');
    assert.equal(a, b);
    assert.match(a, SHAPED);
  });

  it('produces different sessions for different signals', () => {
    assert.notEqual(canonicalSessionId('one'), canonicalSessionId('two'));
  });

  it('treats malformed ses_ ids as signals to re-hash', () => {
    const bad = 'ses_ZZZZZZZZZZZZ';
    assert.equal(isCanonicalSessionId(bad), false);
    assert.match(canonicalSessionId(bad), SHAPED);
    assert.equal(isCanonicalSessionId('ses_3f9a1c2b7d4e0123456789ABCDEF'), false);
    assert.match(canonicalSessionId('ses_3f9a1c2b7d4e0123456789ABCDEF'), SHAPED);
  });
});
