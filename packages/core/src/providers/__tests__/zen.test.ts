import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type {
  ZenGateway,
  ZenHttpClient,
  ZenHttpRequest,
  ZenHttpResponse,
  ZenModelMetadata,
} from '@freemodelfinder/zen';
import type { ProviderContext } from '../base.js';
import { ZenProvider } from '../zen.js';

const ZEN_MODELS = {
  object: 'list',
  data: [{ id: 'free-model' }, { id: 'paid-model' }],
};

const GO_MODELS = {
  object: 'list',
  data: [{ id: 'free-model' }],
};

const CAPABILITIES = {
  opencode: {
    api: 'https://opencode.ai/zen',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'free-model': { id: 'free-model', limit: { context: 128000, output: 4096 } },
      'paid-model': { id: 'paid-model' },
    },
  },
};

const MODELS_DEV = {
  opencode: {
    id: 'opencode',
    models: {
      'free-model': { id: 'free-model', cost: { input: 0, output: 0 } },
      'paid-model': { id: 'paid-model', cost: { input: 1, output: 2 } },
    },
  },
};

const CHAT_BODY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'free-model',
  created: 123,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

/**
 * Isolated cache paths for tests that build a real gateway. A started gateway
 * persists the catalog and pricing in the background, so without this the suite
 * reads and writes the developer's real ~/.freemodelfinder state and its result
 * depends on whatever another run left there.
 *
 * `availability` belongs to the same contract: the probe scheduler writes it
 * through the same default CONFIG_DIR, so omitting it silently recreates the
 * real file on every run.
 */
