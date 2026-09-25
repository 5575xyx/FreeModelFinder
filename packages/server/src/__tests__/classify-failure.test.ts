import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CandidatesExhaustedError, classifyFailure, classifyStatus } from '../routes/openai.js';

describe('classifyFailure', () => {
  it('prefers rate-limit when a 429 also looks model-unavailable', () => {
    const r = classifyFailure(
      new Error('custom stream failed 429: model not available, no available channel'),
    );
    assert.equal(r.kind, 'rate-limit');
  });

  it('classifies pure upstream-unavailable 400s as unavailable', () => {
    const r = classifyFailure(
      new Error(
        'modelscope stream failed 400: {"error":{"message":"Model id : deepseek-ai/DeepSeek-V3.1 , has no provider supported"}}',
      ),
    );
    assert.equal(r.kind, 'unavailable');
  });

  it('classifies new-api model_not_found without 429 as unavailable', () => {
    const r = classifyFailure(
      new Error(
        'custom stream failed 503: {"error":{"message":"No available channel for model vision-down","code":"model_not_found"}}',
      ),
    );
    assert.equal(r.kind, 'unavailable');
  });

  it('classifies other 4xx as request errors', () => {
    const r = classifyFailure(
      new Error('custom stream failed 400: temperature must be between 0 and 2'),
    );
    assert.equal(r.kind, 'request');
  });

  it('classifies 5xx and unknown errors as upstream', () => {
    assert.equal(classifyFailure(new Error('custom stream failed 500: boom')).kind, 'upstream');
    assert.equal(classifyFailure(new Error('socket hang up')).kind, 'upstream');
  });
});

describe('classifyStatus', () => {
  it('reports pool exhaustion as error/503, never rate_limited/429', () => {
    const err = new CandidatesExhaustedError(2, { unavailable: 2, rateLimit: 0, upstream: 0 }, [
      'custom:deepseek-v3.1-dead',
      'custom:deepseek-v3.2-dead',
    ]);
    // The summary text contains "0 rate-limited", which the rate-limit
    // detector would otherwise match.
    assert.deepEqual(classifyStatus(err), { status: 'error', httpStatus: 503 });
  });

  it('still flags genuine rate limits as rate_limited/429', () => {
    assert.deepEqual(classifyStatus(new Error('custom stream failed 429: rate limit exceeded')), {
      status: 'rate_limited',
      httpStatus: 429,
    });
  });

  it('keeps plain upstream failures as error with their status code', () => {
    assert.deepEqual(classifyStatus(new Error('custom stream failed 500: boom')), {
      status: 'error',
      httpStatus: 500,
    });
  });
});
