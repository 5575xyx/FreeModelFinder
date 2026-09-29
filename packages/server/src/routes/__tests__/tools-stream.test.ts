import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatRequest, StreamChunk } from '@freemodelfinder/core';

interface FakeProvider {
  id: string;
  chat(req: ChatRequest): Promise<never>;
  stream(req: ChatRequest): AsyncIterable<StreamChunk>;
}

function makeRegistry(provider: FakeProvider) {
  return {
    resolveModel: () => ({ provider, modelId: 'm' }),
    getAutoRouter: () => ({
      isEnabled: () => false,
      preflight: async () => ({ switched: false }),
      maybeSwitchBack: async () => null,
      markRateLimited: () => undefined,
      rememberPreference: () => undefined,
      notify: () => undefined,
    }),
  };
}

describe('anthropic sse tool blocks', () => {
  it('opens and closes a tool_use content block', async () => {
    const { registerAnthropicRoutes } = await import('../../routes/anthropic.js');
    const written: string[] = [];
    const provider: FakeProvider = {
      id: 'fake',
      chat: async () => {
        throw new Error('unused');
      },
      stream: async function* () {
        yield { id: 'x', model: 'm', created: 1, delta: 'thinking' };
        yield {
          id: 'x',
          model: 'm',
          created: 1,
          delta: '',
          finish_reason: 'tool_calls',
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{}' } }],
        };
      },
    };
    const handlers = new Map<string, (req: unknown, reply: unknown) => Promise<void>>();
    const app = {
      post: (path: string, handler: (req: unknown, reply: unknown) => Promise<void>) => {
        handlers.set(path, handler);
      },
    };
    registerAnthropicRoutes(app as never, () => makeRegistry(provider) as never);
    const handler = handlers.get('/v1/messages')!;

    const reply = {
      raw: {
        writeHead: () => undefined,
        write: (s: string) => {
          written.push(s);
        },
        end: () => undefined,
      },
    };

    await handler(
      {
        body: {
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 16,
          stream: true,
        },
      },
      reply,
    );

    const out = written.join('');
    assert.ok(out.includes('"type":"content_block_start"'));
    assert.ok(out.includes('"type":"tool_use"'));
    assert.ok(out.includes('"type":"input_json_delta"'));
    assert.ok(out.includes('"stop_reason":"tool_use"'));
    assert.ok(out.includes('event: message_stop'));
  });
});