async function tempCachePaths(): Promise<{
  extra: { cachePaths: { catalog: string; pricing: string; availability: string } };
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fmf-zen-provider-'));
  return {
    extra: {
      cachePaths: {
        catalog: join(dir, 'catalog.json'),
        pricing: join(dir, 'pricing.json'),
        availability: join(dir, 'availability.json'),
      },
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Probe transport that never leaves the process. A started gateway schedules
 * availability probes against every free model; without an injected client those
 * probes hit the real opencode.ai from a unit test.
 */
function offlineClient(): ZenHttpClient {
  return {
    send: async () => {
      throw new Error('probes must not leave the test process');
    },
  };
}

function webJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fixedFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('models.opencode.ai')) return webJson(CAPABILITIES);
    if (url.includes('models.dev')) return webJson(MODELS_DEV);
    if (url.endsWith('/go/v1/models')) return webJson(GO_MODELS);
    if (url.endsWith('/v1/models')) return webJson(ZEN_MODELS);
    if (url.includes('.mdx')) return new Response('', { status: 404 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  return impl as unknown as typeof fetch;
}

function inboundJson(status: number, body: unknown): ZenHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage,
    committed: true,
  };
}

class FakeClient implements ZenHttpClient {
  readonly requests: ZenHttpRequest[] = [];

  constructor(private readonly respond: (request: ZenHttpRequest) => ZenHttpResponse) {}

  async send(request: ZenHttpRequest): Promise<ZenHttpResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

function recordingGateway(calls: string[]): ZenGateway {
  return {
    listRoutes: () => [{ id: 'free-model' }],
    isFreeModel: () => true,
    // mirrors the capability limit opencode publishes for this model
    metadataForTier: (model: string) =>
      model === 'free-model' ? { contextWindow: 128000, maxOutput: 4096 } : {},
    snapshot: () => ({}),
    chat: async () => {
      calls.push('chat');
      return { id: 'x', model: 'free-model', created: 1, content: 'hi', finish_reason: 'stop' };
    },
    stream: async function* () {
      calls.push('stream');
      yield* [];
    },
    start: async () => {
      calls.push('start');
    },
    stop: () => {
      calls.push('stop');
    },
    refresh: async () => {
      calls.push('refresh');
      return {};
    },
    loadCache: async () => {
      calls.push('loadCache');
      return { catalog: false, pricing: false };
    },
    monitor: () => ({}),
  } as unknown as ZenGateway;
}

class RecordingZenProvider extends ZenProvider {
  constructor(
    ctx: ProviderContext,
    private readonly injected: ZenGateway,
  ) {
    super(ctx);
  }

  protected override createGateway(): ZenGateway {
    return this.injected;
  }
}

describe('zen (opencode) provider', () => {
  it('reports credentials from the anonymous flag and the key pools', () => {
    const anonymous = new ZenProvider({
      credentials: { apiKey: '', extra: { anonymous: true } },
    });
    assert.equal(anonymous.hasCredentials(), true);

    const goOnly = new ZenProvider({
      credentials: { apiKey: '', extra: { goKeys: ['go-key'] } },
    });
    assert.equal(goOnly.hasCredentials(), true);

    const zenOnly = new ZenProvider({ credentials: { apiKey: 'zen-key' } });
    assert.equal(zenOnly.hasCredentials(), true);

    const none = new ZenProvider({ credentials: { apiKey: '' } });
    assert.equal(none.hasCredentials(), false);
  });

  it('lists routes with the opencode provider id', async () => {
    const cache = await tempCachePaths();
    try {
      const provider = new ZenProvider({
        credentials: {
          apiKey: 'zen-key',
          extra: { ...cache.extra, httpClient: offlineClient() },
        },
        fetchImpl: fixedFetch(),
      });
      const models = await provider.listModels();
      assert.ok(models.length >= 1);
      assert.equal(
        models.every((model) => model.provider === 'opencode'),
        true,
      );
      assert.equal(models.find((model) => model.id === 'opencode:free-model')?.free, true);
      assert.equal(models.find((model) => model.id === 'opencode:paid-model')?.free, false);
      // the capability limit must survive the whole trip into ModelInfo
      assert.equal(
        models.find((model) => model.id === 'opencode:free-model')?.contextWindow,
        128000,
      );
      assert.equal(
        models.find((model) => model.id === 'opencode:paid-model')?.contextWindow,
        undefined,
      );
    } finally {
      await cache.cleanup();
    }
  });

  it('carries reasoning efforts, the default effort and cost into ModelInfo', async () => {
    const calls: string[] = [];
    const gateway: ZenGateway = {
      ...recordingGateway(calls),
      metadataForTier: () =>
        ({
          contextWindow: 128000,
          maxOutput: 4096,
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0.5, cacheWrite: 1.5 },
        }) as ZenModelMetadata,
      reasoningEfforts: () => ['minimal', 'low', 'medium', 'high'],
      resolvedEffort: () => 'high',
    };
    const provider = new RecordingZenProvider(
      { credentials: { apiKey: '', extra: { anonymous: true } } },
      gateway,
    );

    const model = (await provider.listModels()).find((item) => item.id === 'opencode:free-model');
    assert.deepEqual(model?.reasoningEfforts, ['minimal', 'low', 'medium', 'high']);
    assert.equal(model?.defaultReasoningEffort, 'high');
    assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0.5, cacheWrite: 1.5 });
  });

  it('omits the default reasoning effort when the probe only proved none', async () => {
    const calls: string[] = [];
    const gateway: ZenGateway = {
      ...recordingGateway(calls),
      metadataForTier: () => ({ reasoning: true }) as ZenModelMetadata,
      reasoningEfforts: () => ['minimal', 'low'],
      resolvedEffort: () => 'none',
    };
    const provider = new RecordingZenProvider(
      { credentials: { apiKey: '', extra: { anonymous: true } } },
      gateway,
    );

    const model = (await provider.listModels()).find((item) => item.id === 'opencode:free-model');
    assert.deepEqual(model?.reasoningEfforts, ['minimal', 'low']);
    assert.equal(model?.defaultReasoningEffort, undefined);
    assert.equal(model?.cost, undefined);
  });

  it('throws when the catalog is unavailable so the registry can fall back', async () => {
    const provider = new ZenProvider({
      credentials: {
        apiKey: '',
        extra: {
          anonymous: true,
          httpClient: offlineClient(),
          cachePaths: {
            catalog: join(tmpdir(), 'fmf-zen-no-cache', 'catalog.json'),
            pricing: join(tmpdir(), 'fmf-zen-no-cache', 'pricing.json'),
            availability: join(tmpdir(), 'fmf-zen-no-cache', 'availability.json'),
          },
        },
      },
      fetchImpl: (async () => new Response('unavailable', { status: 503 })) as typeof fetch,
    });
    await assert.rejects(provider.listModels(), /opencode model catalog unavailable/);
  });

  it('returns a ChatResponse from chat()', async () => {
    const client = new FakeClient(() => inboundJson(200, CHAT_BODY));
    const cache = await tempCachePaths();
    try {
      const provider = new ZenProvider({
        credentials: {
          apiKey: '',
          extra: { anonymous: true, httpClient: client, ...cache.extra },
        },
        fetchImpl: fixedFetch(),
      });
      const response = await provider.chat({
        model: 'free-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        rawProtocol: 'openai',
      });
      assert.equal(response.model, 'free-model');
      assert.equal(response.content, 'hello');
      assert.equal(response.usage?.total_tokens, 3);
      assert.equal(response.rawProtocol, 'openai');
      assert.deepEqual(response.raw, CHAT_BODY);
      assert.ok(client.requests.length >= 1);
    } finally {
      await cache.cleanup();
    }
  });

  it('loads the zen cache once before the first chat refresh', async () => {
    const calls: string[] = [];
    const provider = new RecordingZenProvider(
      { credentials: { apiKey: '', extra: { anonymous: true } } },
      recordingGateway(calls),
    );

    await provider.chat({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    assert.deepEqual(calls, ['start', 'loadCache', 'refresh', 'chat']);
  });

  it('starts the zen gateway once so its background health checks are scheduled', async () => {
    const calls: string[] = [];
    const provider = new RecordingZenProvider(
      { credentials: { apiKey: '', extra: { anonymous: true } } },
      recordingGateway(calls),
    );

    await provider.chat({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    await provider.listModels();
    for await (const _chunk of provider.stream({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) {
      void _chunk;
    }

    assert.equal(calls.filter((call) => call === 'start').length, 1);
    assert.equal(calls[0], 'start');
  });

  it('stops the zen gateway on dispose', async () => {
    const calls: string[] = [];
    const provider = new RecordingZenProvider(
      { credentials: { apiKey: '', extra: { anonymous: true } } },
      recordingGateway(calls),
    );

    await provider.chat({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    provider.dispose();

    assert.deepEqual(
      calls.filter((call) => call === 'stop'),
      ['stop'],
    );
    calls.length = 0;
    provider.dispose();
    assert.deepEqual(calls, [], 'dispose must be idempotent');
  });

  it('loads the zen cache once before the first listModels refresh', async () => {
    const calls: string[] = [];
    const provider = new RecordingZenProvider(
      { credentials: { apiKey: '', extra: { anonymous: true } } },
      recordingGateway(calls),
    );

    const models = await provider.listModels();
    assert.ok(models.length >= 1);
    assert.deepEqual(calls, ['start', 'loadCache', 'refresh']);
  });

  it('does not reload the zen cache on subsequent calls', async () => {
    const calls: string[] = [];
    const provider = new RecordingZenProvider(
      { credentials: { apiKey: '', extra: { anonymous: true } } },
      recordingGateway(calls),
    );

    await provider.chat({
      model: 'free-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    await provider.listModels();

    assert.equal(calls.filter((call) => call === 'loadCache').length, 1);
  });

  it('loads a pre-written catalog cache from disk without a network fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-provider-cache-'));
    const catalogPath = join(dir, 'zen.models.catalog.json');
    const pricingPath = join(dir, 'missing-pricing.json');
    const cache = {
      schema_version: 3,
      updated_at: '2026-09-01T00:00:00.000Z',
      zen: ['cached-free-model'],
      go: [],
      native_protocols: { zen: { 'cached-free-model': 'chat' } },
      unsupported: {},
      metadata: {},
    };
    await writeFile(catalogPath, JSON.stringify(cache), 'utf8');

    try {
      const provider = new ZenProvider({
        credentials: {
          apiKey: '',
          extra: {
            anonymous: true,
            httpClient: offlineClient(),
            cachePaths: {
              catalog: catalogPath,
              pricing: pricingPath,
              availability: join(dir, 'availability.json'),
            },
          },
        },
        fetchImpl: (async () => {
          throw new Error('offline');
        }) as typeof fetch,
      });

      const models = await provider.listModels();
      assert.ok(
        models.some((model) => model.id === 'opencode:cached-free-model'),
        'the cached catalog model must be served from disk',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
