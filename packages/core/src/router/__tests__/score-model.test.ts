import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreModel } from '../auto-router.js';
import { makeModel } from './fixtures.js';

describe('scoreModel', () => {
  it('S1: capability strategy scores 70b model >= 95', () => {
    const m = makeModel('llama-3.1-70b-instruct', 'openrouter');
    assert.ok(scoreModel(m, 'capability') >= 95);
  });

  it('S2: capability strategy scores 3b model <= 45', () => {
    const m = makeModel('qwen2.5-3b-instruct', 'siliconflow');
    assert.ok(scoreModel(m, 'capability') <= 45);
  });

  it('S3: capability strategy adds +5 for large context window', () => {
    const base = makeModel('mystery-model', 'gemini');
    const big = makeModel('mystery-model', 'gemini', { contextWindow: 200_000 });
    assert.equal(scoreModel(big, 'capability') - scoreModel(base, 'capability'), 5);
  });

  it('S4: speed strategy gives gemini-flash = 85', () => {
    const m = makeModel('gemini-2.0-flash', 'gemini');
    assert.equal(scoreModel(m, 'speed'), 85);
  });

  it('S5: speed strategy gives generic flash id = 78', () => {
    const m = makeModel('llama-flash-8b', 'openrouter');
    assert.equal(scoreModel(m, 'speed'), 78);
  });

  it('S6: speed strategy gives opus = 35', () => {
    const m = makeModel('claude-3-opus', 'openrouter');
    assert.equal(scoreModel(m, 'speed'), 35);
  });

  it('S7: rate-limit strategy uses profile.rpmLimit', () => {
    const m = makeModel('some-model', 'gemini');
    const profile = { id: 'some-model', provider: 'gemini' as const, rpmLimit: 1000 };
    const score = scoreModel(m, 'rate-limit', profile);
    const expected = Math.min(100, Math.log10(1001) * 30);
    assert.equal(score, expected);
  });

  it('S8: rate-limit strategy falls back to provider baseline (siliconflow=70)', () => {
    const m = makeModel('anything', 'siliconflow');
    assert.equal(scoreModel(m, 'rate-limit'), 70);
  });

  it('S9: profile.capabilityScore overrides heuristic', () => {
    const m = makeModel('tiny-1b', 'gemini');
    const profile = {
      id: 'tiny-1b',
      provider: 'gemini' as const,
      capabilityScore: 99,
    };
    assert.equal(scoreModel(m, 'capability', profile), 99);
  });

  it('S10: unknown provider falls back to 50 for rate-limit', () => {
    const m = makeModel('nothing', 'custom');
    assert.equal(scoreModel(m, 'rate-limit'), 50);
  });

  it('S11: gpt-4o-mini scores as a small model, not flagship', () => {
    const m = makeModel('cpa:gpt-4o-mini', 'custom');
    assert.equal(scoreModel(m, 'capability'), 65);
  });

  it('S12: glm-4-flash scores as a small model', () => {
    const m = makeModel('glm-4-flash', 'zhipu');
    assert.equal(scoreModel(m, 'capability'), 65);
  });

  it('S13: flagship ids keep 95', () => {
    assert.equal(scoreModel(makeModel('cpa:gpt-5.5', 'custom'), 'capability'), 95);
    assert.equal(scoreModel(makeModel('cpa:gpt-4o', 'custom'), 'capability'), 95);
    assert.equal(scoreModel(makeModel('llama-3.1-70b', 'openrouter'), 'capability'), 95);
  });

  it('S14: speed and rate-limit strategies are untouched by tier parsing', () => {
    assert.equal(scoreModel(makeModel('gemini-2.0-flash', 'gemini'), 'speed'), 85);
    assert.equal(scoreModel(makeModel('claude-3-opus', 'openrouter'), 'speed'), 35);
    assert.equal(scoreModel(makeModel('anything', 'siliconflow'), 'rate-limit'), 70);
  });
});
