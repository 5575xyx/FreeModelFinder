import { decryptSecret, loadConfig, loadMasterKey, saveConfig } from '../config/store.js';
import { encryptString, looksEncrypted } from '../config/crypto.js';
import type {
  AppConfig,
  CredentialAccountEntry,
  CredentialPlatform,
  CredentialPoolConfig,
} from '../types.js';

const SENSITIVE_PAYLOAD_FIELDS = new Set([
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'apikey',
  'token',
  'secret',
  'password',
  'authorization',
  'clientsecret',
]);

let storeChain: Promise<void> = Promise.resolve();

function withStoreLock<T>(op: () => Promise<T>): Promise<T> {
  const run = storeChain.then(op, op);
  storeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isSensitiveField(key: string): boolean {
  return SENSITIVE_PAYLOAD_FIELDS.has(key.replace(/[_-]/g, '').toLowerCase());
}

function normalizeEntry(input: unknown): CredentialAccountEntry | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<CredentialAccountEntry>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const payload: Record<string, string> = {};
  if (raw.payload && typeof raw.payload === 'object') {
    for (const [key, value] of Object.entries(raw.payload)) {
      if (typeof value === 'string') payload[key] = value;
    }
  }
  const entry: CredentialAccountEntry = {
    id: raw.id,
    status: raw.status === 'invalid' ? 'invalid' : 'active',
    addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
    payload,
  };
  if (typeof raw.label === 'string') entry.label = raw.label;
  if (typeof raw.lastUsedAt === 'number') entry.lastUsedAt = raw.lastUsedAt;
  return entry;
}

function normalizePool(input: unknown): CredentialPoolConfig {
  if (!input || typeof input !== 'object') return { accounts: [] };
  const raw = input as Partial<CredentialPoolConfig>;
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts
        .map((entry) => normalizeEntry(entry))
        .filter((entry): entry is CredentialAccountEntry => entry !== null)
    : [];
  const strategy =
    raw.strategy === 'round_robin' || raw.strategy === 'fill' || raw.strategy === 'random'
      ? raw.strategy
      : undefined;
  const pool: CredentialPoolConfig = { accounts };
  if (strategy !== undefined) pool.strategy = strategy;
  if (typeof raw.cooldownFallbackMinutes === 'number') {
    pool.cooldownFallbackMinutes = raw.cooldownFallbackMinutes;
  }
  return pool;
}

function decryptPayload(
  payload: Record<string, string>,
  masterKey: Buffer,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    try {
      out[key] = decryptSecret(value, masterKey);
    } catch {
      out[key] = looksEncrypted(value) ? '' : value;
    }
  }
  return out;
}

function encryptPayload(
  payload: Record<string, string>,
  masterKey: Buffer,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] =
      isSensitiveField(key) && value && !looksEncrypted(value)
        ? encryptString(value, masterKey)
        : value;
  }
  return out;
}

function withCredentials(
  config: AppConfig,
  platform: CredentialPlatform,
  pool: CredentialPoolConfig,
): AppConfig {
  return { ...config, credentials: { ...config.credentials, [platform]: pool } };
}

export async function getPool(platform: CredentialPlatform): Promise<CredentialPoolConfig> {
  const config = await loadConfig();
  const pool = normalizePool(config.credentials?.[platform]);
  const masterKey = await loadMasterKey();
  return {
    ...pool,
    accounts: pool.accounts.map((entry) => ({
      ...entry,
      payload: decryptPayload(entry.payload, masterKey),
    })),
  };
}

export async function loadPools(): Promise<
  Partial<Record<CredentialPlatform, CredentialPoolConfig>>
> {
  const config = await loadConfig();
  const masterKey = await loadMasterKey();
  const out: Partial<Record<CredentialPlatform, CredentialPoolConfig>> = {};
  for (const [platform, raw] of Object.entries(config.credentials ?? {})) {
    const pool = normalizePool(raw);
    out[platform as CredentialPlatform] = {
      ...pool,
      accounts: pool.accounts.map((entry) => ({
        ...entry,
        payload: decryptPayload(entry.payload, masterKey),
      })),
    };
  }
  return out;
}

export function upsertAccount(
  platform: CredentialPlatform,
  entry: CredentialAccountEntry,
): Promise<void> {
  return withStoreLock(async () => {
    const config = await loadConfig();
    const masterKey = await loadMasterKey();
    const pool = normalizePool(config.credentials?.[platform]);
    const stored: CredentialAccountEntry = {
      ...entry,
      payload: encryptPayload(entry.payload ?? {}, masterKey),
    };
    const index = pool.accounts.findIndex((account) => account.id === entry.id);
    if (index >= 0) {
      pool.accounts[index] = stored;
    } else {
      pool.accounts.push(stored);
    }
    await saveConfig(withCredentials(config, platform, pool));
  });
}

export function removeAccount(platform: CredentialPlatform, accountId: string): Promise<void> {
  return withStoreLock(async () => {
    const config = await loadConfig();
    const pool = normalizePool(config.credentials?.[platform]);
    pool.accounts = pool.accounts.filter((account) => account.id !== accountId);
    await saveConfig(withCredentials(config, platform, pool));
  });
}

export function saveSettings(
  platform: CredentialPlatform,
  settings: Partial<Omit<CredentialPoolConfig, 'accounts'>>,
): Promise<void> {
  return withStoreLock(async () => {
    const config = await loadConfig();
    const pool = normalizePool(config.credentials?.[platform]);
    if (settings.strategy !== undefined) pool.strategy = settings.strategy;
    if (settings.cooldownFallbackMinutes !== undefined) {
      pool.cooldownFallbackMinutes = settings.cooldownFallbackMinutes;
    }
    await saveConfig(withCredentials(config, platform, pool));
  });
}
