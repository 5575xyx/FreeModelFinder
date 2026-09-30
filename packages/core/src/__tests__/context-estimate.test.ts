import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateInputTokens } from '../context-estimate.js';

describe('estimateInputTokens', () => {
  it('counts message content at three characters per token', () => {
    const n = estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(300) }] });
    assert.equal(n, 100);
  });

  it('includes tool definitions', () => {
    const b = estimateInputTokens({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { a: 1 } } }],
    });
    assert.equal(b, 23);
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

  it('rounds up and handles empty messages', () => {
    assert.equal(estimateInputTokens({ messages: [{ role: 'user', content: 'x' }] }), 1);
    assert.equal(estimateInputTokens({ messages: [] }), 0);
  });

  it('ignores image parts', () => {
    const n = estimateInputTokens({
      messages: [
        {
          role: 'user',
          content: '',
          contentParts: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    });
    assert.equal(n, 0);
  });
});
