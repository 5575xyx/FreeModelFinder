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

async function collect(chunks: StreamChunk[]): Promise<string> {
  const { registerAnthropicRoutes } = await import('../../routes/anthropic.js');
  const written: string[] = [];
  const provider: FakeProvider = {
    id: 'fake',
    chat: async () => {
      throw new Error('unused');
    },
    stream: async function* () {
      for (const chunk of chunks) yield chunk;
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

  return written.join('');
}

describe('anthropic sse tool blocks', () => {
  it('opens and closes a tool_use content block', async () => {
    const out = await collect([
      { id: 'x', model: 'm', created: 1, delta: 'thinking' },
      {
        id: 'x',
        model: 'm',
        created: 1,
        delta: '',
        finish_reason: 'tool_calls',
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{}' } }],
      },
    ]);

    assert.ok(out.includes('"type":"content_block_start"'));
    assert.ok(out.includes('"type":"tool_use"'));
    assert.ok(out.includes('"type":"input_json_delta"'));
    assert.ok(out.includes('"stop_reason":"tool_use"'));
    assert.ok(out.includes('event: message_stop'));
  });

  it('opens a separate block for each tool call index', async () => {
    const out = await collect([
      {
        id: 'x',
        model: 'm',
        created: 1,
        delta: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { index: 0, id: 'a', function: { name: 'f', arguments: '{}' } },
          { index: 1, id: 'b', function: { name: 'g', arguments: '{}' } },
        ],
      },
    ]);
    assert.equal((out.match(/"type":"tool_use"/g) ?? []).length, 2);
    assert.ok(out.includes('"id":"a"'));
    assert.ok(out.includes('"id":"b"'));
  });

  it('does not open an empty text block for a tool-only response', async () => {
    const out = await collect([
      {
        id: 'x',
        model: 'm',
        created: 1,
        delta: '',
        finish_reason: 'tool_calls',
        tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{}' } }],
      },
    ]);
    assert.equal(out.includes('"type":"text"'), false);
    const firstStart = out.indexOf('"type":"content_block_start"');
    assert.ok(out.slice(firstStart, firstStart + 200).includes('"tool_use"'));
  });

  it('alternates text and tool blocks in order', async () => {
    const out = await collect([
      { id: 'x', model: 'm', created: 1, delta: 'a' },
      {
        id: 'x',
        model: 'm',
        created: 1,
        delta: '',
        tool_calls: [{ index: 0, id: 't', function: { name: 'f', arguments: '{}' } }],
      },
      { id: 'x', model: 'm', created: 1, delta: 'b', finish_reason: 'stop' },
    ]);
    const kinds = [...out.matchAll(/"content_block":\{"type":"(text|tool_use)"/g)].map((m) => m[1]);
    assert.deepEqual(kinds, ['text', 'tool_use', 'text']);
  });
});
