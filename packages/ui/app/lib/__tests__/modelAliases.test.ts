import { describe, expect, it } from 'vitest';
import { applyAliasEdit, invertAliases, validateAliasName } from '../modelAliases';

const T1 = 'openrouter:gpt-4o-mini';
const T2 = 'custom:novay:glm-5.3';

describe('invertAliases', () => {
  it('maps target to alias name', () => {
    expect(invertAliases({ glm: T2, 'novay/glm': T1 })).toEqual(
      new Map([
        [T2, 'glm'],
        [T1, 'novay/glm'],
      ]),
    );
  });
  it('returns an empty map for an empty table', () => {
    expect(invertAliases({})).toEqual(new Map());
  });
});

describe('validateAliasName', () => {
  it('accepts an empty name as "clear"', () => {
    expect(validateAliasName('', T1, {})).toBeNull();
  });
  it('treats a whitespace-only name as "clear"', () => {
    expect(validateAliasName('   ', T1, {})).toBeNull();
  });
  it('accepts a normal name', () => {
    expect(validateAliasName('nemotron', T1, {})).toBeNull();
  });
  it('accepts a name containing "/" (legacy prefix form stays legal)', () => {
    expect(validateAliasName('novay/glm', T1, {})).toBeNull();
  });
  it('rejects a name containing ":"', () => {
    expect(validateAliasName('a:b', T1, {})?.key).toBe('finder.alias.error.colon');
  });
  it('rejects reserved routing keywords', () => {
    expect(validateAliasName('auto', T1, {})?.key).toBe('finder.alias.error.reserved');
    expect(validateAliasName('default', T1, {})?.key).toBe('finder.alias.error.reserved');
  });
  it('rejects Object.prototype keys', () => {
    expect(validateAliasName('toString', T1, {})?.key).toBe('finder.alias.error.invalid');
  });
  it('reports the owning target when the name is taken by another model', () => {
    const err = validateAliasName('glm', T2, { glm: T1 });
    expect(err?.key).toBe('finder.alias.error.taken');
    expect(err?.params).toEqual({ name: 'glm', model: T1 });
  });
  it('does not report a conflict when the name already belongs to this target', () => {
    expect(validateAliasName('glm', T1, { glm: T1 })).toBeNull();
  });
});

describe('applyAliasEdit', () => {
  it('writes a new alias', () => {
    expect(applyAliasEdit({}, T2, 'glm')).toEqual({ glm: T2 });
  });
  it('drops the previous name when renaming (no orphan alias for the same target)', () => {
    expect(applyAliasEdit({ glm: T2 }, T2, 'gpt')).toEqual({ gpt: T2 });
  });
  it('trims the name before writing', () => {
    expect(applyAliasEdit({}, T2, '  glm  ')).toEqual({ glm: T2 });
  });
  it('deletes the target on an empty name', () => {
    expect(applyAliasEdit({ glm: T2, keep: T1 }, T2, '')).toEqual({ keep: T1 });
  });
  it('removes the key entirely on a whitespace-only name', () => {
    expect(applyAliasEdit({ glm: T2 }, T2, '   ')).toEqual({});
  });
  it('preserves unrelated entries', () => {
    expect(applyAliasEdit({ keep: T1 }, T2, 'glm')).toEqual({ keep: T1, glm: T2 });
  });
});
