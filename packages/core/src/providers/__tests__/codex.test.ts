import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { ChatRequest, StreamChunk } from '../../types.js';
import type { CredentialRuntime } from '../../credentials/runtime.js';

const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-codex-'));
process.env.FREEMODELFINDER_HOME = testHome;

const { createTestRuntime } = await import('../../credentials/runtime.js');
const { CodexProvider, CodexError } = await import('../codex.js');
const { CODEX_CATALOG_MODELS } = await import('../codex-catalog.js');
const { parseRateLimitError } = await import('../../router/auto-router.js');

type TestRuntime = ReturnType<typeof createTestRuntime>;

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const VALID_EXPIRY = () => new Date(Date.now() + 3_600_000).toISOString();

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

interface SeedAccount {
  id: string;
  accessToken?: string;
  expiresAt?: string;
  refreshToken?: string;
  accountId?: string;
  status?: 'active' | 'invalid';
}

const runtimes: TestRuntime[] = [];

function newRuntime(): TestRuntime {
  const runtime = createTestRuntime({ throttleMs: 60_000 });
  runtimes.push(runtime);
  return runtime;
}

async function flushRuntimes(): Promise<void> {
  for (const runtime of runtimes) {
    await runtime.waitForPersist().catch(() => undefined);
  }
  runtimes.length = 0;
}

async function resetHome(): Promise<void> {
  await flushRuntimes();
  await rm(testHome, { recursive: true, force: true });
  await mkdir(testHome, { recursive: true, mode: 0o700 });
}

after(async () => {
  await flushRuntimes();
  await rm(testHome, { recursive: true, force: true });
});

async function seed(runtime: TestRuntime, accounts: SeedAccount[]): Promise<void> {
  for (const account of accounts) {
    await runtime.upsertAccount('codex', {
      id: account.id,
      label: `${account.id}@example.com`,
      status: account.status ?? 'active',
      addedAt: Date.now(),
      payload: {
        refreshToken: account.refreshToken ?? `rt-${account.id}`,
        accountId: account.accountId ?? 'acc_1',
        ...(account.accessToken ? { accessToken: account.accessToken } : {}),
        ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}),
      },
    });
  }
}

function harness(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function refreshCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url.startsWith(TOKEN_URL));
}

function chatCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url.includes('/backend-api/codex/responses'));
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function oauthTokenOk(accessToken = 'at-new'): Response {
  return json({
    access_token: accessToken,
    refresh_token: 'rt-next',
    expires_in: 3600,
  });
}

function responsesSse(
  events: Array<Record<string, unknown>>,
  headers?: Record<string, string>,
): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n') + '\n\n';
  return new Response(payload, {
    headers: { 'content-type': 'text/event-stream', ...(headers ?? {}) },
  });
}

/** 一次完整的文本流：created → output_text.delta×N → completed（含 usage）。 */
function completedStream(
  deltas: string[],
  usage?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-5.5' } },
    ...deltas.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta,
    })),
  ];
  events.push({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      ...(usage ? { usage } : {}),
    },
  });
  return events;
}

function makeProvider(
  fetchImpl: typeof fetch,
  runtime: CredentialRuntime,
): InstanceType<typeof CodexProvider> {
  return new CodexProvider({
    credentials: { apiKey: '' },
    credentialRuntime: runtime,
    fetchImpl,
  });
}

function req(model: string, overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    ...overrides,
  };
}

function expectInRange(value: number | undefined, lo: number, hi: number, label: string): void {
  assert.ok(
    value !== undefined && value >= lo && value <= hi,
    `${label}: expected ${value} within [${lo}, ${hi}]`,
  );
}

