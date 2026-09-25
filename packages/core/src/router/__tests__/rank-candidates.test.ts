import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeModel, makeRouter, makeSettings } from './fixtures.js';

describe('AutoRouter.rankCandidates', () => {
  it('sorts models by descending score regardless of input order', async () => {
    const harness = makeRouter([
      makeModel('alive-mini', 'custom'),
      makeModel('deepseek-v3.1-dead', 'custom'),
    ]);
    const ranked = await harness.router.rankCandidates();
    assert.deepEqual(
      ranked.map((m) => m.id),
      ['deepseek-v3.1-dead', 'alive-mini'],
    );
  });

  it('breaks score ties by model id', async () => {
    const harness = makeRouter([makeModel('zzz-tie', 'custom'), makeModel('aaa-tie', 'custom')]);
    const ranked = await harness.router.rankCandidates();
    assert.deepEqual(
      ranked.map((m) => m.id),
      ['aaa-tie', 'zzz-tie'],
    );
  });

  it('excludes unavailable-marked and rate-limited models', async () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('qwen-other-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    harness.router.markModelUnavailable('deepseek-v3.1-dead', 'custom', 'no provider supported');
    harness.router.markRateLimited('qwen-other-dead', 'custom', {
      isRateLimit: true,
      resetAt: Date.now() + 60_000,
      message: '429',
    });
    const ranked = await harness.router.rankCandidates();
    assert.deepEqual(
      ranked.map((m) => m.id),
      ['alive-mini'],
    );
  });

  it('excludes every model of a provider-wide (shared quota) cooldown', async () => {
    const harness = makeRouter([
      makeModel('model-a', 'openrouter'),
      makeModel('model-b', 'openrouter'),
      makeModel('alive-mini', 'custom'),
    ]);
    harness.router.markRateLimited('model-a', 'openrouter', {
      isRateLimit: true,
      resetAt: Date.now() + 60_000,
      message: '429',
    });
    const ranked = await harness.router.rankCandidates();
    assert.deepEqual(
      ranked.map((m) => m.id),
      ['alive-mini'],
      'shared-quota provider cooldown removes all of its models',
    );
  });

  it('returns an empty list when auto route is disabled', async () => {
    const harness = makeRouter(
      [makeModel('alive-mini', 'custom')],
      makeSettings({ enabled: false }),
    );
    assert.deepEqual(await harness.router.rankCandidates(), []);
  });
});
