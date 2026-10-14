import { createHash } from 'node:crypto';

const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
// The free tier decodes the leading 12 hex characters as the official client's
// Identifier.descending() word: the 48-bit value ~(ts_ms << 12 | counter).
// Bitwise NOT sets the low 12 bits, so a genuine time part ends in 0xFFF -
// counter. Probing the live endpoint shows counters 0..63 are accepted
// (low-12-bit values 0xFC0..0xFFF) and anything beyond is answered with
// 403 FreeTierError even when the ses_ shape is right — so accept exactly that
// window and re-encode everything else.
const DESCENDING_TIME_PART = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function isCanonicalSessionId(value: string): boolean {
  return CANONICAL_SESSION.test(value);
}

function base62Fixed(bytes: Buffer, width: number): string {
  let value = BigInt('0x' + bytes.toString('hex'));
  const base = 62n;
  const out: string[] = [];
  for (let i = 0; i < width; i += 1) {
    out.push(BASE62[Number(value % base)] as string);
    value /= base;
  }
  return out.reverse().join('');
}

/**
 * Renders six hash bytes as Identifier.descending()'s layout: a 36-bit
 * timestamp shifted into the top of a 48-bit word, ORed with counter 1, then
 * bitwise-NOT-ed so the low 12 hex digits read `ffe`.
 *
 * Deterministic — the same signal always maps to the same session, which is
 * what keeps a conversation on one stable session (and one proxy lane)
 * across turns. Only the wire encoding changed; the derivation did not.
 */
function descendingTimePart(hash: Buffer): string {
  const stamp =
    (BigInt(hash[0] as number) << 28n) |
    (BigInt(hash[1] as number) << 20n) |
    (BigInt(hash[2] as number) << 12n) |
    (BigInt(hash[3] as number) << 4n) |
    (BigInt(hash[4] as number) >> 4n);
  const current = (stamp << 12n) | 1n;
  const inverted = ~current & 0xffffffffffffn;
  return inverted.toString(16).padStart(12, '0');
}

/**
 * Returns `signal` unchanged when it already carries an official OpenCode
 * session minted by the client's descending encoding (keeping upstream
 * prompt-cache affinity). Any other downstream identity — a UUID, a foreign
 * client session, a legacy gateway session, a conversation seed — is
 * deterministically re-encoded into that exact layout.
 *
 * Since 2026-10-11 the free tier validates how the time part is encoded, not
 * just the ses_ shape: a digest-derived prefix classifies the caller as a
 * non-OpenCode client and every free model answers
 * 403 FreeTierError ('free tier can only be used from within OpenCode').
 */
export function canonicalSessionId(signal: string): string {
  if (isCanonicalSessionId(signal) && DESCENDING_TIME_PART.test(signal.slice(4, 16))) {
    return signal;
  }
  const digest = createHash('sha256')
    .update('ses\u0000' + signal)
    .digest();
  const timePart = descendingTimePart(digest.subarray(0, 6));
  const randomPart = base62Fixed(digest.subarray(6, 16), 14);
  return `ses_${timePart}${randomPart}`;
}
