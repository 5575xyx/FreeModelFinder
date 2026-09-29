import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isZenProtocol } from '../protocol/types.js';
import { toChatBody } from '../protocol/chat.js';
import { toAnthropicBody, DEFAULT_ANTHROPIC_MAX_TOKENS } from '../protocol/anthropic.js';

describe('zen protocol types', () => {
  it('accepts the three native protocols', () => {
    assert.equal(isZenProtocol('chat'), true);
    assert.equal(isZenProtocol('responses'), true);
    assert.equal(isZenProtocol('anthropic'), true);
  });

  it('rejects anything else', () => {
    assert.equal(isZenProtocol('systemone'), false);
    assert.equal(isZenProtocol(''), false);
  });
});

describe('zen chat body encoding', () => {
  it('encodes messages, tools, tool_calls and tool results', () => {
    const body = toChatBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'result', tool_call_id: 'call_1' },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      temperature: 0.3,
      max_tokens: 64,
      stream: true,
    });
    assert.equal(body.model, 'm');
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 64);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.role, 'system');
    assert.deepEqual(messages[2]?.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
    ]);
    assert.equal((messages[3] as Record<string, unknown>).tool_call_id, 'call_1');
    assert.deepEqual(body.tools, [
      { type: 'function', function: { name: 'f', parameters: { type: 'object' } } },
    ]);
  });

  it('encodes image content parts as a content array', () => {
    const body = toChatBody({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: 'see',
          contentParts: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0]?.content, [
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('omits tools/stream/optional numeric fields when absent', () => {
    const body = toChatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal('tools' in body, false);
    assert.equal('temperature' in body, false);
    assert.equal('max_tokens' in body, false);
  });
});

describe('zen chat body encoding parity', () => {
  it('carries assistant reasoning as reasoning_content', () => {
    const body = toChatBody({
      model: 'm',
      messages: [{ role: 'assistant', content: 'hi', reasoning: 'thinking' }],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.reasoning_content, 'thinking');
  });

  it('requests usage on streamed bodies via stream_options', () => {
    const streamed = toChatBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.deepEqual(streamed['stream_options'], { include_usage: true });
    const plain = toChatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal('stream_options' in plain, false);
  });
});

describe('zen anthropic body encoding', () => {
  it('splits system out and maps tool calls/results to blocks', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'checking',
          tool_calls: [
            { id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } },
          ],
        },
        { role: 'tool', content: 'sunny', tool_call_id: 'toolu_1' },
      ],
      max_tokens: 64,
      tools: [
        {
          type: 'function',
          function: { name: 'f', description: 'd', parameters: { type: 'object' } },
        },
      ],
    });
    assert.equal(body.model, 'm');
    assert.equal(body.max_tokens, 64);
    assert.deepEqual(body.system, [{ type: 'text', text: 'sys' }]);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(messages[0]?.role, 'user');
    const blocks = messages[1]?.content as Array<Record<string, unknown>>;
    assert.deepEqual(blocks?.[0], { type: 'text', text: 'checking' });
    assert.deepEqual(blocks?.[1], { type: 'tool_use', id: 'toolu_1', name: 'f', input: { q: 1 } });
    const resultBlocks = messages[2]?.content as Array<Record<string, unknown>>;
    assert.deepEqual(resultBlocks?.[0], {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'sunny',
    });
    assert.deepEqual(body.tools, [
      { name: 'f', description: 'd', input_schema: { type: 'object' } },
    ]);
  });

  it('maps images to base64/url source blocks', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: 'see',
          contentParts: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
      max_tokens: 16,
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]?.content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('defaults max_tokens when the request omits it', () => {
    const body = toAnthropicBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(body.max_tokens, DEFAULT_ANTHROPIC_MAX_TOKENS);
  });
});

describe('zen anthropic body encoding boundaries', () => {
  it('merges multiple system messages and drops an absent system field', () => {
    const merged = toAnthropicBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b' },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.deepEqual(merged.system, [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    assert.equal(
      'system' in toAnthropicBody({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      false,
    );
  });

  it('maps a non-base64 image URL to a url source block', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: '',
          contentParts: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
        },
      ],
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]?.content[0], {
      type: 'image',
      source: { type: 'url', url: 'https://x/y.png' },
    });
  });

  it('keeps a tool-only assistant message non-empty and default id/input', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'f' } }] }],
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]?.content, [
      { type: 'tool_use', id: 'call_0', name: 'f', input: {} },
    ]);
  });

  it('pads a contentless message so content is never empty', () => {
    const body = toAnthropicBody({ model: 'm', messages: [{ role: 'user', content: '' }] });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]?.content, [{ type: 'text', text: '' }]);
  });

  it('falls back to an empty object schema when a tool omits parameters', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
    });
    assert.deepEqual(body.tools, [{ name: 'f', input_schema: { type: 'object', properties: {} } }]);
  });

  it('merges consecutive same-role turns and passes sampling knobs through', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'sunny', tool_call_id: 'toolu_1' },
      ],
      temperature: 0.2,
      top_p: 0.9,
      stop: ['END'],
      stream: true,
    });
    const messages = body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, 'user');
    assert.deepEqual(messages[0]?.content[1], {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'sunny',
    });
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.stop_sequences, ['END']);
    assert.equal(body.stream, true);
  });
});
