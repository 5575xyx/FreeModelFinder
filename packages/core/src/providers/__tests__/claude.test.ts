import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { ChatRequest, StreamChunk } from '../../types.js';
import type { CredentialRuntime } from '../../credentials/runtime.js';

const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-claude-'));
process.env.FREEMODELFINDER_HOME = testHome;

const { createTestRuntime } = await import('../../credentials/runtime.js');
const { ClaudeProvider, ClaudeError } = await import('../claude.js');
const { CLAUDE_CATALOG_MODELS, DEFAULT_MAX_TOKENS } = await import('../claude-catalog.js');
const { parseRateLimitError } = await import('../../router/auto-router.js');

type TestRuntime = ReturnType<typeof createTestRuntime>;

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
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
  accountUuid?: string;
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
    await runtime.upsertAccount('claude', {
      id: account.id,
      label: `${account.id}@example.com`,
      status: account.status ?? 'active',
      addedAt: Date.now(),
      payload: {
        refreshToken: account.refreshToken ?? `rt-${account.id}`,
        accountUuid: account.accountUuid ?? '',
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
  return calls.filter((call) => call.url === TOKEN_URL);
}

function chatCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url.startsWith(MESSAGES_URL));
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

function profileOk(): Response {
  return json({ account: { uuid: 'acc_uuid_1', email: 'a@example.com' } });
}

/** Anthropic Messages SSE：`event:` 行 + `data:` JSON，块之间空行分隔。 */
function messagesSse(events: Array<Record<string, unknown>>): Response {
  const payload =
    events
      .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`)
      .join('\n\n') + '\n\n';
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
}

/** 一次完整的文本流：message_start(usage) → text deltas → message_delta → message_stop。 */
function textStream(
  deltas: string[],
  options: { inputTokens?: number; outputTokens?: number; stopReason?: string } = {},
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: options.inputTokens ?? 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...deltas.map((text) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: options.stopReason ?? 'end_turn', stop_sequence: null },
      usage: { output_tokens: options.outputTokens ?? 1 },
    },
    { type: 'message_stop' },
  ];
  return events;
}

function makeProvider(
  fetchImpl: typeof fetch,
  runtime: CredentialRuntime,
): InstanceType<typeof ClaudeProvider> {
  return new ClaudeProvider({
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

const MODEL = 'claude-sonnet-4-5';

describe('ClaudeProvider listModels', () => {
  it('prefixes every id with claude: and marks free + subscription', async () => {
    const runtime = newRuntime();
    const { calls, fetchImpl } = harness(() => json({}));
    const provider = makeProvider(fetchImpl, runtime);

    const models = await provider.listModels();
    assert.ok(models.length > 0);
    assert.equal(models.length, CLAUDE_CATALOG_MODELS.length);
    for (const model of models) {
      assert.ok(model.id.startsWith('claude:'), `${model.id} must carry the claude: prefix`);
      assert.equal(model.provider, 'claude');
      assert.equal(model.free, true);
      assert.equal(model.subscription, true);
      assert.equal(typeof model.displayName, 'string');
    }
    // listModels 是纯静态目录：不得产生任何网络请求。
    assert.equal(calls.length, 0);
  });
});

describe('ClaudeProvider request translation', () => {
  beforeEach(resetHome);

  it('sends the Messages request with bearer auth, protocol headers and folded system', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { calls, fetchImpl } = harness(() => messagesSse(textStream(['pong'])));
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
    assert.equal(call.url, MESSAGES_URL);
    assert.equal(call.init?.method, 'POST');
    assert.equal(headerOf(call.init, 'Authorization'), 'Bearer AT');
    assert.equal(headerOf(call.init, 'anthropic-version'), '2023-06-01');
    assert.equal(headerOf(call.init, 'anthropic-beta'), 'oauth-2025-04-20');
    assert.equal(headerOf(call.init, 'Content-Type'), 'application/json');

    const body = bodyOf(call.init);
    assert.equal(body.model, MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS);
    assert.equal(body.system, 'You are terse.');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  });

  it('honours an explicit max_tokens when the request supplies one', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { calls, fetchImpl } = harness(() => messagesSse(textStream(['ok'])));
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(req(MODEL, { max_tokens: 256 }));

    assert.equal(bodyOf(chatCalls(calls)[0]?.init).max_tokens, 256);
  });

  it('translates image parts, tools and tool messages into Anthropic shapes', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { calls, fetchImpl } = harness(() => messagesSse(textStream(['ok'])));
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(
      req(MODEL, {
        messages: [
          {
            role: 'user',
            content: 'look',
            contentParts: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
            ],
          },
          {
            role: 'assistant',
            content: 'calling',
            tool_calls: [
              {
                id: 'toolu_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: 'tool', content: '{"temp":20}', tool_call_id: 'toolu_1' },
        ],
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
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0]?.content, [
      { type: 'text', text: 'look' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
    ]);
    assert.deepEqual(messages[1]?.content, [
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
    ]);
    assert.deepEqual(messages[2], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":20}' }],
    });
  });
});

describe('ClaudeProvider chat + stream', () => {
  beforeEach(resetHome);

  it('maps a non-streaming Messages response to a ChatResponse', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { fetchImpl } = harness(() =>
      json({
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'pong' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'pong');
    assert.equal(response.finish_reason, 'stop');
    assert.equal(response.rawProtocol, 'anthropic');
    assert.equal(response.usage?.prompt_tokens, 7);
    assert.equal(response.usage?.completion_tokens, 2);
    assert.equal(response.usage?.total_tokens, 9);
  });

  it('maps tool_use content blocks to tool_calls with parsed input', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { fetchImpl } = harness(() =>
      json({
        id: 'msg_3',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'Paris' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.finish_reason, 'tool_calls');
    assert.equal(response.tool_calls?.length, 1);
    assert.equal(response.tool_calls?.[0]?.id, 'toolu_9');
    assert.equal(response.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(response.tool_calls?.[0]?.function.arguments, '{"city":"Paris"}');
  });

  it('yields stream chunks whose deltas join to the full text and finish with stop', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { fetchImpl } = harness(() =>
      messagesSse(textStream(['Hel', 'lo ', '世界'], { inputTokens: 3, outputTokens: 4 })),
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
      assert.equal(chunk.rawProtocol, 'anthropic');
    }
    const last = chunks[chunks.length - 1];
    assert.equal(last?.finish_reason, 'stop');
    assert.equal(last?.usage?.prompt_tokens, 3);
    assert.equal(last?.usage?.completion_tokens, 4);
    assert.equal(last?.usage?.total_tokens, 7);
  });

  it('accumulates input_json_delta tool_use blocks into tool_calls', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { fetchImpl } = harness(() =>
      messagesSse([
        {
          type: 'message_start',
          message: { id: 'msg_4', usage: { input_tokens: 5 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_5', name: 'get_weather', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 6 },
        },
        { type: 'message_stop' },
      ]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL, { stream: true }));
    assert.equal(response.finish_reason, 'tool_calls');
    assert.equal(response.tool_calls?.length, 1);
    assert.equal(response.tool_calls?.[0]?.id, 'toolu_5');
    assert.equal(response.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(response.tool_calls?.[0]?.function.arguments, '{"city":"Paris"}');
  });
});

describe('ClaudeProvider token lifecycle', () => {
  beforeEach(resetHome);

  it('force-refreshes once on a 401 and retries with the new token', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'stale-token', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { calls, fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) return oauthTokenOk('at-new');
      if (call.url === PROFILE_URL) return profileOk();
      if (headerOf(call.init, 'authorization') === 'Bearer stale-token') {
        return json({ type: 'error', error: { type: 'authentication_error' } }, 401);
      }
      return messagesSse(textStream(['after refresh']));
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'after refresh');
    assert.equal(refreshCalls(calls).length, 1);
    assert.equal(chatCalls(calls).length, 2);
  });

  it('persists rotated tokens after a successful refresh', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', refreshToken: 'rt-old', accountUuid: 'acc_1' }]);
    const { calls, fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) return oauthTokenOk('at-rotated');
      if (call.url === PROFILE_URL) return profileOk();
      return messagesSse(textStream(['ok']));
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'ok');
    assert.equal(refreshCalls(calls).length, 1);
    await runtime.waitForPersist();
    const pool = await runtime.getPool('claude');
    assert.equal(pool.accounts[0]?.payload.accessToken, 'at-rotated');
    assert.equal(pool.accounts[0]?.payload.refreshToken, 'rt-next');
  });

  it('does not replay a single-use refresh token after a network failure, and switches account', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', refreshToken: 'rt-1', accountUuid: 'acc_1' },
      { id: 'acc2', accessToken: 'AT-2', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_2' },
    ]);
    const { calls, fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) throw new TypeError('fetch failed');
      if (headerOf(call.init, 'authorization') === 'Bearer AT-2') {
        return messagesSse(textStream(['from acc2']));
      }
      return messagesSse(textStream(['unexpected']));
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'from acc2');
    // 单次性 refresh token：网络失败后绝不用同一 token 原地重试第二次刷新。
    assert.equal(refreshCalls(calls).length, 1);
    assert.equal(chatCalls(calls).length, 1);
    // 网络失败是「该账号本次失败」，不是永久失效：账号保持 active，仅被切走。
    const pool = await runtime.getPool('claude');
    assert.equal(pool.accounts.find((a) => a.id === 'acc1')?.status, 'active');
  });

  it('surfaces a refresh network failure as a non-fatal error without marking the account invalid', async () => {
    const runtime = newRuntime();
    const { runtime: spied, invalidCalls } = spyOnInvalid(runtime);
    await seed(runtime, [{ id: 'acc1', refreshToken: 'rt-1', accountUuid: 'acc_1' }]);
    const { fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) throw new TypeError('fetch failed');
      return messagesSse(textStream(['unexpected']));
    });
    const provider = makeProvider(fetchImpl, spied);

    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof ClaudeError);
      assert.equal(error.kind, 'network');
      return true;
    });
    assert.equal(
      invalidCalls.length,
      0,
      'a network refresh failure must not invalidate the account',
    );
  });

  it('marks the account invalid when the refresh reports a fatal error', async () => {
    const runtime = newRuntime();
    const { runtime: spied, invalidCalls } = spyOnInvalid(runtime);
    await seed(runtime, [{ id: 'acc1', refreshToken: 'rt-dead', accountUuid: 'acc_1' }]);
    const { fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) {
        return json({ error: 'invalid_grant', error_description: 'token revoked' }, 401);
      }
      return messagesSse(textStream(['unexpected']));
    });
    const provider = makeProvider(fetchImpl, spied);

    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof ClaudeError);
      assert.match(error.message, /失效/);
      return true;
    });
    assert.ok(
      invalidCalls.some((call) => call.platform === 'claude' && call.accountId === 'acc1'),
      'reportInvalid must be called for the dead account',
    );
    const pool = await runtime.getPool('claude');
    assert.equal(pool.accounts[0]?.status, 'invalid');
    assert.equal(runtime.hasActiveAccounts('claude'), false);
  });
});

describe('ClaudeProvider error matrix', () => {
  beforeEach(resetHome);

  it('surfaces 429 as a rate_limit error with resetAt from Retry-After', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { fetchImpl } = harness(
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const started = Date.now();
    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof ClaudeError);
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
      { id: 'acc1', accessToken: 'at-1', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
      { id: 'acc2', accessToken: 'at-2', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_2' },
    ]);
    const { calls, fetchImpl } = harness((call) => {
      if (headerOf(call.init, 'authorization') === 'Bearer at-1') {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
      }
      return messagesSse(textStream(['ok from acc2']));
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'ok from acc2');
    assert.equal(chatCalls(calls).length, 2);

    const cooldowns = runtime.listAccountCooldowns('claude', 'acc1');
    assert.equal(cooldowns.length, 1);
    assert.equal(cooldowns[0]?.model, MODEL);
  });

  it('never echoes a token from a 401 response body (token leak protection)', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    const { fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) return oauthTokenOk('at-new');
      if (call.url === PROFILE_URL) return profileOk();
      if (headerOf(call.init, 'authorization') === 'Bearer at-new') {
        return json({ type: 'error', error: { message: 'token=sk-FAKE is not valid' } }, 401);
      }
      return json({ type: 'error', error: { message: 'token rejected' } }, 401);
    });
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('sk-FAKE'), `leaked token: ${error.message}`);
      return true;
    });
    const usage = runtime.snapshotUsage('claude');
    for (const entry of usage) {
      assert.ok(!(entry.lastError ?? '').includes('sk-FAKE'));
    }
  });

  it('exposes hasCredentials from the active account pool', async () => {
    const runtime = newRuntime();
    const { fetchImpl } = harness(() => messagesSse(textStream(['x'])));
    const provider = makeProvider(fetchImpl, runtime);
    assert.equal(provider.hasCredentials(), false);

    await seed(runtime, [
      { id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY(), accountUuid: 'acc_1' },
    ]);
    assert.equal(provider.hasCredentials(), true);

    runtime.reportInvalid('claude', 'acc1');
    assert.equal(provider.hasCredentials(), false);
  });
});
