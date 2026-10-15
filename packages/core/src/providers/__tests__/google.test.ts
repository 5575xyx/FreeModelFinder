import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { ChatRequest, StreamChunk } from '../../types.js';
import type { CredentialRuntime } from '../../credentials/runtime.js';

const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-google-'));
process.env.FREEMODELFINDER_HOME = testHome;

const { createTestRuntime } = await import('../../credentials/runtime.js');
const { GoogleProvider, GoogleError } = await import('../google.js');
const { GOOGLE_CATALOG_MODELS } = await import('../google-catalog.js');
const { parseRateLimitError } = await import('../../router/auto-router.js');

type TestRuntime = ReturnType<typeof createTestRuntime>;

/**
 * 协议常量对照参考实现 CLIProxyAPI：
 * - loadCodeAssist：`https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`
 *   （sdk/auth/antigravity/constants.go:29-31 + auth.go:260；
 *   antigravity_executor_buildrequest_test.go:271）
 * - 流式生成：`https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`
 *   —— 消费级凭据默认走 daily 端点（`resolveAntigravityRequestBaseURL`，
 *   antigravity_executor_request.go:439-446；常量 antigravity_executor.go:35-40；
 *   默认断言 antigravity_executor_buildrequest_test.go:16-28）；`?alt=sse` 见
 *   antigravity_executor_request.go:43-49 与 interactions_test.go:22-26。
 */
const LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const STREAM_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VALID_EXPIRY = () => String(Date.now() + 3_600_000);
const EXPIRED_EXPIRY = () => String(Date.now() - 1_000);

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

interface SeedAccount {
  id: string;
  accessToken?: string;
  expiresAt?: string;
  refreshToken?: string;
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
    await runtime.upsertAccount('google', {
      id: account.id,
      label: `${account.id}@example.com`,
      status: 'active',
      addedAt: Date.now(),
      payload: {
        refreshToken: account.refreshToken ?? `rt-${account.id}`,
        clientId: 'cid.apps.googleusercontent.com',
        clientSecret: 'csec',
        accessToken: account.accessToken ?? '',
        expiresAt: account.expiresAt ?? '',
        scope: '',
        idToken: '',
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

function loadCodeAssistCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url === LOAD_CODE_ASSIST_URL);
}

function chatCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url.startsWith(STREAM_URL));
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
  return json({ access_token: accessToken, expires_in: 3600, token_type: 'Bearer' });
}

function loadCodeAssistOk(projectId = 'proj-1'): Response {
  return json({ cloudaicompanionProject: projectId });
}

/**
 * Gemini 风格 SSE：cloudcode-pa 把候选包在顶层 `response` 里
 * （antigravity_executor_interactions_test.go:34），usage 读取同时兼容
 * `response.usageMetadata` / 顶层 `usageMetadata`（helps/usage_helpers.go:1430-1446）。
 */
function geminiSse(frames: Array<Record<string, unknown>>): Response {
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
}

function textFrame(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    response: { candidates: [{ content: { role: 'model', parts: [{ text }] } }] },
    ...extra,
  };
}

