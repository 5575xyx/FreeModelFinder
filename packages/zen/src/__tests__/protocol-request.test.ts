import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isZenProtocol } from '../protocol/types.js';

describe('zen protocol types', () => {
  it('accepts the three native protocols', () => {
    assert.equal(isZenProtocol('chat'), true);
    assert.equal(isZenProtocol('responses'), true);
    assert.equal(isZenProtocol('anthropic'), true);
  });

  it('rejects anything else', () => {
    assert.equal(isZenProtocol('systemone'), false);
    assert.equal(isZenProtocol(''), false);
  });
});
