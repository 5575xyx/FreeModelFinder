import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  capabilityTier,
  fetchCapabilities,
  fetchModels,
  protocolForSdk,
} from '../models/discovery.js';

const CAPABILITIES = {
  opencode: {
    id: 'opencode',
    api: 'https://opencode.ai/zen/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      chatty: {
        id: 'chatty',
        limit: { context: 200000, output: 8192 },
        reasoning: true,
        tool_call: true,
      },
      anthropicish: { id: 'anthropicish', provider: { npm: '@ai-sdk/anthropic' } },
      responsey: { id: 'responsey', provider: { npm: '@ai-sdk/openai' } },
      weird: { id: 'weird', provider: { npm: '@ai-sdk/unknown' } },
    },
  },
  'opencode-go': {
    id: 'opencode-go',
    api: 'https://opencode.ai/zen/go/v1',
    npm: '@ai-sdk/openai-compatible',
    models: { gochat: { id: 'gochat' } },
  },
};

function fetchJson(payload: unknown) {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('zen protocol inference', () => {
  it('maps SDKs to native protocols', () => {
    assert.equal(protocolForSdk('@ai-sdk/openai-compatible'), 'chat');
    assert.equal(protocolForSdk('@ai-sdk/anthropic'), 'anthropic');
    assert.equal(protocolForSdk('@ai-sdk/openai'), 'responses');
    assert.equal(protocolForSdk('@ai-sdk/unknown'), undefined);
  });

  it('classifies tiers by provider id and api', () => {
    assert.equal(capabilityTier('opencode-go', ''), 'go');
    assert.equal(capabilityTier('opencode', 'https://opencode.ai/zen/v1'), 'zen');
    assert.equal(capabilityTier('other', ''), undefined);
  });

  it('reads /v1/models ids', async () => {
    const models = await fetchModels(
      'https://opencode.ai/zen',
      'public',
      fetchJson({ data: [{ id: 'a' }, { id: 'b' }] }),
    );
    assert.deepEqual(models, ['a', 'b']);
  });

  it('builds per-tier protocols, unsupported flags and metadata', async () => {
    const caps = await fetchCapabilities(
      {
        zen: 'https://models.opencode.ai/api.json',
        go: 'https://models.opencode.ai/api.json',
        zenDocs: 'https://docs/zen.mdx',
        goDocs: 'https://docs/go.mdx',
      },
      fetchJson(CAPABILITIES),
    );
    assert.equal(caps.native.zen?.['chatty'], 'chat');
    assert.equal(caps.native.zen?.['anthropicish'], 'anthropic');
    assert.equal(caps.native.zen?.['responsey'], 'responses');
    assert.equal(caps.unsupported.zen?.['weird'], true);
    assert.equal(caps.native.go?.['gochat'], 'chat');
    assert.equal(caps.metadata.zen?.['chatty']?.contextWindow, 200000);
    assert.equal(caps.metadata.zen?.['chatty']?.reasoning, true);
  });
});

describe('zen discovery errors', () => {
  it('throws on a non-2xx models response', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    await assert.rejects(() => fetchModels('https://opencode.ai/zen', 'public', failing));
  });

  it('throws on an empty models list', async () => {
    await assert.rejects(() =>
      fetchModels('https://opencode.ai/zen', 'public', fetchJson({ data: [] })),
    );
  });

  it('throws when the capability catalog has no opencode models', async () => {
    await assert.rejects(() =>
      fetchCapabilities({ zen: 'https://x' }, fetchJson({ other: { id: 'other', models: {} } })),
    );
  });

  it('classifies a /go/ api as the go tier', async () => {
    const caps = await fetchCapabilities(
      { zen: 'https://x' },
      fetchJson({
        someprov: {
          id: 'someprov',
          api: 'https://opencode.ai/zen/go/v1',
          npm: '@ai-sdk/openai-compatible',
          models: { g: { id: 'g' } },
        },
      }),
    );
    assert.equal(caps.native.go?.['g'], 'chat');
  });
});
