import type { CredentialAccountEntry, CredentialPlatform, CredentialPoolConfig } from '../types.js';

export interface CredentialRuntime {
  getPool(platform: CredentialPlatform): Promise<CredentialPoolConfig>;
  upsertAccount(platform: CredentialPlatform, entry: CredentialAccountEntry): Promise<void>;
  removeAccount(platform: CredentialPlatform, accountId: string): Promise<void>;
  saveSettings(
    platform: CredentialPlatform,
    settings: Partial<Omit<CredentialPoolConfig, 'accounts'>>,
  ): Promise<void>;
  nextAccount(platform: CredentialPlatform, model: string): CredentialAccountEntry | null;
  reportRateLimit(
    platform: CredentialPlatform,
    accountId: string,
    model: string,
    resetAt?: number,
  ): void;
  reportInvalid(platform: CredentialPlatform, accountId: string): void;
  reportSuccess(platform: CredentialPlatform, accountId: string): void;
  clearAccountCooldowns(platform: CredentialPlatform, accountId: string): number;
  listAccountCooldowns(
    platform: CredentialPlatform,
    accountId: string,
  ): Array<{ model: string; resetAt: number }>;
  recordUsage(
    platform: CredentialPlatform,
    accountId: string,
    model: string,
    usage: { promptTokens?: number; completionTokens?: number; requests?: number; error?: string },
  ): void;
  snapshotUsage(platform: CredentialPlatform): Array<{
    accountId: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    lastError?: string;
  }>;
}
