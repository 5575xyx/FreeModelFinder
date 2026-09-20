import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgnesProvider } from '../agnes.js';

function mockFetch(responseBody: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('AgnesProvider multimodal', () => {
  it('generates image via /images/generations', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        created: Date.now(),
        data: [{ url: 'https://example.com/image.png' }],
      }),
    });

    const result = await provider.generateImage!({
      model: 'agnes-image-2.5-flash',
      prompt: 'a cute cat',
      size: '1024x1024',
    });

    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].url, 'https://example.com/image.png');
  });

  it('generates image with b64_json response', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        created: Date.now(),
        data: [{ b64_json: 'base64data...' }],
      }),
    });

    const result = await provider.generateImage!({
      model: 'agnes-image-2.5-flash',
      prompt: 'a cute cat',
      response_format: 'b64_json',
    });

    assert.equal(result.data[0].b64_json, 'base64data...');
  });

  it('creates video via /videos', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        video_id: 'vid_abc123',
        status: 'queued',
      }),
    });

    const result = await provider.generateVideo!({
      model: 'agnes-video-v2.0',
      prompt: 'a cat playing',
      width: 1152,
      height: 768,
      num_frames: 121,
      frame_rate: 24,
    });

    assert.equal(result.video_id, 'vid_abc123');
    assert.equal(result.status, 'queued');
  });

  it('queries video status via /agnesapi', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        video_id: 'vid_abc123',
        status: 'completed',
        remixed_from_video_id: 'https://example.com/video.mp4',
      }),
    });

    const result = await provider.queryVideoStatus!('vid_abc123');

    assert.equal(result.status, 'completed');
    assert.equal(result.video_url, 'https://example.com/video.mp4');
  });

  it('throws on image generation failure', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({ error: { message: 'Invalid API key' } }, 401),
    });

    await assert.rejects(
      () =>
        provider.generateImage!({
          model: 'agnes-image-2.5-flash',
          prompt: 'test',
        }),
      /401/,
    );
  });
});