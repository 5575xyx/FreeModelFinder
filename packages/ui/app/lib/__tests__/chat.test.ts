import { describe, expect, it } from 'vitest';
import { toWireContent, type WirePart } from '../chat';

describe('toWireContent', () => {
  it('returns the plain string when there are no images', () => {
    expect(toWireContent('hello')).toBe('hello');
    expect(toWireContent('hello', [])).toBe('hello');
  });

  it('returns text then image parts when both are present', () => {
    const result = toWireContent('what is this', ['data:image/png;base64,AAAA']);
    expect(result).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('omits the text part when text is empty (image-only send)', () => {
    const result = toWireContent('', ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']);
    expect(result).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
    ]);
  });

  it('keeps image order stable', () => {
    const parts = toWireContent('t', ['u1', 'u2']) as WirePart[];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });
});
