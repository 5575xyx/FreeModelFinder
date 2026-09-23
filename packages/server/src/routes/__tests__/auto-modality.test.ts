import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectRequestModality } from '../openai.js';

function textMsg(content: string) {
  return { role: 'user' as const, content };
}

describe('detectRequestModality image text intent', () => {
  it('detects Chinese image generation prompts', () => {
    assert.equal(detectRequestModality([textMsg('生成小猫图片')]), 'image');
    assert.equal(detectRequestModality([textMsg('帮我画一张风景插画')]), 'image');
    assert.equal(detectRequestModality([textMsg('generate an image of a cat')]), 'image');
  });

  it('does not flag ordinary chat', () => {
    assert.equal(detectRequestModality([textMsg('介绍一下 OpenRouter')]), 'text');
    assert.equal(detectRequestModality([textMsg('这张地图怎么走')]), 'text');
  });

  it('keeps video keyword priority over image text', () => {
    assert.equal(detectRequestModality([textMsg('生成一段小猫视频')]), 'video');
  });

  it('keeps uploaded image parts as image', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'http://x/y.png' } } as {
      type: string;
      text?: string;
    };
    assert.equal(
      detectRequestModality([
        {
          role: 'user' as const,
          content: [imagePart],
        },
      ]),
      'image',
    );
  });
});
