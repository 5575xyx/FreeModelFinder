import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPENCODE_CLIENT_HEADERS, openCodeUserAgent } from '../identity/client.js';

describe('opencode client identity', () => {
  it('builds an opencode user agent', () => {
    assert.match(openCodeUserAgent(), /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/);
    assert.equal(openCodeUserAgent(), 'opencode/latest/2.0.29/cli');
  });

  it('identifies as the cli client', () => {
    assert.equal(OPENCODE_CLIENT_HEADERS['x-opencode-client'], 'cli');
  });
});
