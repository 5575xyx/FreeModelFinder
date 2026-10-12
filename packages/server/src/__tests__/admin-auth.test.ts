import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  hashAdminPassword,
  loadConfig,
  ProviderRegistry,
  verifyAdminPassword,
  type AppConfig,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const REMOTE_IP = '203.0.113.9';
const PANEL_PASSWORD = 'correct-horse-battery';

const apps: FastifyInstance[] = [];

async function teardown(): Promise<void> {
  while (apps.length) {
    const app = apps.pop();
    if (app) await app.close().catch(() => undefined);
  }
}

afterEach(async () => {
  await teardown();
  delete process.env.FREEMODELFINDER_TRUST_UI;
});

function baseConfig(extra?: Partial<AppConfig>): AppConfig {
  return { version: 2, port: 11435, providers: {}, gateway: { requireAuth: false }, ...extra };
}

async function startServer(config: AppConfig): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(config);
  registry.listAllModels = async () => ({
    models: [],
    succeededProviders: [],
    failedProviders: [],
  });
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

async function startWithPassword(): Promise<FastifyInstance> {
  const adminAuth = await hashAdminPassword(PANEL_PASSWORD);
  return startServer(baseConfig({ adminAuth }));
}

function setCookieOf(body: unknown): string | undefined {
  const container = body as { headers?: unknown };
  const raw = (container.headers ?? {}) as Record<string, unknown>;
  const value = raw['set-cookie'];
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

const remoteUi = {
  remoteAddress: REMOTE_IP,
  headers: { 'x-fmf-client': 'ui' } as Record<string, string>,
};

const localUi = {
  remoteAddress: '127.0.0.1',
  headers: { host: '127.0.0.1:11435', origin: 'http://127.0.0.1:11435', 'x-fmf-client': 'ui' },
};

describe('management panel sign-in', () => {
  it('without a password: the pre-existing local UI gate is unchanged', async () => {
    const app = await startServer(baseConfig());
    const denied = await app.inject({
      method: 'GET',
      url: '/api/config',
      remoteAddress: REMOTE_IP,
    });
    assert.equal(denied.statusCode, 403);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/config',
      ...localUi,
    });
    assert.equal(allowed.statusCode, 200);
  });

  it('without a password: FREEMODELFINDER_TRUST_UI still grants access', async () => {
    process.env.FREEMODELFINDER_TRUST_UI = 'true';
    const app = await startServer(baseConfig());
    const res = await app.inject({ method: 'GET', url: '/api/config', ...remoteUi });
    assert.equal(res.statusCode, 200);
  });

  it('reports what the panel needs from a remote client', async () => {
    const app = await startWithPassword();
    const before = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/status',
        remoteAddress: REMOTE_IP,
      })
    ).json();
    assert.deepEqual(before, { authRequired: true, authenticated: false, remote: true });

    // Status is readable without a session — it is the doorbell the panel rings.
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: 'wrong' },
    });
    assert.equal(wrong.statusCode, 401);
    const after = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/status',
        remoteAddress: REMOTE_IP,
      })
    ).json();
    assert.deepEqual(after, { authRequired: true, authenticated: false, remote: true });
  });

  it('rejects a remote management request that carries no session', async () => {
    const app = await startWithPassword();
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      ...remoteUi,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'admin_signin_required');
  });

  it('the FREEMODELFINDER_TRUST_UI escape hatch stops working once a password exists', async () => {
    process.env.FREEMODELFINDER_TRUST_UI = 'true';
    const app = await startWithPassword();
    const res = await app.inject({ method: 'GET', url: '/api/config', ...remoteUi });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'admin_signin_required');
  });

  it('rejects a wrong password without issuing a session', async () => {
    const app = await startWithPassword();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: 'wrong-password-here' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'admin_bad_password');
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('accepts the right password and issues an HttpOnly, non-Secure session cookie', async () => {
    const app = await startWithPassword();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: PANEL_PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    const cookie = setCookieOf(res);
    assert.ok(cookie, 'a session cookie must be set');
    assert.ok(cookie.startsWith('fmf_admin='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.ok(!cookie.includes('Secure'), 'plain HTTP deployments must still be able to log in');
    assert.ok(!cookie.includes(PANEL_PASSWORD));
  });

  it('a session cookie unlocks the management API for a remote client', async () => {
    const app = await startWithPassword();
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: PANEL_PASSWORD },
    });
    const cookie = setCookieOf(login)!;
    const token = cookie.split(';')[0]!;

    const config = await app.inject({
      method: 'GET',
      url: '/api/config',
      remoteAddress: REMOTE_IP,
      headers: { host: '127.0.0.1:11435', cookie: token },
    });
    assert.equal(config.statusCode, 200);

    const status = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/status',
        remoteAddress: REMOTE_IP,
        headers: { host: '127.0.0.1:11435', cookie: token },
      })
    ).json();
    assert.deepEqual(status, { authRequired: true, authenticated: true, remote: true });
  });

  it('locks out a client after five failed attempts and clears it on success', async () => {
    const app = await startWithPassword();
    const attempt = (password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/admin/login',
        remoteAddress: REMOTE_IP,
        payload: { password },
      });

    for (let i = 0; i < 4; i += 1) {
      assert.equal((await attempt('bad')).statusCode, 401);
    }
    const locked = await attempt('bad');
    assert.equal(locked.statusCode, 429);
    assert.equal(locked.json().error.code, 'admin_locked_out');

    // Even the right password is refused while locked out.
    assert.equal((await attempt(PANEL_PASSWORD)).statusCode, 429);

    // A different client is unaffected by the first one's failures.
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/login',
          remoteAddress: '198.51.100.7',
          payload: { password: PANEL_PASSWORD },
        })
      ).statusCode,
      200,
    );
  });

  it('logout revokes the session', async () => {
    const app = await startWithPassword();
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: PANEL_PASSWORD },
    });
    const cookie = setCookieOf(login)!;
    const token = cookie.split(';')[0]!;

    const out = await app.inject({
      method: 'POST',
      url: '/api/admin/logout',
      remoteAddress: REMOTE_IP,
      headers: { host: '127.0.0.1:11435', origin: 'http://127.0.0.1:11435', cookie: token },
    });
    assert.equal(out.statusCode, 200);
    assert.match(setCookieOf(out) ?? '', /Max-Age=0/);

    const after = await app.inject({
      method: 'GET',
      url: '/api/config',
      remoteAddress: REMOTE_IP,
      headers: { host: '127.0.0.1:11435', cookie: token },
    });
    assert.equal(after.statusCode, 401);
  });

  it('logout stays reachable once the session has already expired', async () => {
    const app = await startWithPassword();
    const out = await app.inject({
      method: 'POST',
      url: '/api/admin/logout',
      remoteAddress: REMOTE_IP,
      headers: { host: '127.0.0.1:11435' },
    });
    assert.equal(out.statusCode, 200);
    assert.match(setCookieOf(out) ?? '', /Max-Age=0/);
  });

  it('refuses a cross-origin state-changing request that holds a session cookie', async () => {
    const app = await startWithPassword();
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: PANEL_PASSWORD },
    });
    const token = setCookieOf(login)!.split(';')[0]!;

    const denied = await app.inject({
      method: 'POST',
      url: '/api/admin/logout',
      remoteAddress: REMOTE_IP,
      headers: {
        host: '127.0.0.1:11435',
        origin: 'http://evil.example',
        cookie: token,
      },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'csrf_rejected');

    // The session survives a rejected cross-origin attempt.
    const stillIn = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/status',
        remoteAddress: REMOTE_IP,
        headers: { host: '127.0.0.1:11435', cookie: token },
      })
    ).json();
    assert.equal(stillIn.authenticated, true);
  });

  it('allows a same-origin state-changing request with a session cookie', async () => {
    const app = await startWithPassword();
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: PANEL_PASSWORD },
    });
    const token = setCookieOf(login)!.split(';')[0]!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/logout',
      remoteAddress: REMOTE_IP,
      headers: { host: '127.0.0.1:11435', origin: 'http://127.0.0.1:11435', cookie: token },
    });
    assert.equal(res.statusCode, 200);
  });
});

