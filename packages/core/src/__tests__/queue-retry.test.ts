import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isQueueFullError, retryOnQueueFull } from '../queue-retry.js';

describe('isQueueFullError', () => {
  it('detects Agnes image queue-full 503 messages', () => {
    const err = new Error(
      'agnes image generation failed 503: {"error":{"message":"文生图队列已满，请稍后重试"}}',
    );
    assert.equal(isQueueFullError(err), true);
  });

  it('detects Agnes video queue-full 503 messages', () => {
    const err = new Error(
      'agnes video creation failed 503: {"code":"video_queue_full","message":"视频队列已满，请稍后重试"}',
    );
    assert.equal(isQueueFullError(err), true);
  });

  it('detects bare queue_full code without Chinese text', () => {
    const err = new Error('upstream failed 503: queue_full');
    assert.equal(isQueueFullError(err), true);
  });

  it('rejects non-queue errors', () => {
    assert.equal(
      isQueueFullError(new Error('agnes image generation failed 400: prompt too long')),
      false,
    );
    assert.equal(isQueueFullError(new Error('network timeout')), false);
    assert.equal(isQueueFullError(new Error('failed 429 rate limited')), false);
  });

  it('accepts non-Error values by stringifying', () => {
    assert.equal(isQueueFullError('failed 503 queue full'), true);
    assert.equal(isQueueFullError('something else'), false);
  });
});

describe('retryOnQueueFull', () => {
  it('returns first success without retrying', async () => {
    let calls = 0;
    const result = await retryOnQueueFull(
      () => {
        calls += 1;
        return Promise.resolve('ok');
      },
      { sleep: async () => {} },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries queue-full failures then succeeds', async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryOnQueueFull(
      () => {
        calls += 1;
        if (calls < 3) {
          return Promise.reject(new Error('agnes image generation failed 503: 文生图队列已满'));
        }
        return Promise.resolve('ok');
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.equal(delays.length, 2);
    assert.ok(delays[0]! > 0);
    assert.ok(delays[1]! >= delays[0]!);
  });

  it('does not retry non-queue errors', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnQueueFull(
          () => {
            calls += 1;
            return Promise.reject(new Error('agnes image generation failed 400: bad request'));
          },
          { sleep: async () => {} },
        ),
      /400/,
    );
    assert.equal(calls, 1);
  });

  it('gives up after maxAttempts and rethrows the last queue-full error', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnQueueFull(
          () => {
            calls += 1;
            return Promise.reject(new Error('failed 503 queue_full'));
          },
          { maxAttempts: 3, sleep: async () => {} },
        ),
      /503/,
    );
    assert.equal(calls, 3);
  });
});
