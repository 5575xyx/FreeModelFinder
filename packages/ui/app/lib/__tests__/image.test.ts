import { describe, expect, it } from 'vitest';
import { fileToDataURL, isImageDataUrlWithinLimit, MAX_IMAGE_DATA_BYTES } from '../image';

const SMALL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('isImageDataUrlWithinLimit', () => {
  it('accepts a small data URL', () => {
    expect(isImageDataUrlWithinLimit(SMALL_PNG)).toBe(true);
  });

  it('accepts non-data URLs', () => {
    expect(isImageDataUrlWithinLimit('https://example.com/a.png')).toBe(true);
  });

  it('accepts a data URL without base64 marker by payload length', () => {
    expect(isImageDataUrlWithinLimit('data:image/png,abc')).toBe(true);
  });

  it('rejects a base64 payload over the 10MB limit', () => {
    const big = `data:image/png;base64,${'A'.repeat(14 * 1024 * 1024)}`;
    expect(isImageDataUrlWithinLimit(big)).toBe(false);
    expect(MAX_IMAGE_DATA_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts a payload exactly at the approximate limit', () => {
    // floor(len * 3 / 4) === MAX when len === ceil(MAX * 4 / 3).
    const payloadLen = Math.ceil((MAX_IMAGE_DATA_BYTES * 4) / 3);
    expect(isImageDataUrlWithinLimit(`data:image/png;base64,${'A'.repeat(payloadLen)}`)).toBe(true);
  });
});

describe('fileToDataURL', () => {
  it('reads a File into a data URL', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    const url = await fileToDataURL(file);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects when the input is not a readable File', async () => {
    await expect(fileToDataURL(undefined as unknown as File)).rejects.toThrow();
  });
});