describe('GET /api/admin/status reports where the request came from', () => {
  it('remote:false for a local request', async () => {
    const app = await startServer(baseConfig());
    const res = await app.inject({ method: 'GET', url: '/api/admin/status', ...localUi });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { authRequired: false, authenticated: true, remote: false });
  });
});

describe('POST /api/admin/password', { concurrency: 1 }, () => {
  it('sets a password from a remote browser while FREEMODELFINDER_TRUST_UI is on', async () => {
    process.env.FREEMODELFINDER_TRUST_UI = 'true';
    const app = await startServer(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...remoteUi,
      payload: { action: 'set', password: PANEL_PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, authRequired: true });

    // The write is live in this process: no restart needed before it bites.
    const locked = await app.inject({
      method: 'GET',
      url: '/api/config',
      ...remoteUi,
    });
    assert.equal(locked.statusCode, 401);
    assert.equal(locked.json().error.code, 'admin_signin_required');

    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: PANEL_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().error, undefined);
  });

  it('persists a verifier that a fresh process can still check', async () => {
    const app = await startServer(baseConfig());
    await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: { action: 'set', password: PANEL_PASSWORD },
    });

    const persisted = await loadConfig();
    assert.ok(persisted.adminAuth, 'adminAuth must survive the round-trip');
    assert.equal(await verifyAdminPassword(PANEL_PASSWORD, persisted.adminAuth), true);
    assert.equal(await verifyAdminPassword('wrong-password', persisted.adminAuth), false);
  });

  it('refuses a second password with action=set', async () => {
    const app = await startWithPassword();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: { action: 'set', password: 'another-secret' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'admin_password_exists');
  });

  it('rejects a password that is too short', async () => {
    const app = await startServer(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: { action: 'set', password: 'short' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'admin_password_too_short');
  });

  it('rejects an unknown action', async () => {
    const app = await startServer(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: { action: 'explode', password: PANEL_PASSWORD },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'admin_password_bad_action');
  });

  it('changes the password when the current one is correct', async () => {
    const app = await startWithPassword();
    const next = 'seven-correct-horses';
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: { action: 'change', currentPassword: PANEL_PASSWORD, password: next },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, authRequired: true });

    const oldGone = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: PANEL_PASSWORD },
    });
    assert.equal(oldGone.statusCode, 401);

    const fresh = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: next },
    });
    assert.equal(fresh.statusCode, 200);
  });

  it('change and clear reject a wrong current password without touching the stored one', async () => {
    const app = await startWithPassword();
    for (const action of ['change', 'clear']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/password',
        ...localUi,
        payload: { action, currentPassword: 'not-it', password: 'seven-correct-horses' },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'admin_bad_password');
    }
    const stillValid = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: PANEL_PASSWORD },
    });
    assert.equal(stillValid.statusCode, 200);
  });

  it('change and clear both require a password to exist', async () => {
    const app = await startServer(baseConfig());
    for (const action of ['change', 'clear']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/password',
        ...localUi,
        payload: { action, currentPassword: 'anything' },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, 'admin_password_missing');
    }
  });

  it('locks a client out of change after five wrong current passwords', async () => {
    const app = await startWithPassword();
    let status = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      status = (
        await app.inject({
          method: 'POST',
          url: '/api/admin/password',
          ...localUi,
          payload: { action: 'change', currentPassword: 'nope', password: 'seven-correct-horses' },
        })
      ).statusCode;
    }
    assert.equal(status, 429);

    // Even the right current password is refused while the lockout holds.
    const locked = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: {
        action: 'change',
        currentPassword: PANEL_PASSWORD,
        password: 'seven-correct-horses',
      },
    });
    assert.equal(locked.statusCode, 429);
  });

  it('clears the failure counter on a successful change', async () => {
    const app = await startWithPassword();
    await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: { action: 'change', currentPassword: 'typo', password: 'seven-correct-horses' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: {
        action: 'change',
        currentPassword: PANEL_PASSWORD,
        password: 'seven-correct-horses',
      },
    });
    assert.equal(res.statusCode, 200);
  });

  it('clears the password when the current one is correct', async () => {
    const app = await startWithPassword();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...localUi,
      payload: { action: 'clear', currentPassword: PANEL_PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, authRequired: false });

    const status = await app.inject({ method: 'GET', url: '/api/admin/status', ...localUi });
    assert.deepEqual(status.json(), { authRequired: false, authenticated: true, remote: false });

    // The panel is open to a local UI again, with no session required.
    const config = await app.inject({ method: 'GET', url: '/api/config', ...localUi });
    assert.equal(config.statusCode, 200);
  });

  it('a signed-in session is still required once a password exists', async () => {
    const app = await startWithPassword();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/password',
      ...remoteUi,
      payload: { action: 'clear', currentPassword: PANEL_PASSWORD },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'admin_signin_required');
  });
});

