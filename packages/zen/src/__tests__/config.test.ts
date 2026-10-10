import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenConfigSchema, DEFAULT_ZEN_CONFIG, normalizeZenConfig } from '../config/index.js';

describe('zen config', () => {
  it('applies documented defaults', () => {
    const cfg = ZenConfigSchema.parse({});
    assert.equal(cfg.anonymous, false);
    assert.equal(cfg.prefer, 'go');
    assert.equal(cfg.upstream.zen, 'https://opencode.ai/zen');
    assert.equal(cfg.upstream.go, 'https://opencode.ai/zen/go');
    assert.equal(cfg.retry.maxAttempts, 3);
    assert.equal(cfg.retry.timeoutSeconds, 300);
    assert.equal(cfg.performance.failureCooldownSeconds, 15);
    assert.equal(cfg.performance.connectTimeoutSeconds, 15);
    assert.equal(cfg.models.refreshSeconds, 300);
  });

  it('rejects an unknown reasoning effort', () => {
    const result = ZenConfigSchema.safeParse({ reasoning: { effort: 'extreme' } });
    assert.equal(result.success, false);
  });

  it('accepts only chat/responses/anthropic protocol overrides', () => {
    const ok = ZenConfigSchema.safeParse({ models: { protocols: { m: 'anthropic' } } });
    assert.equal(ok.success, true);
    const bad = ZenConfigSchema.safeParse({ models: { protocols: { m: 'systemone' } } });
    assert.equal(bad.success, false);
  });

  it('normalizeZenConfig fills defaults and copies arrays', () => {
    const cfg = normalizeZenConfig({ zenKeys: ['k1'], goKeys: [] });
    assert.deepEqual(cfg.zenKeys, ['k1']);
    assert.equal(cfg.prefer, 'go');
  });

  it('exposes the documented default constant', () => {
    assert.deepEqual(DEFAULT_ZEN_CONFIG.retry, { maxAttempts: 3, timeoutSeconds: 300 });
  });
});
