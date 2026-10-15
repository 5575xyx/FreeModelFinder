import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { CredentialPlatform, ModelInfo } from '../../types.js';

const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-subscription-scaffold-'));
process.env.FREEMODELFINDER_HOME = testHome;

const { ProviderIdSchema } = await import('../../types.js');
const { loadConfig } = await import('../../config/store.js');

describe('subscription provider scaffold (Task 1)', () => {
  after(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  it('ProviderIdSchema accepts the three subscription provider ids', () => {
    for (const id of ['codex', 'claude', 'google'] as const) {
      const parsed = ProviderIdSchema.safeParse(id);
      assert.equal(parsed.success, true, `ProviderIdSchema should accept "${id}"`);
    }
    // 既有值不得回归
    assert.equal(ProviderIdSchema.safeParse('cline').success, true);
    assert.equal(ProviderIdSchema.safeParse('not-a-provider').success, false);
  });

  it('loadConfig() defaults codex/claude/google to enabled: false', async () => {
    const config = await loadConfig();
    assert.equal(config.providers.codex?.enabled, false, 'codex should default to disabled');
    assert.equal(config.providers.claude?.enabled, false, 'claude should default to disabled');
    assert.equal(config.providers.google?.enabled, false, 'google should default to disabled');
  });

  it('compile-time: subscription ids satisfy CredentialPlatform/ProviderId/ModelInfo types', () => {
    // 编译期断言：以下赋值只有在类型扩展后才能通过 tsc（pnpm typecheck 为门禁）。
    const platform: CredentialPlatform = 'google';
    const model: ModelInfo = {
      id: 'sub-model',
      provider: 'codex',
      displayName: 'Subscription Model',
      free: false,
      subscription: true,
    };
    assert.equal(platform, 'google');
    assert.equal(model.provider, 'codex');
    assert.equal(model.subscription, true);
    assert.equal(model.free, false);
  });
});
