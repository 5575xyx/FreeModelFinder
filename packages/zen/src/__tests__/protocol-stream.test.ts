import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SseParser,
  parseChatChunk,
  parseAnthropicChunk,
  parseResponsesChunk,
  collapseChunks,
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

describe('zen collapse', () => {
  it('aggregates content, tool calls, reasoning and usage', () => {
    const res = collapseChunks([
      { id: 'gen_1', model: 'm', created: 1, delta: 'He', reasoning: 'r1' },
      { id: 'gen_1', model: 'm', created: 1, delta: 'llo' },
      {
        id: 'gen_1',
        model: 'm',
        created: 1,
        delta: '',
        finish_reason: 'tool_calls',
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"q":1}' } }],
      },
      { id: 'gen_1', model: 'm', created: 1, delta: '', usage: { total_tokens: 7 } },
    ]);
    assert.equal(res.id, 'gen_1');
    assert.equal(res.content, 'Hello');
    assert.equal(res.reasoning, 'r1');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.function.arguments, '{"q":1}');
    assert.equal(res.usage?.total_tokens, 7);
  });

  it('concatenates streamed tool-call argument fragments by index', () => {
    const res = collapseChunks([
      {
        id: 'x',
        model: 'm',
        created: 1,
        delta: '',
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"q"' } }],
      },
      {
        id: 'x',
        model: 'm',
        created: 1,
        delta: '',
        tool_calls: [{ index: 0, function: { arguments: ':1}' } }],
      },
      { id: 'x', model: 'm', created: 1, delta: '', finish_reason: 'tool_calls' },
    ]);
    assert.equal(res.tool_calls?.[0]?.function.arguments, '{"q":1}');
  });

  it('merges usage field-wise so a later frame does not wipe earlier fields', () => {
    const res = collapseChunks([
      { id: 'x', model: 'm', created: 1, delta: '', usage: { prompt_tokens: 10 } },
      { id: 'x', model: 'm', created: 1, delta: '', usage: { completion_tokens: 50 } },
    ]);
    assert.equal(res.usage?.prompt_tokens, 10);
    assert.equal(res.usage?.completion_tokens, 50);
    assert.equal(res.usage?.total_tokens, 60);
  });
});

describe('zen stream error events', () => {
  it('throws on a chat error event', () => {
    assert.throws(() => parseChatChunk({ error: { message: 'boom' } }), /boom/);
  });

  it('throws on an anthropic error event', () => {
    assert.throws(() => parseAnthropicChunk({ type: 'error', error: { message: 'boom' } }), /boom/);
  });

  it('throws on a responses error event', () => {
    assert.throws(() => parseResponsesChunk({ type: 'error', error: { message: 'boom' } }), /boom/);
  });
});

describe('zen responses stream tool correlation', () => {
  it('correlates id/name and concatenates arguments across a folded stream', () => {
    const chunks = [
      parseResponsesChunk({
        type: 'response.created',
        response: { id: 'resp_1', model: 'm', created_at: 1 },
      }),
      parseResponsesChunk({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'f' },
      }),
      parseResponsesChunk({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"q"',
      }),
      parseResponsesChunk({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: ':1}',
      }),
      parseResponsesChunk({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'm',
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"q":1}' }],
        },
      }),
    ];
    const res = collapseChunks(chunks);
    assert.equal(res.id, 'resp_1');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.id, 'call_1');
    assert.equal(res.tool_calls?.[0]?.function.name, 'f');
    assert.equal(res.tool_calls?.[0]?.function.arguments, '{"q":1}');
  });

  it('reads reasoning summary deltas as reasoning', () => {
    const chunk = parseResponsesChunk({
      type: 'response.reasoning_summary_text.delta',
      delta: 'why',
    });
    assert.equal(chunk.reasoning, 'why');
  });
});
