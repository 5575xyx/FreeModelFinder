import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapFinishReason,
  parseOpenAIDelta,
  parseOpenAIMessage,
  parseToolCallDeltas,
  parseToolCalls,
  parseUsage,
} from '../openai-like.js';

describe('parseToolCalls', () => {
  it('returns undefined for non-arrays and empty arrays', () => {
    assert.equal(parseToolCalls(undefined), undefined);
    assert.equal(parseToolCalls(null), undefined);
    assert.equal(parseToolCalls({}), undefined);
    assert.equal(parseToolCalls([]), undefined);
  });

  it('parses a call carrying an id, name and arguments', () => {
    const calls = parseToolCalls([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"a":1}' } },
    ]);
    assert.deepEqual(calls, [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"a":1}' } },
    ]);
  });

  it('omits the id when missing or empty while keeping the call', () => {
    const calls = parseToolCalls([
      { type: 'function', function: { name: 'a' } },
      { id: '', type: 'function', function: { name: 'b' } },
      { id: 42, function: { name: 'c' } },
    ]);
    assert.deepEqual(calls, [
      { type: 'function', function: { name: 'a' } },
      { type: 'function', function: { name: 'b' } },
      { type: 'function', function: { name: 'c' } },
    ]);
  });

  it('defaults a missing name to an empty string and drops non-string arguments', () => {
    const calls = parseToolCalls([{ function: { arguments: 123 } }, {}, { name: 'x' }]);
    assert.deepEqual(calls, [
      { type: 'function', function: { name: '' } },
      { type: 'function', function: { name: '' } },
      { type: 'function', function: { name: '' } },
    ]);
  });

  it('skips non-object entries and returns undefined when none remain', () => {
    assert.equal(parseToolCalls(['x', 1, null]), undefined);
    const calls = parseToolCalls(['x', { function: { name: 'kept' } }, null]);
    assert.equal(calls?.length, 1);
  });
});

describe('parseToolCallDeltas', () => {
  it('returns undefined for non-arrays and empty arrays', () => {
    assert.equal(parseToolCallDeltas(undefined), undefined);
    assert.equal(parseToolCallDeltas({}), undefined);
    assert.equal(parseToolCallDeltas([]), undefined);
  });

  it('defaults a missing index to 0', () => {
    const deltas = parseToolCallDeltas([{ function: { name: 'a' } }]);
    assert.deepEqual(deltas, [{ index: 0, type: 'function', function: { name: 'a' } }]);
  });

  it('coerces negative, fractional and non-numeric indexes to 0', () => {
    const deltas = parseToolCallDeltas([
      { index: -1 },
      { index: 1.5 },
      { index: '2' },
      { index: Number.NaN },
      { index: Number.POSITIVE_INFINITY },
    ]);
    assert.deepEqual(deltas, [
      { index: 0, type: 'function' },
      { index: 0, type: 'function' },
      { index: 0, type: 'function' },
      { index: 0, type: 'function' },
      { index: 0, type: 'function' },
    ]);
  });

  it('keeps incrementing indexes, first-block name and fragmented arguments', () => {
    const deltas = parseToolCallDeltas([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"ci' },
      },
      { index: 0, function: { arguments: 'ty":' } },
      { index: 0, function: { arguments: '"x"}' } },
      { index: 1, id: 'call_2', function: { name: 'now' } },
    ]);
    assert.deepEqual(deltas, [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"ci' },
      },
      { index: 0, type: 'function', function: { arguments: 'ty":' } },
      { index: 0, type: 'function', function: { arguments: '"x"}' } },
      { index: 1, id: 'call_2', type: 'function', function: { name: 'now' } },
    ]);
  });

  it('omits the function object when neither name nor arguments is a string', () => {
    const deltas = parseToolCallDeltas([{ index: 2, id: 'call_2' }]);
    assert.deepEqual(deltas, [{ index: 2, id: 'call_2', type: 'function' }]);
  });

  it('omits the function object when function is not an object', () => {
    const deltas = parseToolCallDeltas([
      { index: 0, function: 'x' },
      { index: 1, function: [] },
      { index: 2, function: 3 },
    ]);
    assert.deepEqual(deltas, [
      { index: 0, type: 'function' },
      { index: 1, type: 'function' },
      { index: 2, type: 'function' },
    ]);
  });

  it('keeps an explicit empty function.name', () => {
    const deltas = parseToolCallDeltas([{ index: 0, function: { name: '' } }]);
    assert.deepEqual(deltas, [{ index: 0, type: 'function', function: { name: '' } }]);
  });

  it('skips non-object entries and returns undefined when none remain', () => {
    assert.equal(parseToolCallDeltas(['x', 1, null]), undefined);
    const deltas = parseToolCallDeltas(['x', { index: 1 }]);
    assert.deepEqual(deltas, [{ index: 1, type: 'function' }]);
  });
});

