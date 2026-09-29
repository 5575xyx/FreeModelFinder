import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertResponse, parseAnthropicResponse, parseChatResponse } from '../protocol/response.js';

describe('zen chat response parsing', () => {
  it('parses content, tool_calls, reasoning and usage', () => {
    const res = parseChatResponse({
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hi',
            reasoning_content: 'because',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    assert.equal(res.id, 'gen_1');
    assert.equal(res.content, 'hi');
    assert.equal(res.reasoning, 'because');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.id, 'call_1');
    assert.equal(res.usage?.total_tokens, 7);
  });

  it('falls back to reasoning when content is empty', () => {
    const res = parseChatResponse({
      id: 'x',
      model: 'm',
      created: 1,
      choices: [
        { message: { role: 'assistant', content: '', reasoning: 'think' }, finish_reason: 'stop' },
      ],
    });
    assert.equal(res.content, 'think');
    assert.equal(res.reasoning, 'think');
  });

  it('joins array content parts', () => {
    const res = parseChatResponse({
      id: 'x',
      model: 'm',
      created: 1,
      choices: [
        {
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'text', text: '!' },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    });
    assert.equal(res.content, 'hi!');
  });

  it('maps legacy function_call finish reason to tool_calls', () => {
    const res = parseChatResponse({
      id: 'x',
      model: 'm',
      created: 1,
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'function_call' }],
    });
    assert.equal(res.finish_reason, 'tool_calls');
  });

  it('throws when choices are empty, surfacing the upstream error message', () => {
    assert.throws(() => parseChatResponse({ id: 'x', error: { message: 'boom' } }), /boom/);
  });
});

describe('zen anthropic response parsing', () => {
  it('joins text blocks and maps tool_use to tool_calls', () => {
    const res = parseAnthropicResponse({
      id: 'msg_1',
      model: 'm',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_1', name: 'f', input: { q: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    assert.equal(res.content, 'hi');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.id, 'toolu_1');
    assert.equal(res.tool_calls?.[0]?.function.arguments, '{"q":1}');
    assert.equal(res.usage?.prompt_tokens, 3);
    assert.equal(res.usage?.completion_tokens, 4);
  });

  it('surfaces a thinking block as reasoning', () => {
    const res = parseAnthropicResponse({
      id: 'msg_1',
      model: 'm',
      content: [
        { type: 'thinking', thinking: 'step' },
        { type: 'text', text: 'answer' },
      ],
      stop_reason: 'end_turn',
    });
    assert.equal(res.reasoning, 'step');
    assert.equal(res.content, 'answer');
  });

  it('maps stop_reason end_turn to stop and max_tokens to length', () => {
    assert.equal(
      parseAnthropicResponse({
        id: 'x',
        content: [{ type: 'text', text: 'a' }],
        stop_reason: 'end_turn',
      }).finish_reason,
      'stop',
    );
    assert.equal(
      parseAnthropicResponse({
        id: 'x',
        content: [{ type: 'text', text: 'a' }],
        stop_reason: 'max_tokens',
      }).finish_reason,
      'length',
    );
  });
});

describe('zen convertResponse raw passthrough', () => {
  it('attaches raw when client protocol matches the chat upstream', () => {
    const body = {
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      vendor_flag: true,
    };
    const res = convertResponse(body, 'chat', 'openai');
    assert.equal(res.raw, body);
    assert.equal(res.rawProtocol, 'openai');
  });

  it('omits raw for a cross-protocol client', () => {
    const body = {
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    };
    const res = convertResponse(body, 'chat', 'gemini');
    assert.equal(res.raw, undefined);
  });

  it('attaches raw for an anthropic client on an anthropic upstream', () => {
    const body = {
      id: 'msg_1',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      vendor: 1,
    };
    const res = convertResponse(body, 'anthropic', 'anthropic');
    assert.equal(res.raw, body);
    assert.equal(res.rawProtocol, 'anthropic');
  });

  it('throws for an upstream protocol not yet implemented', () => {
    assert.throws(() => convertResponse({}, 'responses', 'openai'));
  });
});