function makeProvider(
  fetchImpl: typeof fetch,
  runtime: CredentialRuntime,
): InstanceType<typeof GoogleProvider> {
  return new GoogleProvider({
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

const MODEL = 'gemini-3-flash';

describe('GoogleProvider listModels', () => {
  it('prefixes every id with google: and marks free + subscription', async () => {
    const runtime = newRuntime();
    const { calls, fetchImpl } = harness(() => json({}));
    const provider = makeProvider(fetchImpl, runtime);

    const models = await provider.listModels();
    assert.ok(models.length > 0);
    assert.equal(models.length, GOOGLE_CATALOG_MODELS.length);
    for (const model of models) {
      assert.ok(model.id.startsWith('google:'), `${model.id} must carry the google: prefix`);
      assert.equal(model.provider, 'google');
      assert.equal(model.free, true);
      assert.equal(model.subscription, true);
      assert.equal(typeof model.displayName, 'string');
      assert.deepEqual(model.capabilities, ['text']);
    }
    // listModels 是纯静态目录：不得产生任何网络请求。
    assert.equal(calls.length, 0);
  });
});

describe('GoogleProvider session initialization', () => {
  beforeEach(resetHome);

  it('calls loadCodeAssist once and reuses the project id on later requests', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness((call) =>
      call.url === LOAD_CODE_ASSIST_URL ? loadCodeAssistOk('proj-1') : geminiSse([textFrame('ok')]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(req(MODEL));
    await provider.chat(req(MODEL));

    assert.equal(loadCodeAssistCalls(calls).length, 1);
    assert.equal(chatCalls(calls).length, 2);
    // 每次生成请求都携带初始化得到的项目 id。
    for (const call of chatCalls(calls)) {
      assert.equal(bodyOf(call.init).project, 'proj-1');
    }
    // 项目 id 落盘到账号 payload（对应参考实现把 project_id 写回 auth metadata）。
    await runtime.waitForPersist();
    const pool = await runtime.getPool('google');
    assert.equal(pool.accounts[0]?.payload.projectId, 'proj-1');
  });

  it('sends the reference loadCodeAssist body and headers', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness((call) =>
      call.url === LOAD_CODE_ASSIST_URL ? loadCodeAssistOk() : geminiSse([textFrame('ok')]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(req(MODEL));

    const call = loadCodeAssistCalls(calls)[0];
    assert.ok(call);
    assert.equal(call.init?.method, 'POST');
    assert.equal(headerOf(call.init, 'Authorization'), 'Bearer AT');
    assert.equal(headerOf(call.init, 'Content-Type'), 'application/json');
    assert.equal(headerOf(call.init, 'Accept'), '*/*');
    assert.match(headerOf(call.init, 'User-Agent') ?? '', /^antigravity\/hub\//);
    assert.deepEqual(bodyOf(call.init), { metadata: { ideType: 'ANTIGRAVITY' } });
  });
});

describe('GoogleProvider request translation', () => {
  beforeEach(resetHome);

  it('posts the Gemini request body to the cloudcode-pa stream path with alt=sse', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness((call) =>
      call.url === LOAD_CODE_ASSIST_URL ? loadCodeAssistOk() : geminiSse([textFrame('pong')]),
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
    assert.equal(call.url, STREAM_URL);
    assert.equal(call.init?.method, 'POST');
    assert.equal(headerOf(call.init, 'Authorization'), 'Bearer AT');
    assert.equal(headerOf(call.init, 'Content-Type'), 'application/json');
    const body = bodyOf(call.init);
    assert.equal(body.model, MODEL);
    assert.equal(body.userAgent, 'antigravity');
    assert.equal(body.requestType, 'agent');
    assert.equal(typeof body.requestId, 'string');
    const inner = body.request as Record<string, unknown>;
    assert.deepEqual(inner.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
    assert.deepEqual(inner.systemInstruction, { parts: [{ text: 'You are terse.' }] });
    assert.equal(typeof inner.sessionId, 'string');
  });

  it('translates tools and tool_choice into request.tools + request.toolConfig', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness((call) =>
      call.url === LOAD_CODE_ASSIST_URL ? loadCodeAssistOk() : geminiSse([textFrame('ok')]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(
      req(MODEL, {
        tool_choice: 'required',
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

    const inner = bodyOf(chatCalls(calls)[0]?.init).request as Record<string, unknown>;
    assert.deepEqual(inner.tools, [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    ]);
    assert.deepEqual(inner.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  });
});

describe('GoogleProvider chat + stream', () => {
  beforeEach(resetHome);

  it('aggregates the Gemini SSE stream into a ChatResponse with mapped usage', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness((call) =>
      call.url === LOAD_CODE_ASSIST_URL
        ? loadCodeAssistOk()
        : geminiSse([
            textFrame('hello '),
            textFrame('world'),
            {
              response: {
                candidates: [
                  { content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' },
                ],
                usageMetadata: {
                  promptTokenCount: 12,
                  candidatesTokenCount: 34,
                  totalTokenCount: 46,
                  cachedContentTokenCount: 5,
                },
              },
            },
          ]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'hello world');
    assert.equal(response.finish_reason, 'stop');
    assert.equal(response.rawProtocol, 'gemini');
    assert.equal(response.usage?.prompt_tokens, 12);
    assert.equal(response.usage?.completion_tokens, 34);
    assert.equal(response.usage?.total_tokens, 46);
    assert.equal(response.usage?.prompt_tokens_details?.cached_tokens, 5);
  });

  it('yields stream chunks whose deltas join to the full text and finish with usage', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness((call) =>
      call.url === LOAD_CODE_ASSIST_URL
        ? loadCodeAssistOk()
        : geminiSse([
            textFrame('Hel'),
            textFrame('lo '),
            textFrame('世界'),
            {
              response: {
                candidates: [{ finishReason: 'STOP' }],
                usageMetadata: {
                  promptTokenCount: 3,
                  candidatesTokenCount: 4,
                  totalTokenCount: 7,
                },
              },
            },
          ]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(req(MODEL))) {
      chunks.push(chunk);
    }
    assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'Hello 世界');
    for (const chunk of chunks) {
      assert.equal(chunk.model, MODEL);
      assert.equal(chunk.rawProtocol, 'gemini');
    }
    const last = chunks[chunks.length - 1];
    assert.equal(last?.finish_reason, 'stop');
    assert.equal(last?.usage?.total_tokens, 7);
  });

  it('merges functionCall parts into tool_calls and maps thought parts to reasoning', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness((call) =>
      call.url === LOAD_CODE_ASSIST_URL
        ? loadCodeAssistOk()
        : geminiSse([
            {
              response: {
                candidates: [
                  { content: { role: 'model', parts: [{ text: 'weighing', thought: true }] } },
                ],
              },
            },
            {
              response: {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [
                        {
                          functionCall: {
                            id: 'call_1',
                            name: 'get_weather',
                            args: { city: 'Paris' },
                          },
                        },
                      ],
                    },
                    finishReason: 'STOP',
                  },
                ],
              },
            },
          ]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.reasoning, 'weighing');
    assert.equal(response.finish_reason, 'tool_calls');
    assert.equal(response.tool_calls?.length, 1);
    assert.equal(response.tool_calls?.[0]?.id, 'call_1');
    assert.equal(response.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(response.tool_calls?.[0]?.function.arguments, '{"city":"Paris"}');
  });
});

describe('GoogleProvider token lifecycle', () => {
  beforeEach(resetHome);

  it('force-refreshes once on chat 401 and retries with the new token', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'stale-token', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) return oauthTokenOk('at-new');
      if (call.url === LOAD_CODE_ASSIST_URL) return loadCodeAssistOk();
      if (headerOf(call.init, 'authorization') === 'Bearer stale-token') {
        return json({ error: { code: 401, message: 'token expired' } }, 401);
      }
      return geminiSse([textFrame('after refresh')]);
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'after refresh');
    assert.equal(refreshCalls(calls).length, 1);
    assert.equal(chatCalls(calls).length, 2);
    assert.equal(headerOf(chatCalls(calls)[1]?.init, 'Authorization'), 'Bearer at-new');
  });

  it('reuses the (unrotated) refresh token and sends the rotated access token after a 401', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      {
        id: 'acc1',
        accessToken: 'at-old',
        expiresAt: EXPIRED_EXPIRY(),
        refreshToken: 'rt-old',
      },
    ]);
    const sentRefreshTokens: string[] = [];
    let refreshes = 0;
    let chatHits = 0;
    const { calls, fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) {
        sentRefreshTokens.push(
          new URLSearchParams(String(call.init?.body ?? '')).get('refresh_token') ?? '',
        );
        refreshes += 1;
        return oauthTokenOk(`at-${refreshes}`);
      }
      if (call.url === LOAD_CODE_ASSIST_URL) return loadCodeAssistOk();
      chatHits += 1;
      if (chatHits === 1) return json({ error: { code: 401 } }, 401);
      return geminiSse([textFrame('after refresh')]);
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req(MODEL));
    assert.equal(response.content, 'after refresh');
    // Google 不轮换 refresh token（adapters/subscription/google.ts:188-189）：两次刷新都发 rt-old，
    // 但第二次 chat 必须用新拿到的 at-2，而不是复用被拒的 at-1。
    assert.deepEqual(sentRefreshTokens, ['rt-old', 'rt-old']);
    assert.equal(refreshCalls(calls).length, 2);
    assert.equal(chatCalls(calls).length, 2);
    assert.equal(headerOf(chatCalls(calls)[1]?.init, 'Authorization'), 'Bearer at-2');
  });

  it('marks the account invalid when the refresh reports invalid_grant', async () => {
    const runtime = newRuntime();
    const { runtime: spied, invalidCalls } = spyOnInvalid(runtime);
    await seed(runtime, [
      { id: 'acc1', accessToken: 'at-old', expiresAt: EXPIRED_EXPIRY(), refreshToken: 'rt-dead' },
    ]);
    const { fetchImpl } = harness(() =>
      json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked' }, 400),
    );
    const provider = makeProvider(fetchImpl, spied);

    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof GoogleError);
      assert.match(error.message, /失效/);
      return true;
    });
    assert.ok(
      invalidCalls.some((call) => call.platform === 'google' && call.accountId === 'acc1'),
      'reportInvalid must be called for the dead account',
    );
    const pool = await runtime.getPool('google');
    assert.equal(pool.accounts[0]?.status, 'invalid');
    assert.equal(runtime.hasActiveAccounts('google'), false);
  });
});

