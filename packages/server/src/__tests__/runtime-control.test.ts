import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { hashAdminPassword, ProviderRegistry, type AppConfig } from '@freemodelfinder/core';
import { createServer } from '../server.js';
import { RUNTIME_PATH, type RuntimeDescriptor } from '../runtime.js';

const emptyConfig: AppConfig = {
  version: 2,
  port: 11435,
  providers: {},
  gateway: { requireAuth: false },
  autoRoute: { enabled: false, strategy: 'capability' },
};

describe('desktop runtime control', () => {
  it('writes an instance descriptor and requires its token to shut down', async () => {
    const server = await createServer({
      port: 0,
      registry: new ProviderRegistry(emptyConfig),
      watchIntervalMs: 60 * 60 * 1000,
    });
    const url = await server.listen(0);
    const descriptor = JSON.parse(await readFile(RUNTIME_PATH, 'utf8')) as RuntimeDescriptor;
    assert.equal(descriptor.port, Number(new URL(url).port));
    assert.equal(descriptor.pid, process.pid);
    assert.equal(descriptor.protocolVersion, 1);

    const denied = await server.app.inject({
      method: 'POST',
      url: '/api/runtime/shutdown',
      headers: {
        origin: 'tauri://localhost',
        'x-fmf-client': 'ui',
        'x-fmf-control-token': 'wrong',
      },
    });
    assert.equal(denied.statusCode, 401);

    const accepted = await server.app.inject({
      method: 'POST',
      url: '/api/runtime/shutdown',
      headers: {
        'x-fmf-control-token': descriptor.controlToken,
      },
    });
    assert.equal(accepted.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.app.server.listening, false);
  });

  it('keeps the desktop reading gateway details once a panel password exists', async () => {
    const server = await createServer({
      port: 0,
      registry: new ProviderRegistry({
        ...emptyConfig,
        adminAuth: await hashAdminPassword('correct-horse-battery'),
      }),
      watchIntervalMs: 60 * 60 * 1000,
    });
    const url = await server.listen(0);
    try {
      const descriptor = JSON.parse(await readFile(RUNTIME_PATH, 'utf8')) as RuntimeDescriptor;
      const uiHeaders = { origin: new URL(url).origin, 'x-fmf-client': 'ui' };

      // Being on the machine no longer opens the panel, so a bare loopback
      // request gets the sign-in wall.
      const local = await server.app.inject({
        method: 'GET',
        url: '/api/gateway',
        headers: uiHeaders,
      });
      assert.equal(local.statusCode, 401);
      assert.equal(local.json().error.code, 'admin_signin_required');

      // The status-bar menu hands over the control token it was given at spawn
      // and still gets the base URL and Gateway Key it copies into the snippet.
      const withToken = await server.app.inject({
        method: 'GET',
        url: '/api/gateway',
        headers: {
          origin: 'tauri://localhost',
          'x-fmf-client': 'ui',
          'x-fmf-control-token': descriptor.controlToken,
        },
      });
      assert.equal(withToken.statusCode, 200);

      // That token proves the desktop app spawned this runtime, not that an
      // operator is present, so it reads connection details but cannot rewrite
      // configuration.
      const write = await server.app.inject({
        method: 'PUT',
        url: '/api/gateway',
        headers: {
          origin: 'tauri://localhost',
          'x-fmf-client': 'ui',
          'x-fmf-control-token': descriptor.controlToken,
        },
        payload: { requireAuth: false },
      });
      assert.equal(write.statusCode, 401);
    } finally {
      await server.app.close();
    }
  });
});
