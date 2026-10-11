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

  it('does not double-prefix when alias_of already carries the provider', () => {
    expect(modelValue({ provider: 'opencode', id: 'my-model', alias_of: 'opencode:mimo' })).toBe(
      'opencode:mimo',
    );
  });

  it('keeps the custom provider prefixing', () => {
    expect(modelValue({ provider: 'custom', id: 'fx:fast', alias_of: 'custom:fx:fast' })).toBe(
      'custom:custom:fx:fast',
    );
  });
});
