import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRateLimitError, retryAfterSeconds } from '../../router/auto-router.js';
import { ImageGenerationRequestSchema } from '../../types.js';
import type { ChatRequest } from '../../types.js';
import { CustomProvider } from '../custom.js';
import { AgnesProvider } from '../agnes.js';
import { GeminiProvider } from '../gemini.js';
import { OpenRouterProvider } from '../openrouter.js';

/**
 * Providers used to throw `Error('openrouter chat failed 429: <body>')` and drop
 * the whole `Response` with it. A `Retry-After: 45` from the wire then never
 * reached the router — the only surviving channel was the BODY TEXT, which most
 * upstreams never echo. So nearly every 429 fell through to a guessed default.
 *
 * These tests assert the behaviour, not the class name: whatever is thrown must
 * let the router recover the upstream's hint without the upstream cooperating.
 */

const chatRequest: ChatRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hello' }],
  stream: false,
};

const CUSTOM_CREDENTIALS = {
  apiKey: '',
  extra: {
    sources: [
      {
        id: 'fixture',
        label: 'Fixture',
        baseUrl: 'https://fixture.invalid/v1',
        apiKey: 'custom-key',
        models: [{ id: 'fixture-model', displayName: 'Fixture Model' }],
      },
    ],
  },
};

interface DispatchingProvider {
  chat(req: ChatRequest): Promise<unknown>;
  stream(req: ChatRequest): AsyncIterable<unknown>;
}

interface CarriesHint {
  status?: number;
  retryAfter?: string;
}

function failingFetch(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/plain', ...headers },
    })) as typeof fetch;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the dispatch to reject');
}

async function caughtStream(stream: AsyncIterable<unknown>): Promise<unknown> {
  try {
    for await (const _chunk of stream) void _chunk;
  } catch (error) {
    return error;
  }
  throw new Error('expected the stream to reject');
}

const CHAT_PROVIDERS: Array<[string, () => DispatchingProvider]> = [
  // OpenAICompatibleProvider is inherited by 14 providers, so these two lines
  // are what fixes openrouter, gemini-compatible, siliconflow, nvidia, ...
  [
    'an OpenAI-compatible provider',
    () =>
      new OpenRouterProvider({
        credentials: { apiKey: 'k' },
        fetchImpl: failingFetch(429, '{"error":{"message":"limit"}}', { 'retry-after': '45' }),
      }),
  ],
  [
    'a custom source',
    () =>
      new CustomProvider({
        credentials: CUSTOM_CREDENTIALS,
        fetchImpl: failingFetch(429, 'limit', { 'retry-after': '45' }),
      }),
  ],
  [
    'gemini',
    () =>
      new GeminiProvider({
        credentials: { apiKey: 'k' },
        fetchImpl: failingFetch(429, 'limit', { 'retry-after': '45' }),
      }),
  ],
];

describe('upstream Retry-After survives the throw', () => {
  for (const [name, make] of CHAT_PROVIDERS) {
    it(`carries the header out of ${name} chat and stream failures`, async () => {
      const model = name === 'a custom source' ? 'fixture:fixture-model' : chatRequest.model;
      const req = { ...chatRequest, model };

      const chat = (await caught(() => make().chat(req))) as CarriesHint & Error;
      assert.ok(chat instanceof Error);
      assert.equal(chat.status, 429);
      assert.equal(chat.retryAfter, '45');
      // The router still has to classify this as a rate limit from the message,
      // which is what failover keys off.
      assert.match(chat.message, /failed 429/);

      const streamed = (await caughtStream(make().stream({ ...req, stream: true }))) as CarriesHint;
      assert.equal(streamed.retryAfter, '45');
    });
  }

  it('carries the header out of an image generation failure', async () => {
    const provider = new AgnesProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: failingFetch(429, 'limit', { 'retry-after': '45' }),
    });
    const request = ImageGenerationRequestSchema.parse({
      model: 'agnes-image-2.5-flash',
      prompt: 'a cat',
      size: '1024x1024',
    });
    const error = (await caught(() => provider.generateImage!(request))) as CarriesHint;
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, '45');
  });
});

describe('the parser no longer needs the upstream to cooperate', () => {
  it('recovers the hint when the body never mentions retry-after', async () => {
    // This is the case that used to silently degrade: the upstream told the
    // truth in a header and nothing at all in the body.
    const provider = new OpenRouterProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: failingFetch(429, '{"error":{"message":"rate limit exceeded"}}', {
        'retry-after': '45',
      }),
    });
    const error = await caught(() => provider.chat(chatRequest));

    assert.doesNotMatch(error instanceof Error ? error.message : String(error), /retry.after/i);
    assert.equal(parseRateLimitError(error).retryAfterSec, 45);
  });

  it('does not read an HTTP-date Retry-After as seconds', async () => {
    // RFC 9110 allows either. `retry-after: <HTTP-date>` would previously have
    // been parsed as "year seconds" — 2026 seconds is a 33-minute cooldown.
    const date = 'Wed, 21 Oct 2026 07:28:00 GMT';
    const provider = new OpenRouterProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: failingFetch(429, 'limit', { 'retry-after': date }),
    });
    const error = await caught(() => provider.chat(chatRequest));

    const parsed = parseRateLimitError(error);
    assert.equal(parsed.retryAfterSec, undefined, 'an HTTP-date is not a delay');
    assert.equal(parsed.resetAt, Date.parse(date));
  });

  it('bridges a structured error straight to a wait window', async () => {
    const provider = new OpenRouterProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: failingFetch(429, 'limit', { 'retry-after': '120' }),
    });
    const error = await caught(() => provider.chat(chatRequest));
    assert.equal(retryAfterSeconds(error), 120);
  });

  it('still refuses to invent a hint for a non-rate-limit failure', async () => {
    const provider = new OpenRouterProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: failingFetch(500, 'boom', { 'retry-after': '45' }),
    });
    const error = await caught(() => provider.chat(chatRequest));

    assert.equal(parseRateLimitError(error).isRateLimit, false);
    assert.equal(retryAfterSeconds(error), null, 'silence, not a false promise');
  });

  it('drops the hint when the upstream sent no Retry-After at all', async () => {
    const provider = new OpenRouterProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: failingFetch(429, 'limit'),
    });
    const error = (await caught(() => provider.chat(chatRequest))) as CarriesHint;
    assert.equal(error.retryAfter, undefined);
    assert.equal(parseRateLimitError(error).retryAfterSec, undefined);
  });
});
