import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LoopbackPortBusyError, startLoopbackListener } from '../oauth/loopback.js';
import { generateState } from '../oauth/state.js';

/** 'pending' 表示 promise 在给定窗口内仍未 settle。 */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), ms);
    }),
  ]);
}

function portOf(redirectUri: string): number {
  return Number(new URL(redirectUri).port);
}

describe('loopback OAuth callback listener', () => {
  it('port 0 yields an OS-assigned redirect uri of the given path', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/oauth-callback' });
    try {
      const url = new URL(listener.redirectUri);
      // 参考项目注册的 redirect_uri 主机名是 localhost（上游做精确匹配），不能用 127.0.0.1
      assert.equal(url.hostname, 'localhost');
      assert.equal(url.pathname, '/oauth-callback');
      assert.match(listener.redirectUri, /^http:\/\/localhost:\d+\/oauth-callback$/);
      assert.ok(Number(url.port) > 0, `expected a real port, got ${url.port}`);
    } finally {
      listener.close();
    }
  });

  it('a GET to the callback path resolves waitForCode with code and state', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    try {
      const state = generateState();
      const wait = listener.waitForCode();
      const response = await fetch(`${listener.redirectUri}?code=abc123&state=${state}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await wait, { code: 'abc123', state });
    } finally {
      listener.close();
    }
  });

  it('a GET to another path returns 404 and does not resolve the promise', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    const wait = listener.waitForCode();
    const elsewhere = new URL(listener.redirectUri);
    elsewhere.pathname = '/nope';
    const response = await fetch(elsewhere);
    assert.equal(response.status, 404);
    assert.equal(await settledWithin(wait, 50), 'pending');
    listener.close();
    await assert.rejects(wait);
  });

  it('a callback missing code or state returns 400 and does not resolve', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    const wait = listener.waitForCode();
    const noCode = await fetch(`${listener.redirectUri}?state=${generateState()}`);
    assert.equal(noCode.status, 400);
    const noState = await fetch(`${listener.redirectUri}?code=abc123`);
    assert.equal(noState.status, 400);
    assert.equal(await settledWithin(wait, 50), 'pending');
    listener.close();
    await assert.rejects(wait);
  });

  it('a callback with a malformed state returns 400 and does not resolve', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    const wait = listener.waitForCode();
    const response = await fetch(`${listener.redirectUri}?code=abc123&state=not-a-state`);
    assert.equal(response.status, 400);
    assert.equal(await settledWithin(wait, 50), 'pending');
    listener.close();
    await assert.rejects(wait);
  });

  it('close() before any callback makes waitForCode reject', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    const wait = listener.waitForCode();
    listener.close();
    await assert.rejects(wait);
  });

  it('timeout makes waitForCode reject and releases the port', async () => {
    const listener = await startLoopbackListener({
      port: 0,
      path: '/auth/callback',
      timeoutMs: 40,
    });
    const port = portOf(listener.redirectUri);
    await assert.rejects(listener.waitForCode());
    // 超时后必须释放监听，否则用户重新点"登录"会永远撞 EADDRINUSE。
    const again = await startLoopbackListener({ port, path: '/auth/callback' });
    again.close();
  });

  it('binding an already-used fixed port rejects with LoopbackPortBusyError', async () => {
    const first = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    try {
      const port = portOf(first.redirectUri);
      await assert.rejects(
        startLoopbackListener({ port, path: '/auth/callback' }),
        LoopbackPortBusyError,
      );
    } finally {
      first.close();
    }
  });
});
