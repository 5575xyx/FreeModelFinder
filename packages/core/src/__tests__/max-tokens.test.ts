import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractMaxTokensLimit, isMaxTokensTooLargeError } from '../max-tokens.js';

describe('isMaxTokensTooLargeError', () => {
  it('detects upstream max_tokens overflow messages', () => {
    const err = new Error(
      'custom stream failed 400: {"error":{"message":"max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.","type":"invalid_request_error","param":"max_tokens","code":"invalid_value"}}',
    );
    assert.equal(isMaxTokensTooLargeError(err), true);
  });

  it('detects OpenAI-style param max_tokens invalid_value', () => {
    const err = new Error(
      'chat failed 400: {"error":{"message":"max_tokens must be less than 8192","type":"invalid_request_error","param":"max_tokens","code":"invalid_value"}}',
    );
    assert.equal(isMaxTokensTooLargeError(err), true);
  });

  it('rejects unrelated errors', () => {
    assert.equal(isMaxTokensTooLargeError(new Error('prompt is too long')), false);
    assert.equal(isMaxTokensTooLargeError(new Error('failed 429 rate limited')), false);
    assert.equal(isMaxTokensTooLargeError('max_tokens is too large: 10'), true);
  });
});

describe('extractMaxTokensLimit', () => {
  it('parses "at most N" from upstream message', () => {
    const err = new Error(
      'custom stream failed 400: {"error":{"message":"max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000."}}',
    );
    assert.equal(extractMaxTokensLimit(err), 16384);
  });

  it('returns undefined when no limit is present', () => {
    assert.equal(extractMaxTokensLimit(new Error('max_tokens is too large')), undefined);
  });
});
