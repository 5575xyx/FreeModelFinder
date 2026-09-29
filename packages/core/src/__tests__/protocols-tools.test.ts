import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatRequestSchema } from '../types.js';

describe('tools typing', () => {
  it('parses a request carrying tools and raw', () => {
    const parsed = ChatRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } },
        },
      ],
      raw: { some: 'upstream-specific-field' },
    });
    assert.equal(parsed.tools?.[0]?.function.name, 'get_weather');
    assert.deepEqual(parsed.raw, { some: 'upstream-specific-field' });
  });

  it('keeps request parseable when tools and raw are absent', () => {
    const parsed = ChatRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(parsed.tools, undefined);
    assert.equal(parsed.raw, undefined);
  });
});
