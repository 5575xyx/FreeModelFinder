import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateModelAliases } from '../aliases.js';

describe('validateModelAliases', () => {
  const known = new Set(['openrouter:gpt-4o-mini']);

  it('accepts a well-formed map and trims both sides', () => {
    const res = validateModelAliases({ ' my-model ': ' openrouter:gpt-4o-mini ' }, known);
    assert.equal(res.ok, true);
    assert.deepEqual(res.aliases, { 'my-model': 'openrouter:gpt-4o-mini' });
  });

  it('accepts an empty map', () => {
    const res = validateModelAliases({}, known);
    assert.equal(res.ok, true);
    assert.deepEqual(res.aliases, {});
  });

  it('rejects a non-object payload', () => {
    assert.equal(validateModelAliases(null, known).ok, false);
    assert.equal(validateModelAliases(['a'], known).ok, false);
    assert.equal(validateModelAliases('a', known).ok, false);
  });

  it('rejects an empty alias name', () => {
    const res = validateModelAliases({ '   ': 'openrouter:gpt-4o-mini' }, known);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /empty/i);
  });

  it('rejects an alias containing a colon', () => {
    const res = validateModelAliases({ 'my:model': 'openrouter:gpt-4o-mini' }, known);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /:/);
  });

  it('rejects the reserved names auto and default', () => {
    assert.equal(validateModelAliases({ auto: 'openrouter:gpt-4o-mini' }, known).ok, false);
    assert.equal(validateModelAliases({ default: 'openrouter:gpt-4o-mini' }, known).ok, false);
  });

  it('rejects an alias that collides with a known model id', () => {
    const res = validateModelAliases({ 'openrouter:gpt-4o-mini': 'openrouter:gpt-4o-mini' }, known);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /conflict/i);
  });

  it('rejects a missing or blank target', () => {
    assert.equal(validateModelAliases({ 'my-model': '' }, known).ok, false);
    assert.equal(validateModelAliases({ 'my-model': '   ' }, known).ok, false);
    assert.equal(validateModelAliases({ 'my-model': 42 }, known).ok, false);
  });

  it('allows a target that is not in the catalog today', () => {
    const res = validateModelAliases({ 'my-model': 'opencode:not-yet-listed' }, known);
    assert.equal(res.ok, true);
    assert.deepEqual(res.aliases, { 'my-model': 'opencode:not-yet-listed' });
  });
});