describe('GoogleProvider error matrix', () => {
  beforeEach(resetHome);

  it('surfaces 429 as a rate_limit error with resetAt from Retry-After', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness((call) =>
      call.url === LOAD_CODE_ASSIST_URL
        ? loadCodeAssistOk()
        : new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const started = Date.now();
    await assert.rejects(provider.chat(req(MODEL)), (error: unknown) => {
      assert.ok(error instanceof GoogleError);
      assert.equal(error.kind, 'rate_limit');
      assert.equal(error.status, 429);
      assert.ok(
        error.resetAt !== undefined &&
          error.resetAt >= started + 28_000 &&
          error.resetAt <= started + 33_000,
        `resetAt out of range: ${error.resetAt}`,
      );
      assert.equal(parseRateLimitError(error).isRateLimit, true);
      return true;
    });
  });

  it('never echoes a token from a 401 response body (token leak protection)', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness((call) => {
      if (call.url === TOKEN_URL) return oauthTokenOk('at-new');
      if (call.url === LOAD_CODE_ASSIST_URL) return loadCodeAssistOk();
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
    const usage = runtime.snapshotUsage('google');
    for (const entry of usage) {
      assert.ok(!(entry.lastError ?? '').includes('sk-FAKE'));
    }
  });

  it('exposes hasCredentials from the active account pool', async () => {
    const runtime = newRuntime();
    const { fetchImpl } = harness(() => geminiSse([textFrame('x')]));
    const provider = makeProvider(fetchImpl, runtime);
    assert.equal(provider.hasCredentials(), false);

    await seed(runtime, [{ id: 'acc1', accessToken: 'AT', expiresAt: VALID_EXPIRY() }]);
    assert.equal(provider.hasCredentials(), true);

    runtime.reportInvalid('google', 'acc1');
    assert.equal(provider.hasCredentials(), false);
  });
});
