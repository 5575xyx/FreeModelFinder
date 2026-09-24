import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type StreamChunk,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithStreamError(streamError: Error): Promise<FastifyInstance> {
  const config: AppConfig = {
    version: 2,
    port: 11435,
    providers: {},
    autoRoute: { enabled: false, strategy: 'capability' },
  };
  const registry = new ProviderRegistry(config);
  const provider = {
    id: 'custom',
    async chat(): Promise<ChatResponse> {
      throw streamError;
    },
    async *stream(_request: ChatRequest): AsyncGenerator<StreamChunk> {
      yield {
        id: 's',
        model: 'primary',
        created: 1,
        delta: 'partial',
      };
      throw streamError;
    },
  };
  registry.resolveModel = () => ({ provider: provider as never, modelId: 'primary' });
  registry.listAllModels = async () => ({
    models: [{ id: 'primary', provider: 'custom', displayName: 'Primary', free: true }],
    succeededProviders: ['custom'],
    failedProviders: [],
  });
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

function parseSseData(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)) as unknown);
}

describe('stream error SSE envelope', () => {
  it('OpenAI stream failures emit an error object, not a bare string', async () => {
    const app = await appWithStreamError(new Error('stream failed 500 boom'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'custom:primary',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/event-stream/);
    const events = parseSseData(res.body);
    const errorEvent = events.find(
      (e): e is { error: { message: string; type?: string } } =>
        typeof e === 'object' && e !== null && 'error' in e,
    );
    assert.ok(errorEvent, `expected an error event, got: ${res.body}`);
    assert.equal(typeof errorEvent.error, 'object');
    assert.equal(typeof errorEvent.error.message, 'string');
    assert.match(errorEvent.error.message, /stream failed 500 boom/);
    assert.equal(typeof errorEvent.error.type, 'string');
  });

  it('Gemini stream failures emit an error object with a message field', async () => {
    const app = await appWithStreamError(new Error('stream failed 500 boom'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1beta/models/custom:primary:streamGenerateContent',
      payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });
    assert.equal(res.statusCode, 200);
    const events = parseSseData(res.body);
    const errorEvent = events.find(
      (e): e is { error: { message: string } } =>
        typeof e === 'object' && e !== null && 'error' in e,
    );
    assert.ok(errorEvent, `expected an error event, got: ${res.body}`);
    assert.equal(typeof errorEvent.error, 'object');
    assert.match(String(errorEvent.error.message), /stream failed 500 boom/);
  });
});