describe('gateway API is untouched by the management password', () => {
  it('/v1/models still needs a gateway key, not a panel session', async () => {
    const adminAuth = await hashAdminPassword(PANEL_PASSWORD);
    const app = await startServer(
      baseConfig({
        adminAuth,
        gateway: { requireAuth: true, apiKey: 'gateway-secret' },
      }),
    );
    const withoutKey = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress: REMOTE_IP,
    });
    assert.equal(withoutKey.statusCode, 401);
    assert.equal(withoutKey.json().error.code, 'invalid_api_key');

    const withKey = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress: REMOTE_IP,
      headers: { authorization: 'Bearer gateway-secret' },
    });
    assert.equal(withKey.statusCode, 200);
  });

  it('a signed-in browser may use the local gateway without a key, like trustedUi', async () => {
    const adminAuth = await hashAdminPassword(PANEL_PASSWORD);
    const app = await startServer(
      baseConfig({
        adminAuth,
        gateway: { requireAuth: true, apiKey: 'gateway-secret' },
      }),
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      remoteAddress: REMOTE_IP,
      payload: { password: PANEL_PASSWORD },
    });
    const token = setCookieOf(login)!.split(';')[0]!;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress: REMOTE_IP,
      headers: { host: '127.0.0.1:11435', cookie: token },
    });
    assert.equal(res.statusCode, 200);
  });
});