describe('parseOpenAIMessage', () => {
  it('decodes a string content', () => {
    assert.deepEqual(parseOpenAIMessage({ content: 'hello' }), { content: 'hello' });
  });

  it('coalesces null or missing content to an empty string', () => {
    assert.deepEqual(parseOpenAIMessage({ content: null }), { content: '' });
    assert.deepEqual(parseOpenAIMessage({}), { content: '' });
    assert.deepEqual(parseOpenAIMessage(undefined), { content: '' });
  });

  it('joins only the text parts of an array content', () => {
    const message = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'http://x/y.png' } },
        { type: 'text', text: 'b' },
      ],
    };
    assert.deepEqual(parseOpenAIMessage(message), { content: 'ab' });
  });

  it('prefers reasoning_content over reasoning and drops empty reasoning', () => {
    assert.deepEqual(
      parseOpenAIMessage({ content: 'x', reasoning_content: 'r1', reasoning: 'r2' }),
      {
        content: 'x',
        reasoning: 'r1',
      },
    );
    assert.deepEqual(parseOpenAIMessage({ content: 'x', reasoning: 'r2' }), {
      content: 'x',
      reasoning: 'r2',
    });
    assert.deepEqual(parseOpenAIMessage({ content: 'x', reasoning: '' }), { content: 'x' });
  });

  it('keeps tool_calls when content is null', () => {
    const result = parseOpenAIMessage({
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    });
    assert.equal(result.content, '');
    assert.deepEqual(result.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
    ]);
  });

  it('omits tool_calls entirely when absent or invalid', () => {
    const result = parseOpenAIMessage({ content: 'x', tool_calls: [] });
    assert.equal('tool_calls' in result, false);
    assert.equal(result.tool_calls, undefined);
  });
});

describe('parseOpenAIDelta', () => {
  it('returns an empty object for a non-object delta', () => {
    assert.deepEqual(parseOpenAIDelta(undefined), {});
    assert.deepEqual(parseOpenAIDelta('x'), {});
  });

  it('includes content and reasoning only when non-empty', () => {
    assert.deepEqual(parseOpenAIDelta({ content: '', reasoning_content: '' }), {});
    assert.deepEqual(parseOpenAIDelta({ content: 'hi', reasoning_content: 'think' }), {
      content: 'hi',
      reasoning: 'think',
    });
    assert.deepEqual(parseOpenAIDelta({ reasoning: 'r' }), { reasoning: 'r' });
  });

  it('parses tool_call deltas alongside content in the same block', () => {
    const result = parseOpenAIDelta({
      content: 'ok',
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{}' } }],
    });
    assert.equal(result.content, 'ok');
    assert.deepEqual(result.tool_calls, [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
    ]);
  });

  it('omits the tool_calls field when absent or invalid', () => {
    assert.equal('tool_calls' in parseOpenAIDelta({ content: 'x' }), false);
    assert.equal('tool_calls' in parseOpenAIDelta({ tool_calls: [] }), false);
  });
});

describe('mapFinishReason', () => {
  it('maps function_call to tool_calls', () => {
    assert.equal(mapFinishReason('function_call'), 'tool_calls');
  });

  it('passes known reasons through unchanged', () => {
    assert.equal(mapFinishReason('stop'), 'stop');
    assert.equal(mapFinishReason('length'), 'length');
    assert.equal(mapFinishReason('tool_calls'), 'tool_calls');
    assert.equal(mapFinishReason('content_filter'), 'content_filter');
  });

  it('maps unknown and non-string values to null', () => {
    assert.equal(mapFinishReason('eos'), null);
    assert.equal(mapFinishReason(undefined), null);
    assert.equal(mapFinishReason(null), null);
    assert.equal(mapFinishReason(42), null);
  });
});

describe('parseUsage', () => {
  it('returns undefined for non-records and empty records', () => {
    assert.equal(parseUsage(undefined), undefined);
    assert.equal(parseUsage('x'), undefined);
    assert.equal(parseUsage({}), undefined);
  });

  it('parses token counts', () => {
    assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it('carries prompt_tokens_details.cached_tokens', () => {
    assert.deepEqual(
      parseUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    );
  });

  it('drops non-numeric fields', () => {
    assert.deepEqual(parseUsage({ prompt_tokens: '10', completion_tokens: 2 }), {
      completion_tokens: 2,
    });
  });

  it('drops NaN and infinite numeric fields', () => {
    assert.deepEqual(
      parseUsage({
        prompt_tokens: Number.NaN,
        completion_tokens: Number.POSITIVE_INFINITY,
        total_tokens: 15,
      }),
      { total_tokens: 15 },
    );
    assert.equal(
      parseUsage({
        prompt_tokens: Number.NaN,
        prompt_tokens_details: { cached_tokens: Number.NaN },
      }),
      undefined,
    );
  });
});
