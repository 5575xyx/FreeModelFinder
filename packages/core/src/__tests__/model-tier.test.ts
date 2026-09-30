import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelProfile, TIER_SCORES } from '../model-tier.js';

describe('parseModelProfile', () => {
  it('small markers win over flagship markers', () => {
    assert.equal(parseModelProfile('cpa:gpt-4o-mini').tier, 'small');
    assert.equal(parseModelProfile('glm-4-flash').tier, 'small');
    assert.equal(parseModelProfile('glm-4.5-flash').tier, 'small');
    assert.equal(parseModelProfile('claude-3.5-haiku').tier, 'small');
    assert.equal(parseModelProfile('inclusionai/ling-3.0-flash-sante:free').tier, 'small');
    assert.equal(parseModelProfile('gemini-2.0-flash').tier, 'small');
  });

  it('tiny markers rank below small', () => {
    assert.equal(parseModelProfile('qwen2.5-3b-instruct').tier, 'tiny');
    assert.equal(parseModelProfile('tiny-1b').tier, 'tiny');
    assert.equal(parseModelProfile('nano-2b').tier, 'tiny');
  });

  it('minor markers capture 7b-10b and named small tiers', () => {
    assert.equal(parseModelProfile('llama-3.1-8b-instruct').tier, 'minor');
    assert.equal(parseModelProfile('qwen2.5-small').tier, 'minor');
    assert.equal(parseModelProfile('some-nano-model').tier, 'minor');
  });

  it('flagship markers still apply when no size marker present', () => {
    assert.equal(parseModelProfile('cpa:gpt-4o').tier, 'flagship');
    assert.equal(parseModelProfile('cpa:gpt-5.5').tier, 'flagship');
    assert.equal(parseModelProfile('claude-3-opus').tier, 'flagship');
    assert.equal(parseModelProfile('llama-3.1-70b-instruct').tier, 'flagship');
    assert.equal(parseModelProfile('deepseek-v3').tier, 'flagship');
    assert.equal(parseModelProfile('glm-4.5').tier, 'flagship');
    assert.equal(parseModelProfile('gemini-2.5-pro').tier, 'flagship');
  });

  it('large markers capture gpt-4 class and 30b-40b', () => {
    assert.equal(parseModelProfile('cpa:gpt-4').tier, 'large');
    assert.equal(parseModelProfile('glm-4-air').tier, 'large');
    assert.equal(parseModelProfile('meta/llama-3.3-40b').tier, 'large');
    assert.equal(parseModelProfile('claude-3-sonnet').tier, 'large');
  });

  it('parameter counts need word boundaries so 140b is not 40b', () => {
    assert.equal(parseModelProfile('mystery-140b').tier, 'standard');
    assert.equal(parseModelProfile('mystery-40b').tier, 'large');
    assert.equal(parseModelProfile('mystery-10b').tier, 'minor');
    assert.equal(parseModelProfile('mystery-20b').tier, 'small');
    assert.equal(parseModelProfile('mystery-405b').tier, 'flagship');
  });

  it('unknown ids fall back to standard', () => {
    assert.equal(parseModelProfile('mystery-model').tier, 'standard');
    assert.equal(TIER_SCORES.standard, 50);
  });

  it('parses numeric generations and leaves unparseable ones null', () => {
    assert.equal(parseModelProfile('cpa:gpt-5.5').generation, 5.5);
    assert.equal(parseModelProfile('cpa:gpt-4o').generation, 4);
    assert.equal(parseModelProfile('claude-3.5-sonnet').generation, 3.5);
    assert.equal(parseModelProfile('deepseek-v3').generation, 3);
    assert.equal(parseModelProfile('gemini-2.5-flash').generation, 2.5);
    assert.equal(parseModelProfile('qwen2.5-7b').generation, 2.5);
    assert.equal(parseModelProfile('llama3').generation, 3);
    assert.equal(parseModelProfile('mystery-model').generation, null);
  });

  it('tier score table matches the frozen value domain', () => {
    assert.deepEqual(TIER_SCORES, {
      flagship: 95,
      large: 80,
      standard: 50,
      small: 65,
      minor: 45,
      tiny: 30,
    });
  });
});
