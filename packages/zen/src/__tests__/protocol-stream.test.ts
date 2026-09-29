import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SseParser,
  parseChatChunk,
  parseAnthropicChunk,
  parseResponsesChunk,
} from '../protocol/stream.js';

describe('zen sse parser', () => {
  it('splits events across chunk boundaries', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push('data: {"a":'), []);
    const events = parser.push('1}\n\ndata: [DONE]\n\n');
    assert.deepEqual(events, [{ data: '{"a":1}' }, { data: '[DONE]' }]);
  });

  it('ignores non-data lines and comment-only events', () => {
    const parser = new SseParser();
    const events = parser.push(': comment\n\nevent: x\ndata: {"a":1}\n\n');
    assert.deepEqual(events, [{ event: 'x', data: '{"a":1}' }]);
  });
});

describe('zen stream chunk parsing', () => {
  it('parses a chat content delta', () => {
    const chunk = parseChatChunk({
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [{ delta: { content: 'hi', reasoning: 'r' }, finish_reason: null }],
    });
    assert.equal(chunk.delta, 'hi');
    assert.equal(chunk.reasoning, 'r');
  });

  it('parses chat tool_call deltas with cumulative index', () => {
    const chunk = parseChatChunk({
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"q"' } }],
          },
          finish_reason: null,
        },
      ],
    });
    assert.equal(chunk.tool_calls?.[0]?.index, 0);
    assert.equal(chunk.tool_calls?.[0]?.function?.name, 'f');
  });

  it('parses an anthropic text content_block_delta', () => {
    const chunk = parseAnthropicChunk({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    });
    assert.equal(chunk.delta, 'hi');
  });

  it('parses a responses output_text delta', () => {
    const chunk = parseResponsesChunk({ type: 'response.output_text.delta', delta: 'hi' });
    assert.equal(chunk.delta, 'hi');
  });
});
