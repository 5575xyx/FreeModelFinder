import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openAIToChatRequest, type OpenAIChatCompletionRequest } from '../protocols/openai.js';
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

describe('openai inbound tools', () => {
  it('keeps tools and captures the raw body', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      seed: 7,
    } as unknown as OpenAIChatCompletionRequest;
    const out = openAIToChatRequest(body);
    assert.equal(out.tools?.[0]?.function.name, 'search');
    assert.deepEqual(out.raw, body);
    assert.equal(out.rawProtocol, 'openai');
  });

  it('captures raw and rawProtocol even without tools', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      seed: 3,
    } as unknown as OpenAIChatCompletionRequest;
    const out = openAIToChatRequest(body);
    assert.equal(out.tools, undefined);
    assert.deepEqual(out.raw, body);
    assert.equal(out.rawProtocol, 'openai');
  });

  it('keeps assistant tool_calls on the message', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_1');
  });
});
