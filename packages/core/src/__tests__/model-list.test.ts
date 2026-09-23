import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asModelList } from '../config/model-list.js';

describe('asModelList', () => {
  it('wraps non-empty string', () => {
    assert.deepEqual(asModelList('custom:a:b'), ['custom:a:b']);
  });

  it('returns [] for empty string / null / undefined / number', () => {
    assert.deepEqual(asModelList(''), []);
    assert.deepEqual(asModelList(null), []);
    assert.deepEqual(asModelList(undefined), []);
    assert.deepEqual(asModelList(42), []);
  });

  it('filters empty entries and dedupes arrays', () => {
    assert.deepEqual(asModelList(['a', '', 'b', 'a']), ['a', 'b']);
  });

  it('accepts readonly arrays', () => {
    assert.deepEqual(asModelList(['x'] as const), ['x']);
  });
});
