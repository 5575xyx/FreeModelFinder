import { createHash } from 'node:crypto';

const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
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

export function canonicalSessionId(signal: string): string {
  if (isCanonicalSessionId(signal)) return signal;
  const digest = createHash('sha256')
    .update('ses\u0000' + signal)
    .digest();
  const timePart = digest.subarray(0, 6).toString('hex');
  const randomPart = base62Fixed(digest.subarray(6, 16), 14);
  return `ses_${timePart}${randomPart}`;
}
