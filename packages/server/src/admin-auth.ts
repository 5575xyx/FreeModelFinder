import { randomBytes } from 'node:crypto';

/**
 * In-memory sign-in state for the management panel.
 *
 * Sessions live only in process memory: there is no file on disk to steal, and
 * a server restart invalidates every session. That is a deliberate trade for a
 * single-operator tool — you sign in again after a restart rather than
 * accepting a persisted credential.
 */

export const ADMIN_SESSION_COOKIE = 'fmf_admin';
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Hard cap on tracked source addresses. Unbounded growth is possible if the
 * gateway is sat with spoofed clients; evicting the oldest window keeps it
 * finite without ever un-locking a still-active lockout on the caller's own IP.
 */
export const MAX_TRACKED_CLIENTS = 10_000;

export interface AdminAuthOptions {
  sessionTtlMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
  now?: () => number;
}

export interface AdminAuthState {
  issueSession(): string;
  validateSession(cookieHeader: string | undefined): boolean;
  revokeSession(cookieHeader: string | undefined): void;
  isLockedOut(ip: string): boolean;
  /** Records a failed attempt; returns true when this attempt trips the lockout. */
  recordFailure(ip: string): boolean;
  clearFailures(ip: string): void;
  prune(at?: number): void;
}

interface FailureWindow {
  count: number;
  lockedUntil: number;
}

export function createAdminAuthState(options: AdminAuthOptions = {}): AdminAuthState {
  const ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS;
  const clock = options.now ?? Date.now;

  const sessions = new Map<string, number>();
  const failures = new Map<string, FailureWindow>();

  const prune = (at = clock()): void => {
    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= at) sessions.delete(token);
    }
    // A window is only worth keeping while it can still lock someone out.
    for (const [ip, window] of failures) {
      if (window.lockedUntil > 0 && window.lockedUntil <= at) failures.delete(ip);
    }
  };

  // A pure read. Never mutate here: deleting an entry while its failure count
  // is still accumulating wipes out the attempts that justify the lockout.
  const isLockedOut = (ip: string): boolean => {
    const window = failures.get(ip);
    return !!window && window.lockedUntil > clock();
  };

  return {
    issueSession(): string {
      prune();
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, clock() + ttlMs);
      return token;
    },

    validateSession(cookieHeader: string | undefined): boolean {
      const token = cookieValue(cookieHeader);
      if (!token) return false;
      const expiresAt = sessions.get(token);
      if (expiresAt === undefined) return false;
      if (expiresAt <= clock()) {
        sessions.delete(token);
        return false;
      }
      // Sliding expiry: any successful use extends the window.
      sessions.set(token, clock() + ttlMs);
      return true;
    },

    revokeSession(cookieHeader: string | undefined): void {
      const token = cookieValue(cookieHeader);
      if (token) sessions.delete(token);
    },

    isLockedOut,

    recordFailure(ip: string): boolean {
      const existing = failures.get(ip);
      // An expired lockout starts a fresh window; otherwise keep counting.
      const window =
        existing && existing.lockedUntil > 0 && existing.lockedUntil <= clock()
          ? { count: 0, lockedUntil: 0 }
          : (existing ?? { count: 0, lockedUntil: 0 });
      if (!failures.has(ip) && failures.size >= MAX_TRACKED_CLIENTS) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      window.count += 1;
      const tripped = window.count >= maxFailures;
      if (tripped) window.lockedUntil = clock() + lockoutMs;
      failures.set(ip, window);
      return tripped;
    },

    clearFailures(ip: string): void {
      failures.delete(ip);
    },

    prune,
  };
}

/**
 * Minimal cookie reader. No cookie plugin is registered on the app, and pulling
 * one in just to read a single name is not worth the dependency.
 */
export function cookieValue(
  header: string | undefined,
  name: string = ADMIN_SESSION_COOKIE,
): string | undefined {
  if (typeof header !== 'string' || !header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * `Secure` is only asserted when the request itself arrived over HTTPS, so the
 * login keeps working on a plain-HTTP deployment and tightens automatically
 * once TLS is added.
 */
export function sessionCookieHeader(token: string, ttlMs: number, secure: boolean): string {
  const securePart = secure ? '; Secure' : '';
  const maxAge = Math.floor(ttlMs / 1000);
  return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${securePart}`;
}

export const SESSION_CLEAR_COOKIE_HEADER = `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/**
 * Kept in sync with DEFAULT_LOCKOUT_MS so the message and the timing cannot
 * drift apart as the lockout is tuned.
 */
export const LOGIN_LOCKOUT_MESSAGE = `Too many failed attempts. Try again in ${
  DEFAULT_LOCKOUT_MS / 60000
} minutes.`;
