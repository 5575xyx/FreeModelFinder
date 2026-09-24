import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { looksVisionModelId, isVisionCapable, withVisionInput } from '../vision.js';
import type { ModelInfo } from '../types.js';

describe('vision helpers', () => {
  it('looksVisionModelId matches common vision ids', () => {
    assert.equal(looksVisionModelId('qwen2.5-vl-7b-instruct'), true);
    assert.equal(looksVisionModelId('google/gemini-2.0-flash-exp:free'), false);
    assert.equal(looksVisionModelId('meta/llama-3.2-11b-vision-instruct:free'), true);
    assert.equal(looksVisionModelId('gpt-4o-mini'), false);
    assert.equal(looksVisionModelId('glm-4v-flash'), true);
  });

  it('withVisionInput appends image when missing', () => {
    const m = { id: 'x', provider: 'openrouter', displayName: 'X', free: true } as ModelInfo;
    const out = withVisionInput(m);
    assert.deepEqual(out.inputModalities, ['text', 'image']);
    const already = withVisionInput({ ...m, inputModalities: ['image'] });
    assert.deepEqual(already.inputModalities, ['image']);
  });

  it('isVisionCapable uses metadata, heuristic, or forced pool ids', () => {
    const meta = {
      id: 'a',
      provider: 'openrouter',
      displayName: 'a',
      free: true,
      inputModalities: ['image'],
    } as ModelInfo;
    assert.equal(isVisionCapable(meta, []), true);
    const heuristic = {
      id: 'llava-1.5',
      provider: 'custom',
      displayName: 'b',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(heuristic, []), true);
    const forced = {
      id: 'custom:special-vision',
      provider: 'custom',
      displayName: 'c',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(forced, ['custom:special-vision']), true);
    const textOnly = {
      id: 'gpt-4o-mini',
      provider: 'openrouter',
      displayName: 'd',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(textOnly, []), false);
  });
});
