import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ImageGenerationRequestSchema,
  ImageGenerationResponseSchema,
  VideoGenerationRequestSchema,
  VideoGenerationResponseSchema,
} from '../types.js';

describe('multimodal types', () => {
  it('validates image generation request', () => {
    const req = ImageGenerationRequestSchema.parse({
      model: 'agnes-image-2.5-flash',
      prompt: 'a cute cat',
      size: '1024x1024',
    });
    assert.equal(req.model, 'agnes-image-2.5-flash');
    assert.equal(req.size, '1024x1024');
  });

  it('validates image generation response', () => {
    const res = ImageGenerationResponseSchema.parse({
      created: Date.now(),
      data: [{ url: 'https://example.com/image.png' }],
    });
    assert.equal(res.data.length, 1);
    const first = res.data[0];
    assert.ok(first);
    assert.equal(first.url, 'https://example.com/image.png');
  });

  it('validates video generation request', () => {
    const req = VideoGenerationRequestSchema.parse({
      model: 'agnes-video-v2.0',
      prompt: 'a cat playing',
      width: 1152,
      height: 768,
      num_frames: 121,
      frame_rate: 24,
    });
    assert.equal(req.num_frames, 121);
    assert.equal(req.frame_rate, 24);
  });

  it('validates video generation response with video_id', () => {
    const res = VideoGenerationResponseSchema.parse({
      video_id: 'vid_123',
      status: 'queued',
    });
    assert.equal(res.video_id, 'vid_123');
    assert.equal(res.status, 'queued');
  });
});
