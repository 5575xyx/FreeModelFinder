// Ported from cline-free (MIT), https://github.com/Patrick-mufeng/cline-free
import type { DeviceAuthPollResult } from '../device-auth.js';

const WORKOS_DEVICE_URL = 'https://api.workos.com/user_management/authorize/device';
const WORKOS_AUTH_URL = 'https://api.workos.com/user_management/authenticate';
const CLINE_REGISTER_URL = 'https://api.cline.bot/api/v1/auth/register';

const DEFAULT_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR';
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 300;
const DETAIL_LIMIT = 300;

export interface ClineDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface ClineLoginResult {
  refreshToken: string;
  email?: string;
}

export interface ClineLoginAdapterOptions {
  fetchImpl?: typeof fetch;
  clientId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class ClineLoginAdapter {
  private readonly clientId: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: ClineLoginAdapterOptions = {}) {
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    this.fetchImpl = options.fetchImpl;
  }

  async start(): Promise<ClineDeviceAuthorization> {
    const response = await this.fetch(WORKOS_DEVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId }).toString(),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `cline device authorization failed ${response.status}: ${detail.slice(0, DETAIL_LIMIT)}`,
      );
    }
    const data = asRecord(await response.json().catch(() => null));
    const deviceCode = data ? asString(data.device_code) : undefined;
    const verificationUri = data
      ? (asString(data.verification_uri_complete) ?? asString(data.verification_uri))
      : undefined;
    if (!deviceCode || !verificationUri) {
      throw new Error('cline device authorization returned an unexpected body');
    }
    return {
      deviceCode,
      userCode: (data && asString(data.user_code)) ?? '',
      verificationUri,
      interval: (data && asNumber(data.interval)) ?? DEFAULT_INTERVAL_SECONDS,
      expiresIn: (data && asNumber(data.expires_in)) ?? DEFAULT_EXPIRES_IN_SECONDS,
    };
  }

  createCheck(start: ClineDeviceAuthorization): () => Promise<DeviceAuthPollResult> {
    const minGapMs = Math.max(0, start.interval) * 1000;
    let lastPollAt = 0;
    return async () => {
      const now = Date.now();
      if (now - lastPollAt < minGapMs) return { status: 'pending' };
      lastPollAt = now;
      return this.pollUpstream(start.deviceCode);
    };
  }

  private get fetch(): typeof fetch {
    return this.fetchImpl ?? globalThis.fetch;
  }

  private async pollUpstream(deviceCode: string): Promise<DeviceAuthPollResult> {
    const response = await this.fetch(WORKOS_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: this.clientId,
      }).toString(),
    });
    const data = asRecord(await response.json().catch(() => null)) ?? {};
    const accessToken = asString(data.access_token);
    if (accessToken) {
      return this.register(accessToken, asString(data.refresh_token));
    }
    const error = asString(data.error);
    if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' };
    if (error) return { status: 'denied', reason: error };
    return { status: 'pending' };
  }

  private async register(
    accessToken: string,
    refreshToken?: string,
  ): Promise<DeviceAuthPollResult> {
    const response = await this.fetch(CLINE_REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, ...(refreshToken ? { refreshToken } : {}) }),
    });
    const data = asRecord(await response.json().catch(() => null));
    const payload = data ? asRecord(data.data) : null;
    const issued = payload ? asString(payload.refreshToken) : undefined;
    if (!issued) {
      return { status: 'denied', reason: 'register_failed' };
    }
    const userInfo = payload ? asRecord(payload.userInfo) : null;
    const email = userInfo ? asString(userInfo.email) : undefined;
    const result: ClineLoginResult = email
      ? { refreshToken: issued, email }
      : { refreshToken: issued };
    return { status: 'complete', result };
  }
}
