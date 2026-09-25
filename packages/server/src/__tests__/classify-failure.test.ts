import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyFailure } from '../routes/openai.js';

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
