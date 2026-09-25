import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseModelUnavailableError } from '../auto-router.js';
import { makeModel, makeRouter } from './fixtures.js';

describe('parseModelUnavailableError', () => {
  it('detects modelscope "has no provider supported" 400', () => {
    const r = parseModelUnavailableError(
      new Error(
        'modelscope stream failed 400: {"error":{"message":"Model id : deepseek-ai/DeepSeek-V3.1 , has no provider supported","request_id":"852d1ca1-2ce3-4e77-8dc2-e55f669bc6e2"}}',
      ),
    );
    assert.equal(r.isModelUnavailable, true);
  });

  it('detects new-api "No available channel" model_not_found', () => {
    const r = parseModelUnavailableError(
      new Error(
        'custom stream failed 503: {"error":{"message":"No available channel for model vision-down","type":"new_api_error","code":"model_not_found"}}',
      ),
    );
    assert.equal(r.isModelUnavailable, true);
  });

  it('detects openai-style model_not_found', () => {
    const r = parseModelUnavailableError(
      new Error(
        'openrouter stream failed 404: {"error":{"message":"The model `nope` does not exist","code":"model_not_found"}}',
      ),
    );
    assert.equal(r.isModelUnavailable, true);
  });

  it('does not flag max_tokens overflow 400', () => {
    const r = parseModelUnavailableError(
      new Error(
        'custom stream failed 400: {"error":{"message":"max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.","type":"invalid_request_error","param":"max_tokens","code":"invalid_value"}}',
      ),
    );
    assert.equal(r.isModelUnavailable, false);
  });

  it('does not flag rate-limit errors', () => {
    const r = parseModelUnavailableError(new Error('upstream failed 429 too many requests'));
    assert.equal(r.isModelUnavailable, false);
  });

  it('does not flag auth failures', () => {
    const r = parseModelUnavailableError(
      new Error('custom stream failed 401: {"error":{"message":"invalid api key"}}'),
    );
    assert.equal(r.isModelUnavailable, false);
  });

  it('does not flag vision "does not support image input"', () => {
    const r = parseModelUnavailableError(new Error('Provider custom does not support image input'));
    assert.equal(r.isModelUnavailable, false);
  });
});

describe('AutoRouter.markModelUnavailable', () => {
  it('cools down only the model (not the provider) and makes pickFallback skip it', async () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    const state = harness.router.markModelUnavailable(
      'deepseek-v3.1-dead',
      'custom',
      'has no provider supported',
    );
    assert.equal(state.scope, 'model');
    assert.ok(state.resetAt > Date.now(), 'cooldown expires in the future');
    assert.ok(harness.router.isRateLimited('deepseek-v3.1-dead'));
    assert.equal(harness.router.isProviderRateLimited('custom'), null);

    const fallback = await harness.router.pickFallback('custom:deepseek-v3.1-dead');
    assert.equal(fallback?.id, 'alive-mini', 'cooldown model must be excluded from fallback');
  });

  it('markModelUnavailable does not mark unrelated models', () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('qwen-other', 'custom'),
    ]);
    harness.router.markModelUnavailable('deepseek-v3.1-dead', 'custom', 'no provider supported');
    assert.equal(harness.router.isRateLimited('qwen-other'), null);
  });
});
