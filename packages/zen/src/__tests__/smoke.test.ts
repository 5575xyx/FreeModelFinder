import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZEN_PACKAGE_NAME } from '../index.js';

describe('zen package', () => {
  it('exposes its package name', () => {
    assert.equal(ZEN_PACKAGE_NAME, '@freemodelfinder/zen');
  });
});
