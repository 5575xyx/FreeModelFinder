import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropicToChatRequest, type AnthropicMessagesRequest } from '../protocols/anthropic.js';
import { geminiToChatRequest, type GeminiHttpRequest } from '../protocols/gemini.js';

describe('anthropic/gemini inbound image parts', () => {
  it('maps anthropic image block to contentParts', () => {
    const out = anthropicToChatRequest({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image',
              source: { type: 'url', media_type: 'image/png', url: 'https://example.com/a.png' },
            },
          ],
        },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    const parts = out.messages[0]!.contentParts!;
    assert.ok(parts.some((p) => p.type === 'image_url'));
    assert.equal(out.messages[0]!.content, 'what is this');
  });

  it('maps gemini inlineData to contentParts data URL', () => {
    const out = geminiToChatRequest('gemini', {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'desc' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
        },
      ],
    } as unknown as GeminiHttpRequest);
    const parts = out.messages[0]!.contentParts!;
    const img = parts.find((p) => p.type === 'image_url');
    assert.ok(img && img.type === 'image_url');
    assert.equal(img.image_url.url, 'data:image/png;base64,AAAA');
  });
});

describe('openai outbound encoding', () => {
  it('serializes contentParts as OpenAI content array', async () => {
    const { toOpenAIMessages } = await import('../providers/openai-messages.js');
    const msgs = toOpenAIMessages([
      {
        role: 'user',
        content: 'see this',
        contentParts: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      },
    ]);
    assert.deepEqual(msgs[0], {
      role: 'user',
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
    });
  });

  it('keeps string content when no image parts', async () => {
    const { toOpenAIMessages } = await import('../providers/openai-messages.js');
    const msgs = toOpenAIMessages([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(msgs[0], { role: 'user', content: 'hi' });
  });
});
