import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateInputTokens } from '../context-estimate.js';

describe('estimateInputTokens', () => {
  it('counts message content at three characters per token', () => {
    const n = estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(300) }] });
    assert.equal(n, 100);
  });

  it('includes tool definitions', () => {
    const a = estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] });
    const b = estimateInputTokens({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { a: 1 } } }],
    });
    assert.ok(b > a);
  });

  it('includes contentParts text and tool_calls payloads', () => {
    const withParts = estimateInputTokens({
      messages: [
        {
          role: 'user',
          content: '',
          contentParts: [{ type: 'text', text: 'y'.repeat(300) }],
        },
      ],
    });
    assert.equal(withParts, 100);

    const withCalls = estimateInputTokens({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c0', type: 'function', function: { name: 'f', arguments: 'z'.repeat(600) } },
          ],
        },
      ],
    });
    assert.equal(withCalls, 200);
  });

  it('rounds up and never returns a negative', () => {
    assert.equal(estimateInputTokens({ messages: [{ role: 'user', content: 'x' }] }), 1);
    assert.equal(estimateInputTokens({ messages: [] }), 0);
  });
});
