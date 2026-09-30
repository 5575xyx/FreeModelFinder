import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sessionKeyOf } from '../session-key.js';

const user = (text: string) => ({ role: 'user' as const, content: text });

describe('sessionKeyOf', () => {
  it('is stable across later turns of the same conversation', () => {
    const first = sessionKeyOf([user('hello')]);
    const later = sessionKeyOf([user('hello'), { role: 'assistant', content: 'hi' }, user('next')]);
    assert.equal(first, later);
  });

  it('differs for different conversations', () => {
    assert.notEqual(sessionKeyOf([user('hello')]), sessionKeyOf([user('hello2')]));
  });

  it('ignores image parts so multimodal turns keep the same key', () => {
    const text = sessionKeyOf([user('describe')]);
    const withImage = sessionKeyOf([
      {
        role: 'user',
        content: 'describe',
        contentParts: [{ type: 'image_url', image_url: { url: 'u' } }],
      },
    ]);
    assert.equal(text, withImage);
  });

  it('returns a stable key when no user message exists', () => {
    assert.equal(
      sessionKeyOf([{ role: 'assistant', content: 'only' }]),
      sessionKeyOf([{ role: 'assistant', content: 'only' }]),
    );
  });
});
