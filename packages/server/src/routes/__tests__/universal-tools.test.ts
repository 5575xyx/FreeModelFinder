import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type ProviderId,
  type StreamChunk,
} from '@freemodelfinder/core';
import { createServer } from '../../server.js';

interface FakeProvider {
  id: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamChunk>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function testConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {
      custom: {
        enabled: true,
        credentials: {
          apiKey: '',
          extra: {
            sources: [
              {
                id: 'fixture',
                label: 'Fixture',
                baseUrl: 'https://fixture.invalid/v1',
                apiKey: 'source-key',
                models: [{ id: 'fixture-model' }],
              },
            ],
          },
        },
      },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

function registryWith(provider: FakeProvider): ProviderRegistry {
  const registry = new ProviderRegistry(testConfig());
  const id = provider.id as ProviderId;
  registry.resolveModel = () => ({ provider: provider as never, modelId: 'fixture-model' });
  registry.listAllModels = async () => ({
    models: [{ id: 'fixture-model', provider: id, displayName: 'Fixture', free: true }],
    succeededProviders: [id],
    failedProviders: [],
  });
  return registry;
}

function toolProvider(
  id: string,
  chunks: StreamChunk[],
): { provider: FakeProvider; lastReq: () => ChatRequest | undefined } {
  let last: ChatRequest | undefined;
  const provider: FakeProvider = {
    id,
    chat: async () => {
      throw new Error('non-stream path not used in this suite');
    },
    stream: async function* (req) {
      last = req;
      for (const chunk of chunks) yield chunk;
    },
  };
  return { provider, lastReq: () => last };
}

const toolChunk: StreamChunk = {
  id: 'chatcmpl-1',
  model: 'fixture-model',
  created: 1_700_000_000,
  delta: '',
  finish_reason: 'tool_calls',
  tool_calls: [
    {
      index: 0,
      id: 'call_abc',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    },
  ],
};

function parseSseData(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      const record = asRecord(parsed);
      if (record) out.push(record);
    } catch {
      // ignore non-JSON keep-alive lines
    }
  }
  return out;
}

describe('universal tool calling end to end', () => {
  it('forwards OpenAI tool_calls deltas with finish_reason tool_calls over SSE', async () => {
    const { provider, lastReq } = toolProvider('custom', [toolChunk]);
    const { app } = await createServer({
      registry: registryWith(provider),
      watchIntervalMs: 60 * 60 * 1000,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'custom:fixture-model',
          stream: true,
          tools: [
            { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
          ],
          messages: [
            { role: 'user', content: 'weather?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_abc', content: '{"temp":20}' },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const events = parseSseData(res.body);
      const toolChoices = events
        .map((event) => asArray(event.choices)[0])
        .map((choice) => asRecord(choice))
        .filter((choice): choice is Record<string, unknown> => choice !== undefined)
        .filter((choice) => {
          const delta = asRecord(choice.delta);
          return asArray(delta?.tool_calls).length > 0;
        });

      assert.equal(toolChoices.length, 1, 'exactly one delta must carry tool_calls');
      const choice = toolChoices[0]!;
      const delta = asRecord(choice.delta)!;
      const call = asRecord(asArray(delta.tool_calls)[0])!;
      assert.equal(call.id, 'call_abc');
      assert.equal(asRecord(call.function)?.name, 'get_weather');
      assert.equal(asRecord(call.function)?.arguments, '{"city":"SF"}');
      assert.equal(choice.finish_reason, 'tool_calls');
      assert.ok(res.body.includes('data: [DONE]'));

      const sent = lastReq();
      assert.ok(sent, 'provider.stream must receive the normalized request');
      assert.equal(sent.tools?.[0]?.function.name, 'get_weather');
      const assistant = sent.messages.find((m) => m.role === 'assistant');
      assert.equal(assistant?.tool_calls?.[0]?.id, 'call_abc');
      assert.equal(sent.messages.find((m) => m.role === 'tool')?.tool_call_id, 'call_abc');
    } finally {
      await app.close();
    }
  });

  it('serializes Anthropic tool_use blocks and input_json_delta over SSE', async () => {
    const { provider, lastReq } = toolProvider('custom', [toolChunk]);
    const { app } = await createServer({
      registry: registryWith(provider),
      watchIntervalMs: 60 * 60 * 1000,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'custom:fixture-model',
          max_tokens: 64,
          stream: true,
          tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
          messages: [
            { role: 'user', content: 'weather?' },
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'SF' } },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: '{"temp":20}' }],
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const events = parseSseData(res.body);
      const start = events.find(
        (event) =>
          event.type === 'content_block_start' &&
          asRecord(event.content_block)?.type === 'tool_use',
      );
      assert.ok(start, 'a tool_use content block must open');
      const block = asRecord(start!.content_block)!;
      assert.equal(block.id, 'call_abc');
      assert.equal(block.name, 'get_weather');

      const jsonDeltas = events.filter(
        (event) => asRecord(event.delta)?.type === 'input_json_delta',
      );
      assert.equal(jsonDeltas.length, 1);
      assert.equal(asRecord(jsonDeltas[0]!.delta)!.partial_json, '{"city":"SF"}');

      const messageDelta = events.find((event) => event.type === 'message_delta');
      assert.equal(asRecord(messageDelta?.delta)?.stop_reason, 'tool_use');

      const sent = lastReq();
      assert.ok(sent);
      const assistant = sent.messages.find((m) => m.role === 'assistant');
      assert.equal(assistant?.tool_calls?.[0]?.id, 'call_abc');
      assert.equal(sent.messages.find((m) => m.role === 'tool')?.tool_call_id, 'call_abc');
    } finally {
      await app.close();
    }
  });

  it('serializes Gemini functionCall parts over SSE', async () => {
    const { provider, lastReq } = toolProvider('custom', [toolChunk]);
    const { app } = await createServer({
      registry: registryWith(provider),
      watchIntervalMs: 60 * 60 * 1000,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1beta/models/custom:fixture-model:streamGenerateContent',
        payload: {
          contents: [{ role: 'user', parts: [{ text: 'weather?' }] }],
          tools: [
            { functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const events = parseSseData(res.body);
      const candidate = asRecord(asArray(events[0]?.candidates)[0])!;
      const parts = asArray(asRecord(candidate.content)?.parts).map((part) => asRecord(part)!);
      const functionCall = asRecord(parts.find((part) => part.functionCall)?.functionCall)!;
      assert.equal(functionCall.name, 'get_weather');
      assert.deepEqual(functionCall.args, { city: 'SF' });

      const sent = lastReq();
      assert.ok(sent);
      assert.equal(sent.tools?.[0]?.function.name, 'get_weather');
    } finally {
      await app.close();
    }
  });

  it('forwards opencode (zen) tool_calls through the generic SSE egress', async () => {
    const { provider } = toolProvider('opencode', [toolChunk]);
    const { app } = await createServer({
      registry: registryWith(provider),
      watchIntervalMs: 60 * 60 * 1000,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'opencode:fixture-model',
          stream: true,
          messages: [{ role: 'user', content: 'weather?' }],
        },
      });

      assert.equal(res.statusCode, 200);
      const events = parseSseData(res.body);
      const forwarded = events.some((event) => {
        const choice = asRecord(asArray(event.choices)[0]);
        return asArray(asRecord(choice?.delta)?.tool_calls).length > 0;
      });
      assert.ok(forwarded, 'opencode tool_calls must not be special-cased away');
    } finally {
      await app.close();
    }
  });
});
