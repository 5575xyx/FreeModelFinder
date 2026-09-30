import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isContextLengthExceededError } from '../context-length.js';

describe('isContextLengthExceededError', () => {
  it('matches the upstream context_length_exceeded payload', () => {
    const err = new Error(
      'custom stream failed 400: {"error":{"message":"input exceeds the context limit; set truncation to auto to permit history truncation","type":"invalid_request_error","param":"","code":"context_length_exceeded"}}',
    );
    assert.equal(isContextLengthExceededError(err), true);
  });

  it('matches natural-language context limit wording', () => {
    assert.equal(
      isContextLengthExceededError(new Error('This model-s maximum context length is 8192 tokens')),
      true,
    );
    assert.equal(
      isContextLengthExceededError(new Error('context window exceeded for this model')),
      true,
    );
    assert.equal(
      isContextLengthExceededError(new Error('prompt is too long: 120000 tokens > 200000 maximum')),
      true,
      'anthropic style wording must count as a context overflow too',
    );
  });

  it('reads a bare string as well as an Error instance', () => {
    assert.equal(isContextLengthExceededError('code: context_length_exceeded'), true);
    assert.equal(isContextLengthExceededError(undefined), false);
    assert.equal(isContextLengthExceededError(null), false);
  });

  it('does not misread rate-limit or max_tokens rejections', () => {
    assert.equal(
      isContextLengthExceededError(new Error('custom chat failed 429: rate limit exceeded')),
      false,
    );
    assert.equal(
      isContextLengthExceededError(new Error('max_tokens is too large; at most 4096')),
      false,
    );
    assert.equal(
      isContextLengthExceededError(new Error('custom chat failed 400: model not found')),
      false,
    );
  });
});
