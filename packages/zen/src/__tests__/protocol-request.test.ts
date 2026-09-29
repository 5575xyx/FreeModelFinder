import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isZenProtocol } from '../protocol/types.js';
import { toChatBody } from '../protocol/chat.js';

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
