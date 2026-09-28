import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClineLoginAdapter, type ClineDeviceAuthorization } from '../adapters/cline.js';

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

const DEVICE_URL = 'https://api.workos.com/user_management/authorize/device';
const AUTH_URL = 'https://api.workos.com/user_management/authenticate';
const REGISTER_URL = 'https://api.cline.bot/api/v1/auth/register';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function formBody(call: RecordedCall | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call?.init?.body ?? '')));
}

function jsonBody(call: RecordedCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;
}

function deviceStart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_code: 'device-code-1',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://webos.example/activate',
    verification_uri_complete: 'https://webos.example/activate?user_code=ABCD-EFGH',
    interval: 5,
    expires_in: 300,
    ...overrides,
  };
}

function authorization(
  deviceCode = 'device-code-1',
  interval = 0,
  expiresIn = 300,
): ClineDeviceAuthorization {
  return {
    deviceCode,
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://webos.example/activate?user_code=ABCD-EFGH',
    interval,
    expiresIn,
  };
}

describe('ClineLoginAdapter device authorization', () => {
  it('requests a device code and maps the WorkOS fields', async () => {
    const { calls, fetchImpl } = harness(() => json(deviceStart()));
    const adapter = new ClineLoginAdapter({ fetchImpl });

    const start = await adapter.start();

    assert.equal(calls[0]?.url, DEVICE_URL);
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.equal(formBody(calls[0]).client_id, 'client_01K3A541FN8TA3EPPHTD2325AR');
    assert.deepEqual(start, {
      deviceCode: 'device-code-1',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://webos.example/activate?user_code=ABCD-EFGH',
      interval: 5,
      expiresIn: 300,
    });
  });

  it('falls back to verification_uri and honours a custom client id', async () => {
    const { calls, fetchImpl } = harness(() =>
      json(
        deviceStart({
          verification_uri_complete: undefined,
          interval: undefined,
          expires_in: undefined,
        }),
      ),
    );
    const adapter = new ClineLoginAdapter({ fetchImpl, clientId: 'client_custom' });

    const start = await adapter.start();

    assert.equal(formBody(calls[0]).client_id, 'client_custom');
    assert.equal(start.verificationUri, 'https://webos.example/activate');
    assert.equal(start.interval, 5);
    assert.equal(start.expiresIn, 300);
  });

  it('surfaces upstream failures from the device endpoint', async () => {
    const { fetchImpl } = harness(() => new Response('Bearer sk-leaked-token', { status: 500 }));
    const adapter = new ClineLoginAdapter({ fetchImpl });

    await assert.rejects(() => adapter.start(), /device authorization failed 500/);
  });

  it('rejects a device response missing the required fields', async () => {
    const { fetchImpl } = harness(() => json({ device_code: 'device-code-1' }));
    const adapter = new ClineLoginAdapter({ fetchImpl });

    await assert.rejects(() => adapter.start(), /unexpected body/);
  });

  it('reports pending while the user has not approved yet', async () => {
    const { fetchImpl } = harness(() => json({ error: 'authorization_pending' }, 400));
    const adapter = new ClineLoginAdapter({ fetchImpl });

    const result = await adapter.createCheck(authorization())();

    assert.equal(result.status, 'pending');
  });

  it('treats slow_down as pending', async () => {
    const { fetchImpl } = harness(() => json({ error: 'slow_down' }, 400));
    const adapter = new ClineLoginAdapter({ fetchImpl });

    const result = await adapter.createCheck(authorization())();

    assert.equal(result.status, 'pending');
  });

  it('exchanges an approved session for a cline refresh token', async () => {
    const { calls, fetchImpl } = harness((call) => {
      if (call.url === AUTH_URL) {
        return json({ access_token: 'workos-access', refresh_token: 'workos-refresh' });
      }
      if (call.url === REGISTER_URL) {
        return json({
          data: { refreshToken: 'rt-issued', userInfo: { email: 'ada@example.com' } },
        });
      }
      return json({});
    });
    const adapter = new ClineLoginAdapter({ fetchImpl });

    const result = await adapter.createCheck(authorization())();

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.result, { refreshToken: 'rt-issued', email: 'ada@example.com' });
    const register = calls.find((call) => call.url === REGISTER_URL);
    assert.deepEqual(jsonBody(register), {
      accessToken: 'workos-access',
      refreshToken: 'workos-refresh',
    });
  });

  it('maps rejection and expiry to denied reasons', async () => {
    for (const [error, reason] of [
      ['access_denied', 'access_denied'],
      ['expired_token', 'expired_token'],
      ['invalid_grant', 'invalid_grant'],
    ] as const) {
      const { fetchImpl } = harness(() => json({ error }, 400));
      const adapter = new ClineLoginAdapter({ fetchImpl });
      const result = await adapter.createCheck(authorization())();
      assert.equal(result.status, 'denied');
      assert.equal(result.reason, reason);
    }
  });

  it('denies the flow when the register step issues no token', async () => {
    const { fetchImpl } = harness((call) =>
      call.url === AUTH_URL
        ? json({ access_token: 'workos-access' })
        : json({ error: 'register failed' }, 500),
    );
    const adapter = new ClineLoginAdapter({ fetchImpl });

    const result = await adapter.createCheck(authorization())();

    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'register_failed');
  });

  it('waits for the advertised poll interval before querying upstream again', async () => {
    const { calls, fetchImpl } = harness(() => json({ error: 'authorization_pending' }, 400));
    const adapter = new ClineLoginAdapter({ fetchImpl });
    const check = adapter.createCheck(authorization('device-code-1', 30));

    assert.equal((await check()).status, 'pending');
    assert.equal((await check()).status, 'pending');
    assert.equal(calls.length, 1);

    const throttled = adapter.createCheck(authorization('device-code-2', 0));
    assert.equal((await throttled()).status, 'pending');
    assert.equal((await throttled()).status, 'pending');
    assert.equal(calls.length, 3);
  });

  it('surfaces upstream failures from the poll query so the state machine keeps the flow pending', async () => {
    const { fetchImpl } = harness(() => {
      throw new Error('network down');
    });
    const adapter = new ClineLoginAdapter({ fetchImpl });

    await assert.rejects(() => adapter.createCheck(authorization('device-code-3', 0))());
  });
});
