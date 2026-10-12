import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateModelAliases } from '../aliases.js';

describe('validateModelAliases', () => {
  const known = new Set(['openrouter:gpt-4o-mini', 'gpt-4o-mini']);

  function expectOk(input: unknown): Record<string, string> {
    const res = validateModelAliases(input, known);
    assert.equal(res.ok, true);
    if (!res.ok) assert.fail('expected the alias map to be accepted');
    return res.aliases;
  }

  function expectError(input: unknown): string {
    const res = validateModelAliases(input, known);
    assert.equal(res.ok, false);
    if (res.ok) assert.fail('expected the alias map to be rejected');
    return res.error;
  }

  it('accepts a well-formed map and trims both sides', () => {
    const aliases = expectOk({ ' my-model ': ' openrouter:gpt-4o-mini ' });
    assert.deepEqual(aliases, { 'my-model': 'openrouter:gpt-4o-mini' });
  });

  it('accepts an empty map', () => {
    assert.deepEqual(expectOk({}), {});
  });

  it('rejects a non-object payload', () => {
    assert.equal(validateModelAliases(null, known).ok, false);
    assert.equal(validateModelAliases(['a'], known).ok, false);
    assert.equal(validateModelAliases('a', known).ok, false);
  });

  it('rejects an empty alias name', () => {
    assert.match(expectError({ '   ': 'openrouter:gpt-4o-mini' }), /empty/i);
  });

  it('rejects an alias containing a colon', () => {
    assert.match(expectError({ 'my:model': 'openrouter:gpt-4o-mini' }), /must not contain/);
  });

  it('rejects the reserved names auto and default', () => {
    assert.equal(validateModelAliases({ auto: 'openrouter:gpt-4o-mini' }, known).ok, false);
    assert.equal(validateModelAliases({ default: 'openrouter:gpt-4o-mini' }, known).ok, false);
  });

  it('accepts an alias that has the same name as a known model id', () => {
    // Shadowing a model id is harmless: routing tries the alias map first, and
    // toClientFacingModel's exact-target branch reverse-maps it unambiguously.
    const aliases = expectOk({ 'gpt-4o-mini': 'openrouter:gpt-4o-mini' });
    assert.deepEqual(aliases, { 'gpt-4o-mini': 'openrouter:gpt-4o-mini' });
  });

  it('reports the colon rule before the conflict rule for a composed id', () => {
    assert.match(
      expectError({ 'openrouter:gpt-4o-mini': 'openrouter:gpt-4o-mini' }),
      /must not contain/,
    );
  });

  it('rejects a missing or blank target', () => {
    assert.equal(validateModelAliases({ 'my-model': '' }, known).ok, false);
    assert.equal(validateModelAliases({ 'my-model': '   ' }, known).ok, false);
    assert.equal(validateModelAliases({ 'my-model': 42 }, known).ok, false);
  });

  it('allows a target that is not in the catalog today', () => {
    assert.deepEqual(expectOk({ 'my-model': 'opencode:not-yet-listed' }), {
      'my-model': 'opencode:not-yet-listed',
    });
  });

  it('rejects keys inherited from Object.prototype', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.match(
        expectError({ [key]: 'openrouter:gpt-4o-mini' }),
        /not a valid identifier/,
        `${key} must be rejected`,
      );
    }
  });

  it('never loses an alias silently', () => {
    const res = validateModelAliases(JSON.parse('{"__proto__": "openrouter:gpt-4o-mini"}'), known);
    assert.equal(res.ok, false);
    assert.ok(!('aliases' in res));
  });

  it('rejects a target that is the reserved keyword auto', () => {
    assert.match(expectError({ 'my-model': 'auto' }), /cannot point to/);
  });

  it('rejects a target that is the reserved keyword default', () => {
    assert.match(expectError({ 'my-model': 'default' }), /cannot point to/);
  });

  it('rejects an alias cycle', () => {
    assert.match(expectError({ a: 'b', b: 'a' }), /alias cycle/);
  });

  it('accepts an alias chain regardless of key order', () => {
    const expected = { a: 'b', b: 'c', c: 'openrouter:gpt-4o-mini' };
    for (const input of [
      { a: 'b', b: 'c', c: 'openrouter:gpt-4o-mini' },
      { c: 'openrouter:gpt-4o-mini', b: 'c', a: 'b' },
      { b: 'c', a: 'b', c: 'openrouter:gpt-4o-mini' },
    ]) {
      assert.deepEqual(
        expectOk(input),
        expected,
        `chain must be accepted for ${JSON.stringify(input)}`,
      );
    }
  });

  it('rejects a three-alias cycle in any rotation', () => {
    for (const input of [
      { a: 'b', b: 'c', c: 'a' },
      { b: 'c', c: 'a', a: 'b' },
      { c: 'a', a: 'b', b: 'c' },
    ]) {
      assert.match(
        expectError(input),
        /alias cycle/,
        `cycle must be rejected for ${JSON.stringify(input)}`,
      );
    }
  });

  it('does not report a false duplicate for a chain onto an unused model', () => {
    const aliases = expectOk({ other: 'openrouter:gpt-4o-mini', mine: 'other' });
    assert.deepEqual(aliases, { other: 'openrouter:gpt-4o-mini', mine: 'other' });
  });

  it('rejects two alias names that collide only after trimming', () => {
    assert.match(
      expectError({ 'fast ': 'openrouter:gpt-4o-mini', fast: 'other-model' }),
      /duplicate alias name/,
    );
  });

  it('rejects two aliases pointing at the same model', () => {
    assert.match(
      expectError({ fast: 'openrouter:gpt-4o-mini', cheap: 'openrouter:gpt-4o-mini' }),
      /duplicates an existing alias target/,
    );
  });

  it('rejects an alias that points to itself', () => {
    assert.match(expectError({ a: 'a' }), /cannot point to itself/);
  });
});