/** 包装 runtime，记录 reportInvalid 调用并透传给真实实现。 */
function spyOnInvalid(runtime: TestRuntime): {
  runtime: CredentialRuntime;
  invalidCalls: Array<{ platform: string; accountId: string }>;
} {
  const invalidCalls: Array<{ platform: string; accountId: string }> = [];
  const proxy = new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === 'reportInvalid') {
        return (platform: string, accountId: string) => {
          invalidCalls.push({ platform, accountId });
          return Reflect.apply(target.reportInvalid, target, [platform, accountId]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { runtime: proxy, invalidCalls };
}

const MODEL = 'gpt-5.5';

describe('CodexProvider listModels', () => {
  it('prefixes every id with codex: and marks free + subscription', async () => {
    const runtime = newRuntime();
    const { calls, fetchImpl } = harness(() => json({}));
    const provider = makeProvider(fetchImpl, runtime);

    const models = await provider.listModels();
    assert.ok(models.length > 0);
    assert.equal(models.length, CODEX_CATALOG_MODELS.length);
    for (const model of models) {
      assert.ok(model.id.startsWith('codex:'), `${model.id} must carry the codex: prefix`);
      assert.equal(model.provider, 'codex');
      assert.equal(model.free, true);
      assert.equal(model.subscription, true);
      assert.equal(typeof model.displayName, 'string');
    }
    // listModels 是纯静态目录：不得产生任何网络请求。
    assert.equal(calls.length, 0);
  });
});

describe('CodexProvider request translation', () => {
  beforeEach(resetHome);

  it('sends the Responses request with codex headers, instructions and input shape', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const { calls, fetchImpl } = harness(() =>
      responsesSse(completedStream(['pong'], { input_tokens: 1, output_tokens: 1 })),
    );
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(
      req(MODEL, {
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hi' },
        ],
      }),
    );

    const call = chatCalls(calls)[0];
    assert.ok(call);
    assert.equal(call.url, RESPONSES_URL);
    assert.equal(headerOf(call.init, 'Authorization'), 'Bearer AT');
    assert.equal(headerOf(call.init, 'chatgpt-account-id'), 'acc_1');
    const body = bodyOf(call.init);
    assert.equal(body.model, MODEL);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, 'You are terse.');
    const input = body.input;
    assert.ok(Array.isArray(input) && input.length === 1);
    const first = (input as Array<Record<string, unknown>>)[0];
    assert.equal(first?.role, 'user');
    assert.deepEqual(first?.content, [{ type: 'input_text', text: 'hi' }]);
  });

  it('translates tools into Responses function format', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const { calls, fetchImpl } = harness(() => responsesSse(completedStream(['ok'])));
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(
      req(MODEL, {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }),
    );

    const body = bodyOf(chatCalls(calls)[0]?.init);
    assert.deepEqual(body.tools, [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: {} },
      },
    ]);
  });
});

describe('CodexProvider chat + stream', () => {
  beforeEach(resetHome);

  it('aggregates the SSE stream into a ChatResponse with mapped usage', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const usage = {
      input_tokens: 12,
      output_tokens: 34,
      total_tokens: 46,
      input_tokens_details: { cached_tokens: 5 },
    };
    const { fetchImpl } = harness(() => responsesSse(completedStream(['hello ', 'world'], usage)));
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'hello world');
    assert.equal(response.finish_reason, 'stop');
    assert.equal(response.rawProtocol, 'openai');
    assert.equal(response.usage?.prompt_tokens, 12);
    assert.equal(response.usage?.completion_tokens, 34);
    assert.equal(response.usage?.total_tokens, 46);
    assert.equal(response.usage?.prompt_tokens_details?.cached_tokens, 5);
  });

  it('collects full text from response.output_item.done when no deltas were sent', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const { fetchImpl } = harness(() =>
      responsesSse([
        { type: 'response.created', response: { id: 'resp_1', created_at: 1 } },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done item text' }],
          },
        },
        {
          type: 'response.completed',
          response: { id: 'resp_1', usage: { input_tokens: 7, output_tokens: 2 } },
        },
      ]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'done item text');
    assert.equal(response.usage?.prompt_tokens, 7);
    assert.equal(response.usage?.completion_tokens, 2);
  });

  it('yields stream chunks whose deltas join to the full text and finish with stop', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const { fetchImpl } = harness(() =>
      responsesSse(
        completedStream(['Hel', 'lo ', '世界'], {
          input_tokens: 3,
          output_tokens: 4,
          total_tokens: 7,
        }),
      ),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(req(MODEL))) {
      chunks.push(chunk);
    }
    assert.ok(chunks.length >= 3);
    assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'Hello 世界');
    for (const chunk of chunks) {
      assert.equal(chunk.model, MODEL);
      assert.equal(chunk.rawProtocol, 'openai');
    }
    const last = chunks[chunks.length - 1];
    assert.equal(last?.finish_reason, 'stop');
    assert.equal(last?.usage?.total_tokens, 7);
  });

  it('merges function calls from response.output_item.done into tool_calls', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const { fetchImpl } = harness(() =>
      responsesSse([
        { type: 'response.created', response: { id: 'resp_1', created_at: 1 } },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'call_abc',
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
          },
        },
        { type: 'response.completed', response: { id: 'resp_1' } },
      ]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.finish_reason, 'tool_calls');
    assert.equal(response.tool_calls?.length, 1);
    assert.equal(response.tool_calls?.[0]?.id, 'call_abc');
    assert.equal(response.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(response.tool_calls?.[0]?.function.arguments, '{"city":"Paris"}');
  });
});

