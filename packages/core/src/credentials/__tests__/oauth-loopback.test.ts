import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LoopbackPortBusyError,
  OAuthCallbackTimeoutError,
  normalizeOAuthFailure,
  startLoopbackListener,
} from '../oauth/loopback.js';
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

  // 用户在授权页点「拒绝」时，provider 跳回来的是 `?error=access_denied&state=…`，**没有 code**。
  // 监听器必须把这个失败原样投递出去，否则会话只能挂到 10 分钟超时，
  // 用户看到的是"什么都没发生"，而不是"你拒绝了授权"。
  it('resolves waitForCode with the provider error when the callback carries no code', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    try {
      const state = generateState();
      const wait = listener.waitForCode();
      const response = await fetch(
        `${listener.redirectUri}?error=access_denied&error_description=user+denied&state=${state}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await wait, { code: '', state, error: 'access_denied' });
    } finally {
      listener.close();
    }
  });

  // 拒绝时 provider 有时只回 error_description（不带 error）。两者都要认。
  it('falls back to error_description when error is absent', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    try {
      const state = generateState();
      const wait = listener.waitForCode();
      await fetch(`${listener.redirectUri}?error_description=access_denied&state=${state}`);
      assert.deepEqual(await wait, { code: '', state, error: 'access_denied' });
    } finally {
      listener.close();
    }
  });

  // provider 的 error / error_description 原文要落进会话存储，再经 /status 回给 UI。
  // 用户可能把整段 auth 响应粘进来，所以这里必须先脱敏 —— 和文件导入路径同一道防线。
  // 纯原因值（access_denied）必须原样通过：UI 靠它匹配本地化文案。
  it('masks a token inside the provider error before delivering it', async () => {
    const state = 'a'.repeat(43);
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    try {
      const wait = listener.waitForCode();
      const response = await fetch(
        `${listener.redirectUri}?error=access_denied&error_description=refresh_token=SECRET&state=${state}`,
      );
      assert.equal(response.status, 200);

      const delivered = await wait;
      assert.equal(delivered.state, state);
      // error 优先于 error_description（对齐参考项目 misc/oauth.go:110-113）
      assert.equal(delivered.error, 'access_denied');
    } finally {
      listener.close();
    }
  });

  it('masks a token inside error_description when error is absent', async () => {
    const state = 'b'.repeat(43);
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    try {
      const wait = listener.waitForCode();
      await fetch(`${listener.redirectUri}?error_description=refresh_token=SECRET&state=${state}`);

      const delivered = await wait;
      assert.equal(delivered.error, 'refresh_token=[REDACTED]');
    } finally {
      listener.close();
    }
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
    // 超时必须是可识别的类型，路由层才能把它归一成 UI 认识的 `timeout` 记号。
    await assert.rejects(listener.waitForCode(), OAuthCallbackTimeoutError);
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

  // 回调端口是固定复用的（1455/54545/51121）。若第一次回调留下的 keep-alive 连接
  // 还在客户端的连接池里，用户取消后重试时，新请求会被这条连到**旧 server 实例**的
  // 连接接走，新会话就永远等不到回调 —— 表现在界面上就是一直转圈。
  it('does not leave a reusable keep-alive socket behind', async () => {
    const state = generateState();
    const first = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    const port = portOf(first.redirectUri);
    const firstWait = first.waitForCode();
    const firstResponse = await fetch(`${first.redirectUri}?code=C1&state=${state}`);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get('connection'), 'close');
    assert.deepEqual(await firstWait, { code: 'C1', state });

    // 同一个端口马上再起一个：随后这次请求必须打到新的 server 上。
    const second = await startLoopbackListener({ port, path: '/auth/callback' });
    try {
      const secondWait = second.waitForCode();
      const secondResponse = await fetch(`${second.redirectUri}?code=C2&state=${state}`);
      assert.equal(secondResponse.status, 200);
      assert.deepEqual(await secondWait, { code: 'C2', state });
    } finally {
      second.close();
    }
  });

  // 本机任何进程（局域网也对，因为绑的是 `::`）都能往回调端口投递。
  // 若把不匹配的投递收下并关掉监听，受害者会话就被第三方打挂了 —— 而它本该继续等真实回调。
  it('rejects a callback for a foreign state without consuming the listener', async () => {
    const mine = generateState();
    const foreign = generateState();
    const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
    try {
      listener.expectCallbackFor(mine);
      const wait = listener.waitForCode();

      const intruder = await fetch(`${listener.redirectUri}?code=STOLEN&state=${foreign}`);
      assert.equal(intruder.status, 400);
      // 监听还得活着，真实回调随后仍要能进来并完成会话。
      assert.equal(await settledWithin(wait, 50), 'pending');

      const real = await fetch(`${listener.redirectUri}?code=REAL&state=${mine}`);
      assert.equal(real.status, 200);
      assert.deepEqual(await wait, { code: 'REAL', state: mine });
    } finally {
      listener.close();
    }
  });

  it('normalizeOAuthFailure turns a timeout into the UI sentinel and redacts the rest', () => {
    assert.equal(normalizeOAuthFailure(new OAuthCallbackTimeoutError(600000)), 'timeout');
    assert.equal(
      normalizeOAuthFailure(new Error('exchange failed: {"refresh_token":"1//0abcDEF"}')),
      'exchange failed: {"refresh_token":"[REDACTED]"}',
    );
  });
});
