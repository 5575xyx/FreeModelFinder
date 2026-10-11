import { describe, expect, it } from 'vitest';
import { modelValue } from '../models';

describe('modelValue', () => {
  it('composes provider:id when the model has no alias', () => {
    expect(modelValue({ provider: 'openrouter', id: 'gpt-4o-mini' })).toBe(
      'openrouter:gpt-4o-mini',
    );
  });

  it('uses alias_of as the request value so the UI never sends an alias', () => {
    expect(
      modelValue({ provider: 'opencode', id: 'my-model', alias_of: 'opencode:mimo-v2.6' }),
    ).toBe('opencode:mimo-v2.6');
  });

  it('prefixes a bare alias_of from an OpenAI-compatible provider', () => {
    expect(modelValue({ provider: 'openrouter', id: 'my-model', alias_of: 'gpt-4o-mini' })).toBe(
      'openrouter:gpt-4o-mini',
    );
  });

  it('prefixes the custom provider so a custom alias dispatches its catalog id', () => {
    expect(modelValue({ provider: 'custom', id: 'my-model', alias_of: 'fx:fast' })).toBe(
      'custom:fx:fast',
    );
  });
});
