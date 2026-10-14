import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalSessionId, isCanonicalSessionId } from '../identity/session.js';

const SHAPED = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
// OpenCode's free tier decodes the 12-hex time part and rejects anything that
// is not the official client's Identifier.descending() layout. Bitwise NOT of
// (ts_ms << 12 | counter) means a genuine part ends in 0xFFF - counter, so the
// accepted window is low-12-bit values 0xFC0..0xFFF (counters 0..63).
const DESCENDING_TIME_PART = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;

// Genuine time parts minted by the official client (Identifier.descending(),
// counters 1..48). These must survive untouched: re-minting them would break
// the upstream prompt cache affinity for real OpenCode sessions.
const GENUINE_SESSIONS = [
  'ses_ecc5beb7cffe2U0aluUnb5nnpZ',
  'ses_ecc441adcffep73ndhq1lBqQim',
  'ses_f02a5a612ffepq6RK15QX04Se0',
  'ses_4892557ffffeDiICzp8gKhMR0u',
  'ses_ecc1f76c9fef3zWGdD1GSCEwPf',
  'ses_ecc1f76c9fcf3zWGdD1GSCEwPf',
  'ses_ecc1f76c9fce3zWGdD1GSCEwPf',
];

// Right shape, wrong encoding: an ascending id, a counter past the accepted
// window, and the raw-sha256 time part this gateway used to emit. All three
// are answered 403 FreeTierError by the free tier, so all three must be
// re-encoded.
const FOREIGN_SESSIONS = [
  'ses_133a414840012U0aluUnb5nnpZ',
  'ses_ecc1f76c9f9b3zWGdD1GSCEwPf',
  'ses_088a704c30424N5kWDK0snKFbd',
];

// The exact shape the pre-#70 implementation produced from a digest: shape is
// valid, but the time part carries no descending encoding, so it is rejected.
const LEGACY_HASH_SHAPED = 'ses_3f9a1c2b7d4e0123456789ABCD';

describe('zen session canonicalization', () => {
  it('keeps a genuinely descending session unchanged', () => {
    const id = GENUINE_SESSIONS[0] as string;
    assert.equal(isCanonicalSessionId(id), true);
    assert.equal(canonicalSessionId(id), id);
  });

  it('keeps every genuine descending session unchanged', () => {
    for (const id of GENUINE_SESSIONS) {
      assert.equal(canonicalSessionId(id), id, `mutated genuine session ${id}`);
    }
  });

  it('re-encodes foreign time parts into the descending layout', () => {
    for (const id of FOREIGN_SESSIONS) {
      const got = canonicalSessionId(id);
      assert.match(got, SHAPED, `not canonical shape: ${got}`);
      assert.match(
        got.slice(4, 16),
        DESCENDING_TIME_PART,
        `time part is not descending-encoded: ${got}`,
      );
      assert.notEqual(got, id, `kept a foreign encoding: ${id}`);
    }
  });

  it('re-encodes a legacy hash-shaped session instead of passing it through', () => {
    assert.equal(isCanonicalSessionId(LEGACY_HASH_SHAPED), true, 'precondition: shape is valid');
    const got = canonicalSessionId(LEGACY_HASH_SHAPED);
    assert.notEqual(got, LEGACY_HASH_SHAPED, 'legacy hash time part must not survive');
    assert.match(got.slice(4, 16), DESCENDING_TIME_PART, `not descending: ${got}`);
  });

  it('mints arbitrary signals with a descending time part ending in ffe', () => {
    // counter 1 is ORed in before the bitwise NOT, so the low 12 bits are
    // 0xFFF ^ 1 == 0xFFE and the last three hex characters are always "ffe".
    const id = canonicalSessionId('conversation-abc');
    assert.match(id, SHAPED);
    const timePart = id.slice(4, 16);
    assert.match(timePart, DESCENDING_TIME_PART, `not descending: ${id}`);
    assert.equal(timePart.slice(-3), 'ffe', `time part must read ffe: ${id}`);
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
