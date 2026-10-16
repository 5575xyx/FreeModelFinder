import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { generatePkce } from '../oauth/pkce.js';
import {
  OAUTH_SESSION_TTL_MS,
  OAuthSessionBusyError,
  createOAuthSessionStore,
} from '../oauth/session.js';
import { generateState, isValidState } from '../oauth/state.js';

const REDIRECT = 'http://127.0.0.1:1455/auth/callback';

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('OAuth state', () => {
  it('generateState returns a 43-char base64url string', () => {
    assert.match(generateState(), /^[A-Za-z0-9_-]{43}$/);
  });

  it('generateState returns a different value each call', () => {
    assert.notEqual(generateState(), generateState());
  });

  it('isValidState rejects empty / short / non-base64url input', () => {
    assert.equal(isValidState(''), false);
    assert.equal(isValidState('tooshort'), false);
    assert.equal(isValidState('a'.repeat(42)), false);
    assert.equal(isValidState(`${'a'.repeat(42)}+`), false);
    assert.equal(isValidState(generateState()), true);
  });
});

describe('OAuth PKCE', () => {
  it('generatePkce verifier is 43-128 chars and challenge is S256 of verifier', () => {
    const { verifier, challenge } = generatePkce();
    assert.ok(
      verifier.length >= 43 && verifier.length <= 128,
      `verifier length ${verifier.length} out of range`,
    );
    assert.match(verifier, /^[A-Za-z0-9_-]+$/);
    const expected = base64url(createHash('sha256').update(verifier).digest());
    assert.equal(challenge, expected);
  });
});

describe('OAuth session store', () => {
  it('begin returns a state that is immediately pending', () => {
    const store = createOAuthSessionStore();
    const state = store.begin('codex', REDIRECT, 'verifier-1');
    assert.equal(store.isPending(state), true);
    const record = store.get(state);
    assert.equal(record?.provider, 'codex');
    assert.equal(record?.status, 'wait');
    assert.equal(record?.redirectUri, REDIRECT);
    assert.equal(record?.verifier, 'verifier-1');
  });

  it('begin throws OAuthSessionBusyError when the same provider already has a pending session', () => {
    const store = createOAuthSessionStore();
    store.begin('claude', REDIRECT);
    assert.throws(() => store.begin('claude', REDIRECT), OAuthSessionBusyError);
    // 另一家不受影响
    assert.doesNotThrow(() => store.begin('google', REDIRECT));
  });

  it('complete moves the session to ok', () => {
    const store = createOAuthSessionStore();
    const state = store.begin('codex', REDIRECT);
    store.complete(state);
    assert.equal(store.get(state)?.status, 'ok');
    assert.equal(store.isPending(state), false);
  });

  it('fail moves the session to error with the given message', () => {
    const store = createOAuthSessionStore();
    const state = store.begin('codex', REDIRECT);
    store.fail(state, 'exchange failed');
    assert.equal(store.get(state)?.status, 'error');
    assert.equal(store.get(state)?.error, 'exchange failed');
  });

  it('cancel returns true and removes the session; a second cancel returns false', () => {
    const store = createOAuthSessionStore();
    const state = store.begin('codex', REDIRECT);
    assert.equal(store.cancel(state), true);
    assert.equal(store.get(state), undefined);
    assert.equal(store.cancel(state), false);
  });

  // 路由层要在**申请任何本机资源之前**判断"这家是不是已有 pending 会话"：
  // codex/claude 的回调端口被官方应用注册死（1455/54545），若先起监听再查会话，
  // 第二次点击只会撞 EADDRINUSE（500），永远走不到 409 分支。
  it('hasPending reports per-provider pending state without allocating a session', () => {
    const store = createOAuthSessionStore();
    assert.equal(store.hasPending('codex'), false);
    const state = store.begin('codex', REDIRECT);
    assert.equal(store.hasPending('codex'), true);
    assert.equal(store.hasPending('claude'), false);
    store.complete(state);
    assert.equal(store.hasPending('codex'), false);
  });

  it('get returns undefined for an unknown state', () => {
    const store = createOAuthSessionStore();
    assert.equal(store.get(generateState()), undefined);
  });

  it('sweep marks a session older than the TTL as error timeout', () => {
    const store = createOAuthSessionStore();
    const state = store.begin('codex', REDIRECT);
    const createdAt = store.get(state)?.createdAt ?? 0;
    store.sweep(createdAt + OAUTH_SESSION_TTL_MS + 1);
    assert.equal(store.get(state)?.status, 'error');
    assert.equal(store.get(state)?.error, 'timeout');
  });
});
