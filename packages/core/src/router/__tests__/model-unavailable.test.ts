import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatResetTime, parseModelUnavailableError } from '../auto-router.js';
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
  it('removes only the model (not the provider) and makes pickFallback skip it', async () => {
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
    assert.equal(
      state.resetAt,
      Number.POSITIVE_INFINITY,
      'unavailable models are removed permanently',
    );
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

describe('formatResetTime with permanent markers', () => {
  it('renders Infinity as permanently excluded', () => {
    assert.equal(formatResetTime(Number.POSITIVE_INFINITY), '已永久剔除');
  });

  it('keeps normal timestamps unchanged', () => {
    const ts = new Date(2026, 8, 25, 10, 30, 0).getTime();
    assert.equal(formatResetTime(ts), '2026-09-25 10:30:00');
  });
});

describe('preference latch with permanent markers', () => {
  it('clears the remembered preference when it is permanently removed', async () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    harness.router.rememberPreference('custom:deepseek-v3.1-dead');
    harness.router.markModelUnavailable('deepseek-v3.1-dead', 'custom', 'no provider supported');

    const back = await harness.router.maybeSwitchBack('custom:alive-mini');
    assert.equal(back, null, 'no switch back to a permanently removed model');
    assert.equal(
      harness.router.getRememberedPreference(),
      null,
      'latch must release so a new preference can be remembered',
    );

    harness.router.rememberPreference('custom:alive-mini');
    assert.equal(harness.router.getRememberedPreference(), 'custom:alive-mini');
  });

  it('keeps the latch for ordinary rate-limited preferred models', async () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    harness.router.rememberPreference('custom:deepseek-v3.1-dead');
    harness.router.markRateLimited('deepseek-v3.1-dead', 'custom', {
      isRateLimit: true,
      resetAt: Date.now() + 60_000,
      message: '429',
    });
    const back = await harness.router.maybeSwitchBack('custom:alive-mini');
    assert.equal(back, null);
    assert.equal(
      harness.router.getRememberedPreference(),
      'custom:deepseek-v3.1-dead',
      'rate-limited (finite) preferences must keep the latch for later switch-back',
    );
  });

  it('clearCooldown removes a permanent marker (manual recovery)', async () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    harness.router.markModelUnavailable('deepseek-v3.1-dead', 'custom', 'no provider supported');
    assert.ok(harness.router.isRateLimited('deepseek-v3.1-dead'));
    assert.equal(harness.router.clearCooldown('deepseek-v3.1-dead'), true);
    assert.equal(harness.router.isRateLimited('deepseek-v3.1-dead'), null);
    const ranked = await harness.router.rankCandidates();
    assert.deepEqual(
      ranked.map((m) => m.id),
      ['deepseek-v3.1-dead', 'alive-mini'],
      'cleared model re-enters scoring',
    );
  });
});

describe('buildSwitchAwayMessage with permanent markers', () => {
  it('reports permanent removal instead of a reset time', () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    const state = harness.router.markModelUnavailable(
      'deepseek-v3.1-dead',
      'custom',
      'no provider supported',
    );
    const msg = harness.router.buildSwitchAwayMessage(state, makeModel('alive-mini', 'custom'));
    assert.match(msg, /已永久剔除/);
    assert.doesNotMatch(msg, /下次重置时间/);
  });

  it('keeps reset time wording for finite cooldowns', () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    const state = harness.router.markRateLimited('deepseek-v3.1-dead', 'custom', {
      isRateLimit: true,
      resetAt: Date.now() + 60_000,
      message: '429',
    });
    const msg = harness.router.buildSwitchAwayMessage(state, makeModel('alive-mini', 'custom'));
    assert.match(msg, /下次重置时间/);
    assert.doesNotMatch(msg, /永久剔除/);
  });
});