describe('CodexProvider token lifecycle', () => {
  beforeEach(resetHome);

  it('force-refreshes once on chat 401 and retries with the new token', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'stale-token', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const { calls, fetchImpl } = harness((call) => {
      if (call.url.includes('auth.openai.com/oauth/token')) return oauthTokenOk('at-new');
      if (headerOf(call.init, 'authorization') === 'Bearer stale-token') {
        return json({ error: { message: 'token expired' } }, 401);
      }
      return responsesSse(completedStream(['after refresh']));
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'after refresh');
    assert.equal(refreshCalls(calls).length, 1);
    assert.equal(chatCalls(calls).length, 2);
  });

  it('marks the account invalid when the refresh reports refresh_token_reused', async () => {
    const runtime = newRuntime();
    const { runtime: spied, invalidCalls } = spyOnInvalid(runtime);
    await seed(runtime, [{ id: 'acc1', refreshToken: 'rt-reused', accountId: 'acc_1' }]);
    const { fetchImpl } = harness(() =>
      json({ error: 'refresh_token_reused', error_description: 'token already used' }, 400),
    );
    const provider = makeProvider(fetchImpl, spied);

    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof CodexError);
      assert.match(error.message, /失效/);
      return true;
    });
    assert.ok(
      invalidCalls.some((call) => call.platform === 'codex' && call.accountId === 'acc1'),
      'reportInvalid must be called for the dead account',
    );
    const pool = await runtime.getPool('codex');
    assert.equal(pool.accounts[0]?.status, 'invalid');
    assert.equal(runtime.hasActiveAccounts('codex'), false);
  });

  it('persists rotated tokens after a successful refresh', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', refreshToken: 'rt-old', accountId: 'acc_1' }]);
    const { calls, fetchImpl } = harness((call) =>
      call.url.includes('auth.openai.com/oauth/token')
        ? oauthTokenOk('at-rotated')
        : responsesSse(completedStream(['ok'])),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'ok');
    assert.equal(refreshCalls(calls).length, 1);
    await runtime.waitForPersist();
    const pool = await runtime.getPool('codex');
    assert.equal(pool.accounts[0]?.payload.accessToken, 'at-rotated');
    assert.equal(pool.accounts[0]?.payload.refreshToken, 'rt-next');
  });
});

describe('CodexProvider error matrix', () => {
  beforeEach(resetHome);

  it('surfaces 429 as a rate_limit error with resetAt from Retry-After', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const { fetchImpl } = harness(
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const started = Date.now();
    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof CodexError);
      assert.equal(error.kind, 'rate_limit');
      assert.equal(error.status, 429);
      expectInRange(error.resetAt, started + 28_000, started + 33_000, 'resetAt');
      assert.equal(parseRateLimitError(error).isRateLimit, true);
      return true;
    });
  });

  it('cools the rate-limited account and switches to the next one', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'at-1', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
      { id: 'acc2', accessToken: 'at-2', expiresAt: VALID_EXPIRY(), accountId: 'acc_2' },
    ]);
    const { calls, fetchImpl } = harness((call) => {
      if (headerOf(call.init, 'authorization') === 'Bearer at-1') {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
      }
      return responsesSse(completedStream(['ok from acc2']));
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'ok from acc2');
    assert.equal(chatCalls(calls).length, 2);
    assert.equal(headerOf(chatCalls(calls)[1]?.init, 'chatgpt-account-id'), 'acc_2');

    const cooldowns = runtime.listAccountCooldowns('codex', 'acc1');
    assert.equal(cooldowns.length, 1);
    assert.equal(cooldowns[0]?.model, MODEL);
  });

  it('never echoes a token from a 401 response body (token leak protection)', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    const { fetchImpl } = harness((call) => {
      if (call.url.includes('auth.openai.com/oauth/token')) return oauthTokenOk('at-new');
      if (headerOf(call.init, 'authorization') === 'Bearer at-new') {
        return json({ error: { message: 'token=sk-FAKE is not valid' } }, 401);
      }
      return json({ error: { message: 'token rejected' } }, 401);
    });
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('sk-FAKE'), `leaked token: ${error.message}`);
      return true;
    });
    const usage = runtime.snapshotUsage('codex');
    for (const entry of usage) {
      assert.ok(!(entry.lastError ?? '').includes('sk-FAKE'));
    }
  });

  it('exposes hasCredentials from the active account pool', async () => {
    const runtime = newRuntime();
    const { fetchImpl } = harness(() => responsesSse(completedStream(['x'])));
    const provider = makeProvider(fetchImpl, runtime);
    assert.equal(provider.hasCredentials(), false);

    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountId: 'acc_1' },
    ]);
    assert.equal(provider.hasCredentials(), true);

    runtime.reportInvalid('codex', 'acc1');
    assert.equal(provider.hasCredentials(), false);
  });
});
