import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chatToolImages, decodeToolImages, responsesToolContent } from '../protocol/tool-images.js';
import { toChatBody } from '../protocol/chat.js';
import { toResponsesBody } from '../protocol/responses.js';
import { toAnthropicBody } from '../protocol/anthropic.js';
import { prepareRequest } from '../protocol/request.js';

describe('decodeToolImages', () => {
  it('returns undefined for a non-array value', () => {
    assert.equal(decodeToolImages('anthropic', 'just text'), undefined);
    assert.equal(decodeToolImages('responses', null), undefined);
    assert.equal(decodeToolImages('chat', 42), undefined);
  });

  it('returns undefined when the array has no image blocks', () => {
    assert.equal(decodeToolImages('anthropic', [{ type: 'text', text: 'hello' }]), undefined);
    assert.equal(decodeToolImages('responses', []), undefined);
    assert.equal(decodeToolImages('responses', [{ type: 'input_text', text: 'hi' }]), undefined);
  });

  it('decodes an Anthropic url image into an image_url part', () => {
    const url = 'https://example.com/pic.png';
    const parts = decodeToolImages('anthropic', [{ type: 'image', source: { type: 'url', url } }]);
    assert.deepEqual(parts, [{ type: 'image_url', image_url: { url } }]);
  });

  it('decodes an Anthropic base64 image into image_url + mediaType + data', () => {
    const parts = decodeToolImages('anthropic', [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
    ]);
    assert.deepEqual(parts, [
      { type: 'image_url', image_url: { url: '' }, mediaType: 'image/png', data: 'AAAA' },
    ]);
  });

  it('splits an OpenAI input_image data: URI into url="", mediaType, data', () => {
    const parts = decodeToolImages('responses', [
      { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB' },
    ]);
    assert.deepEqual(parts, [
      { type: 'image_url', image_url: { url: '' }, mediaType: 'image/jpeg', data: 'BBBB' },
    ]);
  });

  it('keeps an OpenAI input_image with an http URL as-is', () => {
    const url = 'https://example.com/x.png';
    const parts = decodeToolImages('responses', [{ type: 'input_image', image_url: url }]);
    assert.deepEqual(parts, [{ type: 'image_url', image_url: { url } }]);
  });

  it('preserves text blocks around images', () => {
    const parts = decodeToolImages('anthropic', [
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
      { type: 'text', text: 'after' },
    ]);
    assert.deepEqual(parts, [
      { type: 'text', text: 'before' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      { type: 'text', text: 'after' },
    ]);
  });

  it('accepts input_text alongside input_image for openai-style sources', () => {
    const parts = decodeToolImages('chat', [
      { type: 'input_text', text: 'seen' },
      { type: 'input_image', image_url: 'https://x/y.png' },
    ]);
    assert.deepEqual(parts, [
      { type: 'text', text: 'seen' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ]);
  });

  it('throws when a part is not an object', () => {
    // An image block must be present for validation to run at all: image-free
    // lists are left as-is, matching tool_images.go.
    assert.throws(
      () =>
        decodeToolImages('responses', [
          'not-an-object',
          { type: 'input_image', image_url: 'https://x/y.png' },
        ]),
      /content\[0\] must be an object/,
    );
  });

  it('throws when a text block lacks a string text field', () => {
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          { type: 'text' },
          { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
        ]),
      /content\[0\] requires text/,
    );
  });

  it('throws when an anthropic url source is empty', () => {
    assert.throws(
      () => decodeToolImages('anthropic', [{ type: 'image', source: { type: 'url' } }]),
      /unsupported or conflicting image source/,
    );
  });

  it('throws when an anthropic url source conflicts with data or file_id', () => {
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          {
            type: 'image',
            source: { type: 'url', url: 'https://x/y.png', data: 'stray' },
          },
        ]),
      /unsupported or conflicting image source/,
    );
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          {
            type: 'image',
            source: { type: 'url', url: 'https://x/y.png', file_id: 'f_1' },
          },
        ]),
      /unsupported or conflicting image source/,
    );
  });

  it('throws when an anthropic base64 source is missing media_type', () => {
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        ]),
      /unsupported or conflicting image source/,
    );
  });

  it('throws when an anthropic base64 media_type is not image/*', () => {
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'text/plain', data: 'AAAA' },
          },
        ]),
      /unsupported or conflicting image source/,
    );
  });

  it('throws when an anthropic base64 source conflicts with url or file_id', () => {
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'AAAA',
              url: 'https://x/y.png',
            },
          },
        ]),
      /unsupported or conflicting image source/,
    );
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'AAAA',
              file_id: 'f_1',
            },
          },
        ]),
      /unsupported or conflicting image source/,
    );
  });

  it('throws when an anthropic base64 source has empty data', () => {
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        ]),
      /unsupported or conflicting image source/,
    );
  });

  it('throws when an anthropic source type is unknown', () => {
    assert.throws(
      () =>
        decodeToolImages('anthropic', [{ type: 'image', source: { type: 'data', data: 'AAAA' } }]),
      /unsupported or conflicting image source/,
    );
  });

  it('throws when an openai input_image has an empty image_url', () => {
    assert.throws(
      () => decodeToolImages('responses', [{ type: 'input_image' }]),
      /requires an image URL/,
    );
    assert.throws(
      () => decodeToolImages('responses', [{ type: 'input_image', image_url: '' }]),
      /requires an image URL/,
    );
  });

  it('throws when an openai input_image conflicts with file_id', () => {
    assert.throws(
      () =>
        decodeToolImages('responses', [
          { type: 'input_image', image_url: 'https://x/y.png', file_id: 'f_1' },
        ]),
      /requires an image URL without a file reference/,
    );
  });

  it('throws on an unknown block type alongside tool images', () => {
    // The list must actually contain an image block for validation to run at
    // all: decodeToolImages leaves image-free lists untouched (see below).
    assert.throws(
      () =>
        decodeToolImages('responses', [
          { type: 'input_image', image_url: 'https://x/y.png' },
          { type: 'input_file', file_id: 'f_1' },
        ]),
      /unsupported block alongside tool images/,
    );
    assert.throws(
      () =>
        decodeToolImages('anthropic', [
          { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
          { type: 'document', source: { type: 'url', url: 'https://x/y.pdf' } },
        ]),
      /unsupported block alongside tool images/,
    );
  });

  it('leaves a block list without an image block untouched', () => {
    // Matches tool_images.go: the type guard runs only when an image is
    // present, so an unknown block on its own is forwarded rather than raised.
    // `undefined` here means "not image-bearing", i.e. keep the original value.
    assert.equal(
      decodeToolImages('responses', [{ type: 'input_file', file_id: 'f_1' }]),
      undefined,
    );
    assert.equal(
      decodeToolImages('anthropic', [
        { type: 'document', source: { type: 'url', url: 'https://x/y.pdf' } },
      ]),
      undefined,
    );
  });

  it('throws on an invalid data: URI', () => {
    assert.throws(
      () =>
        decodeToolImages('responses', [{ type: 'input_image', image_url: 'data:text/plain,x' }]),
      /invalid image data URI/,
    );
    assert.throws(
      () => decodeToolImages('responses', [{ type: 'input_image', image_url: 'data:image/png;' }]),
      /invalid image data URI/,
    );
  });

  it('leaves a non-data image URL untouched', () => {
    // tool_images.go only parses data: URIs; every other URL is forwarded
    // as-is and left for the upstream to reject.
    assert.deepEqual(
      decodeToolImages('responses', [{ type: 'input_image', image_url: 'not-a-uri' }]),
      [{ type: 'image_url', image_url: { url: 'not-a-uri' } }],
    );
  });
});

