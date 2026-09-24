import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatRequestSchema, ImageGenerationRequestSchema } from '../../types.js';
import { AgnesIntlProvider } from '../agnes-intl.js';
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

    const result = await provider.generateImage!(
      ImageGenerationRequestSchema.parse({
        model: 'agnes-image-2.5-flash',
        prompt: 'a cute cat',
        size: '1024x1024',
      }),
    );

    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]!.url, 'https://example.com/image.png');
  });

  it('generates image with b64_json response', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        created: Date.now(),
        data: [{ b64_json: 'base64data...' }],
      }),
    });

    const result = await provider.generateImage!(
      ImageGenerationRequestSchema.parse({
        model: 'agnes-image-2.5-flash',
        prompt: 'a cute cat',
        response_format: 'b64_json',
      }),
    );

    assert.equal(result.data[0]!.b64_json, 'base64data...');
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
        provider.generateImage!(
          ImageGenerationRequestSchema.parse({
            model: 'agnes-image-2.5-flash',
            prompt: 'test',
          }),
        ),
      /401/,
    );
  });

  it('rejects chat requests containing image contentParts', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({}),
    });
    const req = ChatRequestSchema.parse({
      model: 'agnes-3.0-flash',
      messages: [
        {
          role: 'user',
          content: 'describe this',
          contentParts: [{ type: 'image_url', image_url: { url: 'http://x/y.png' } }],
        },
      ],
    });
    await assert.rejects(
      () => provider.chat(req),
      /^Error: Provider agnes does not support image input$/,
    );
  });

  it('allows text-only chat on agnes', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        id: 'c1',
        model: 'agnes-3.0-flash',
        created: 1,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
      }),
    });
    const req = ChatRequestSchema.parse({
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = await provider.chat(req);
    assert.equal(res.content, 'hi');
  });
});

describe('AgnesIntlProvider vision guard', () => {
  it('rejects chat requests containing image contentParts', async () => {
    const provider = new AgnesIntlProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({}),
    });
    const req = ChatRequestSchema.parse({
      model: 'agnes-3.0-flash',
      messages: [
        {
          role: 'user',
          content: 'describe this',
          contentParts: [{ type: 'image_url', image_url: { url: 'http://x/y.png' } }],
        },
      ],
    });
    await assert.rejects(
      () => provider.chat(req),
      /^Error: Provider agnes-intl does not support image input$/,
    );
  });

  it('allows text-only chat on agnes-intl', async () => {
    const provider = new AgnesIntlProvider({
      credentials: { apiKey: 'test-key' },
      fetchImpl: mockFetch({
        id: 'c1',
        model: 'agnes-3.0-flash',
        created: 1,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
      }),
    });
    const req = ChatRequestSchema.parse({
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = await provider.chat(req);
    assert.equal(res.content, 'hi');
  });
});
