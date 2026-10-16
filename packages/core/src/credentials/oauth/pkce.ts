import { createHash, randomBytes } from 'node:crypto';

const VERIFIER_BYTES = 32;

/** PKCE S256：challenge = base64url(sha256(verifier))。 */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * 生成 PKCE 对（RFC 7636 S256）。
 *
 * `verifier` 直接取 32 字节 base64url（43 字符，落在规范的 43–128 区间内）；
 * `challenge` = base64url(sha256(verifier))，不带 padding。
 */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(VERIFIER_BYTES).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}
