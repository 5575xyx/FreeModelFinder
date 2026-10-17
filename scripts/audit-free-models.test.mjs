import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SUBSCRIPTION_PROVIDERS,
  isFreeAuditModel,
  isFreeAuditProvider,
} from './lib/audit-filter.mjs';

// 免费审计报告（FREE_MODELS.md + reports/）是给"还没付费"的读者看的。
// 订阅账号走的是用户已付费的额度，混进去会让报告凭空多出一批"免费"模型。
describe('free-model audit excludes subscription quota', () => {
  it('names the three subscription providers', () => {
    assert.deepEqual([...SUBSCRIPTION_PROVIDERS].sort(), ['claude', 'codex', 'google']);
  });

  it('skips a subscription provider by id', () => {
    for (const id of SUBSCRIPTION_PROVIDERS) {
      assert.equal(isFreeAuditProvider(id), false, `${id} must not be audited`);
    }
  });

  it('keeps the free API-key providers', () => {
    for (const id of ['openrouter', 'gemini', 'zhipu', 'siliconflow', 'nvidia', 'ollama']) {
      assert.equal(isFreeAuditProvider(id), true, `${id} must stay audited`);
    }
  });

  // 订阅目录里的模型带 free: true —— 只看 free 字段会把它们全放进来。
  it('drops a model flagged subscription even when free is true', () => {
    assert.equal(
      isFreeAuditModel({ id: 'claude:claude-opus-4.8', free: true, subscription: true }),
      false,
    );
    assert.equal(
      isFreeAuditModel({ id: 'codex:gpt-5.1-codex-max', free: true, subscription: true }),
      false,
    );
    assert.equal(
      isFreeAuditModel({ id: 'google:gemini-3-pro', free: true, subscription: true }),
      false,
    );
  });

  it('keeps an ordinary free model', () => {
    assert.equal(isFreeAuditModel({ id: 'deepseek-v4-flash', free: true }), true);
  });

  it('still rejects a non-free, empty or malformed model', () => {
    assert.equal(isFreeAuditModel({ id: 'gpt-4o', free: false }), false);
    assert.equal(isFreeAuditModel({ id: 'no-flag' }), false);
    assert.equal(isFreeAuditModel({ id: '   ', free: true }), false);
    assert.equal(isFreeAuditModel({ free: true }), false);
    assert.equal(isFreeAuditModel(null), false);
    assert.equal(isFreeAuditModel(undefined), false);
  });
});