describe('chatToolImages', () => {
  it('returns the plain text and no images for a non-array value', () => {
    assert.deepEqual(chatToolImages('result', 'call_1'), {
      text: 'result',
      images: [],
    });
  });

  it('returns empty text and no images for an empty contentParts array', () => {
    assert.deepEqual(chatToolImages([], 'call_1'), { text: '', images: [] });
  });

  it('returns concatenated text with no images when only text parts exist', () => {
    assert.deepEqual(
      chatToolImages(
        [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        'call_1',
      ),
      { text: 'ab', images: [] },
    );
  });

  it('pairs each image with a marker text block and indexes from 1', () => {
    const url = 'https://example.com/pic.png';
    const result = chatToolImages(
      [
        { type: 'text', text: 'found' },
        { type: 'image_url', image_url: { url } },
        { type: 'text', text: 'again' },
        { type: 'image_url', image_url: { url } },
      ],
      'call_42',
    );
    assert.equal(
      result.text,
      'found\n[tool_image call_id="call_42" index=1]\nagain\n[tool_image call_id="call_42" index=2]\n',
    );
    assert.deepEqual(result.images, [
      { type: 'text', text: '[tool_image call_id="call_42" index=1]' },
      { type: 'image_url', image_url: { url } },
      { type: 'text', text: '[tool_image call_id="call_42" index=2]' },
      { type: 'image_url', image_url: { url } },
    ]);
  });
});

describe('responsesToolContent', () => {
  it('returns a non-array value unchanged', () => {
    // Matches responsesToolContent: a value that is not the decoded block list
    // is emitted as-is, so a plain-text tool result stays a plain string
    // instead of being wrapped in a single input_text block.
    assert.equal(responsesToolContent('sunny'), 'sunny');
    assert.equal(responsesToolContent(undefined), undefined);
  });

  it('reconstructs a data: URI from mediaType + data when image_url is empty', () => {
    const content = responsesToolContent([
      { type: 'text', text: 'look' },
      {
        type: 'image_url',
        image_url: { url: '' },
        mediaType: 'image/png',
        data: 'AAAA',
      },
    ]);
    assert.deepEqual(content, [
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('passes an http URL through untouched', () => {
    const content = responsesToolContent([
      { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
    ]);
    assert.deepEqual(content, [{ type: 'input_image', image_url: 'https://example.com/x.png' }]);
  });
});

describe('protocol integration: tool results with images', () => {
  function base64Image(url = '', mediaType = 'image/png', data = 'AAAA') {
    return {
      type: 'image_url' as const,
      image_url: { url },
      ...(mediaType ? { mediaType } : {}),
      ...(data ? { data } : {}),
    };
  }

  it('Chat target keeps a tool result as plain text (never decoded)', () => {
    // The chat wire format has no tool_result-with-images shape, so image-bearing
    // results stay untouched: only message.content (the plain text) is emitted.
    const body = toChatBody({
      model: 'm',
      messages: [
        {
          role: 'tool',
          content: 'hello',
          tool_call_id: 'call_1',
        },
      ],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.content, 'hello');
  });

  it('Anthropic tool_result with a base64 image becomes an input_image data URI in Responses', () => {
    const toolCall = {
      id: 'call_1',
      function: { name: 'f', arguments: '{}' },
    };
    const body = toResponsesBody({
      model: 'm',
      messages: [
        { role: 'assistant', content: '', tool_calls: [toolCall] },
        {
          role: 'tool',
          content: 'found',
          tool_call_id: 'call_1',
          contentParts: [{ type: 'text', text: 'found' }, base64Image('', 'image/png', 'AAAA')],
        },
      ],
    });
    const input = body.input as Array<Record<string, unknown>>;
    const out = input.find((i) => i.type === 'function_call_output');
    assert.equal(out?.call_id, 'call_1');
    assert.deepEqual(out?.output, [
      { type: 'input_text', text: 'found' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('tool_result with a URL image preserves the URL in Responses', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [
        {
          role: 'tool',
          content: 'pic',
          tool_call_id: 'call_1',
          contentParts: [
            { type: 'text', text: 'pic' },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
      ],
    });
    const input = body.input as Array<Record<string, unknown>>;
    const out = input.find((i) => i.type === 'function_call_output');
    assert.deepEqual(out?.output, [
      { type: 'input_text', text: 'pic' },
      { type: 'input_image', image_url: 'https://x/y.png' },
    ]);
  });

  it('a pure-text tool_result passes through Responses output unchanged', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{ role: 'tool', content: 'sunny', tool_call_id: 'call_1' }],
    });
    const input = body.input as Array<Record<string, unknown>>;
    assert.equal(input[0]?.output, 'sunny');
  });

  it('Chat target moves tool_result images to an extra user message after the tool message', () => {
    const body = toChatBody({
      model: 'm',
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'f' } }] },
        {
          role: 'tool',
          content: 'found',
          tool_call_id: 'call_1',
          contentParts: [
            { type: 'text', text: 'found' },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
      ],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 3);
    assert.equal(messages[1]?.role, 'tool');
    assert.equal(messages[1]?.tool_call_id, 'call_1');
    assert.equal(messages[1]?.content, 'found\n[tool_image call_id="call_1" index=1]\n');
    assert.equal(messages[2]?.role, 'user');
    assert.deepEqual(messages[2]?.content, [
      { type: 'text', text: '[tool_image call_id="call_1" index=1]' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
    ]);
  });

  it('Anthropic tool_result uses the recursive block encoder for contentParts', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [
        {
          role: 'tool',
          content: 'found',
          tool_call_id: 'toolu_1',
          contentParts: [
            { type: 'text', text: 'found' },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
      ],
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const resultBlock = messages[0]?.content?.[0];
    assert.equal(resultBlock?.type, 'tool_result');
    assert.equal(resultBlock?.tool_use_id, 'toolu_1');
    assert.deepEqual(resultBlock?.content, [
      { type: 'text', text: 'found' },
      { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
    ]);
  });

  it('Anthropic tool_result maps a base64 image back to a base64 source block', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [
        {
          role: 'tool',
          content: 'shot',
          tool_call_id: 'toolu_2',
          contentParts: [{ type: 'text', text: 'shot' }, base64Image('', 'image/jpeg', 'BBBB')],
        },
      ],
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const resultBlock = messages[0]?.content?.[0];
    assert.deepEqual(resultBlock?.content, [
      { type: 'text', text: 'shot' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' },
      },
    ]);
  });

  it('prepareRequest throws when an image tool result lacks a call_id', () => {
    assert.throws(
      () =>
        prepareRequest(
          {
            model: 'm',
            messages: [
              {
                role: 'tool',
                content: '',
                contentParts: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
              },
            ],
          },
          'responses',
        ),
      /tool image result requires a call ID/,
    );
  });
});
