import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertResponse, parseChatResponse } from '../protocol/response.js';

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

  it('throws for an upstream protocol not yet implemented', () => {
    assert.throws(() => convertResponse({}, 'anthropic', 'openai'));
  });
});
