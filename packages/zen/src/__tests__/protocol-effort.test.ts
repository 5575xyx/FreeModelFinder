import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyForcedEffort, clientEffortExplicit, resolveEffort } from '../protocol/effort.js';

describe('zen forced effort', () => {
  it('applies effort to a chat body when the client did not set one', () => {
    const body: Record<string, unknown> = { model: 'm', messages: [] };
    applyForcedEffort(body, 'chat', 'high');
    assert.equal(body.reasoning_effort, 'high');
  });

  it('lets an explicit client effort win', () => {
    const body: Record<string, unknown> = { model: 'm', messages: [], reasoning_effort: 'low' };
    applyForcedEffort(body, 'chat', 'high');
    assert.equal(body.reasoning_effort, 'low');
  });

  it('applies effort to a responses body', () => {
    const body: Record<string, unknown> = { model: 'm', input: [] };
    applyForcedEffort(body, 'responses', 'medium');
    assert.deepEqual(body.reasoning, { effort: 'medium' });
  });

  it('does not override an explicit client effort with none', () => {
    const body: Record<string, unknown> = { model: 'm', messages: [], reasoning_effort: 'high' };
    applyForcedEffort(body, 'chat', 'none');
    assert.equal(body.reasoning_effort, 'high');
  });

  it('none removes a derived thinking config when the client set no explicit effort', () => {
    const body: Record<string, unknown> = {
      model: 'm',
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 8192 },
    };
    applyForcedEffort(body, 'anthropic', 'none');
    assert.equal('thinking' in body, false);
  });

  it('resolveEffort prefers the per-model override', () => {
    assert.equal(resolveEffort('m', 'low', { m: 'max' }), 'max');
    assert.equal(resolveEffort('other', 'low', { m: 'max' }), 'low');
    assert.equal(resolveEffort('other', undefined, {}), undefined);
  });

  it('maps anthropic effort onto output_config and a thinking budget', () => {
    const body: Record<string, unknown> = { model: 'm', messages: [] };
    applyForcedEffort(body, 'anthropic', 'high');
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 8192 });
  });

  it('uses the documented budget tiers for xhigh and max', () => {
    const xhigh: Record<string, unknown> = { model: 'm' };
    applyForcedEffort(xhigh, 'anthropic', 'xhigh');
    assert.deepEqual(xhigh.thinking, { type: 'enabled', budget_tokens: 16384 });
    const max: Record<string, unknown> = { model: 'm' };
    applyForcedEffort(max, 'anthropic', 'max');
    assert.deepEqual(max.thinking, { type: 'enabled', budget_tokens: 32768 });
  });

  it('keeps anthropic max_tokens strictly above the thinking budget', () => {
    const body: Record<string, unknown> = { model: 'm', max_tokens: 4000 };
    applyForcedEffort(body, 'anthropic', 'high');
    assert.equal(body.max_tokens, 8192 + 4096);
    const untouched: Record<string, unknown> = { model: 'm', max_tokens: 20000 };
    applyForcedEffort(untouched, 'anthropic', 'high');
    assert.equal(untouched.max_tokens, 20000);
  });

  it('none strips the anthropic thinking block and output_config', () => {
    const body: Record<string, unknown> = {
      model: 'm',
      output_config: {},
      thinking: { type: 'enabled', budget_tokens: 1024 },
      max_tokens: 20000,
    };
    applyForcedEffort(body, 'anthropic', 'none');
    assert.equal('thinking' in body, false);
    assert.equal('output_config' in body, false);
    assert.equal(body.max_tokens, 20000);
  });

  it('does not overwrite an explicit anthropic effort', () => {
    const body: Record<string, unknown> = { model: 'm', output_config: { effort: 'low' } };
    applyForcedEffort(body, 'anthropic', 'high');
    assert.deepEqual(body.output_config, { effort: 'low' });
  });

  it('clientEffortExplicit follows the three protocol shapes', () => {
    assert.equal(clientEffortExplicit('chat', { reasoning_effort: 'high' }), true);
    assert.equal(clientEffortExplicit('chat', { reasoning: { effort: 'high' } }), false);
    assert.equal(clientEffortExplicit('anthropic', { output_config: { effort: 'xhigh' } }), true);
    assert.equal(clientEffortExplicit('anthropic', { effort: 'max' }), true);
    assert.equal(clientEffortExplicit('anthropic', {}), false);
    assert.equal(clientEffortExplicit('responses', { reasoning: { effort: 'medium' } }), true);
    assert.equal(clientEffortExplicit('responses', { reasoning: { budget_tokens: 8192 } }), false);
  });
});
