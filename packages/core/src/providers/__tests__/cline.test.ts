import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type { ChatRequest, StreamChunk } from '../../types.js';

const testHome = await mkdtemp(join(tmpdir(), 'freemodelfinder-cline-'));
process.env.FREEMODELFINDER_HOME = testHome;

const { createTestRuntime } = await import('../../credentials/runtime.js');
const { loadPools } = await import('../../credentials/credential-store.js');
const { ClineProvider, ClineError } = await import('../cline.js');
const { parseRateLimitError } = await import('../../router/auto-router.js');

type TestRuntime = ReturnType<typeof createTestRuntime>;

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

interface SeedAccount {
  id: string;
  accessToken?: string;
  expiresAt?: string;
  refreshToken?: string;
  originToken?: string;
  status?: 'active' | 'invalid';
}

const VALID_EXPIRY = () => new Date(Date.now() + 3_600_000).toISOString();

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
    const payload: Record<string, string> = {
      refreshToken: account.refreshToken ?? `rt-${account.id}`,
    };
    if (account.originToken) payload.originToken = account.originToken;
    if (account.accessToken) payload.accessToken = account.accessToken;
    if (account.expiresAt) payload.expiresAt = account.expiresAt;
    await runtime.upsertAccount('cline', {
      id: account.id,
      label: `${account.id}@example.com`,
      status: account.status ?? 'active',
      addedAt: Date.now(),
      payload,
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
  return calls.filter((call) => call.url.includes('/auth/refresh'));
}

function chatCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url.includes('/chat/completions'));
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

function chatOk(content = 'hello world'): Response {
  return json({
    id: 'chat-1',
    model: 'upstream-model',
    created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function refreshOk(accessToken = 'at-1', refreshToken = 'rt-next'): Response {
  return json({
    data: {
      accessToken,
      refreshToken,
      expiresAt: VALID_EXPIRY(),
      userInfo: { email: 'user@example.com' },
    },
  });
}

function rateLimited(retryAfter?: string, body = 'rate limited'): Response {
  return new Response(body, {
    status: 429,
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
  });
}

function deltaFrame(content: string, finish: string | null = null): Record<string, unknown> {
  return {
    id: 'stream-1',
    model: 'upstream-model',
    created: 1,
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  };
}

function sseResponse(
  frames: Array<Record<string, unknown>>,
  usage?: Record<string, number>,
): Response {
  const last = frames[frames.length - 1];
  if (usage && last && typeof last === 'object') (last as Record<string, unknown>).usage = usage;
  const payload =
    frames.map((frame) => `data: ${JSON.stringify(frame)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
}

function brokenStreamResponse(firstDelta: string): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(deltaFrame(firstDelta))}\n\n`));
        return;
      }
      controller.error(new Error('connection reset'));
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

function makeProvider(
  fetchImpl: typeof fetch,
  runtime: TestRuntime,
): InstanceType<typeof ClineProvider> {
  return new ClineProvider({
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

describe('ClineProvider token lifecycle', () => {
  beforeEach(resetHome);

  it('reuses a valid access token without hitting the refresh endpoint', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness(() => chatOk());
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req('z-ai/glm-5.3-flash'));
    assert.equal(response.content, 'hello world');
    assert.equal(refreshCalls(calls).length, 0);
    assert.equal(chatCalls(calls).length, 1);
  });

  it('refreshes once for concurrent chats (single-flight)', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1' }]);
    const { calls, fetchImpl } = harness((call) => {
      if (call.url.includes('/auth/refresh')) return refreshOk('at-fresh');
      if (headerOf(call.init, 'authorization') === 'Bearer workos:at-fresh') return chatOk();
      return json({ error: { message: 'unauthorized' } }, 401);
    });
    const provider = makeProvider(fetchImpl, runtime);

    const [first, second] = await Promise.all([
      provider.chat(req('z-ai/glm-5.3-flash')),
      provider.chat(req('z-ai/glm-5.3-flash')),
    ]);
    assert.equal(first.content, 'hello world');
    assert.equal(second.content, 'hello world');
    assert.equal(refreshCalls(calls).length, 1);
    assert.equal(chatCalls(calls).length, 2);
  });

  it('propagates refresh failure to concurrent chats without marking invalid', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1' }]);
    let refreshMode: 'fail' | 'ok' = 'fail';
    const { calls, fetchImpl } = harness((call) => {
      if (call.url.includes('/auth/refresh')) {
        return refreshMode === 'fail' ? json({ error: 'boom' }, 500) : refreshOk('at-late');
      }
      return chatOk();
    });
    const provider = makeProvider(fetchImpl, runtime);

    const results = await Promise.allSettled([
      provider.chat(req('z-ai/glm-5.3-flash')),
      provider.chat(req('z-ai/glm-5.3-flash')),
    ]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.match((result as PromiseRejectedResult).reason.message, /refresh failed 500/);
    }
    assert.equal(refreshCalls(calls).length, 1);

    const pool = await runtime.getPool('cline');
    assert.equal(pool.accounts[0]?.status, 'active');

    refreshMode = 'ok';
    const retried = await provider.chat(req('z-ai/glm-5.3-flash'));
    assert.equal(retried.content, 'hello world');
    assert.equal(refreshCalls(calls).length, 2);
  });

  it('marks the account invalid when refresh is rejected with 401', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1' }]);
    const { fetchImpl } = harness(() => json({ error: 'invalid_grant' }, 401));
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), /凭据失效|重新登录/);
    const pool = await runtime.getPool('cline');
    assert.equal(pool.accounts[0]?.status, 'invalid');
    assert.equal(runtime.hasActiveAccounts('cline'), false);
  });

  it('force-refreshes once on chat 401 and retries with the new token', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'stale-token', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness((call) => {
      if (call.url.includes('/auth/refresh')) return refreshOk('at-new');
      if (headerOf(call.init, 'authorization') === 'Bearer workos:stale-token') {
        return json({ error: { message: 'token expired' } }, 401);
      }
      return chatOk('after refresh');
    });
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req('z-ai/glm-5.3-flash'));
    assert.equal(response.content, 'after refresh');
    assert.equal(refreshCalls(calls).length, 1);
    assert.equal(chatCalls(calls).length, 2);
  });

  it('coalesces concurrent chat 401 force-refreshes into one refresh', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'stale-token', expiresAt: VALID_EXPIRY() }]);
    let refreshCount = 0;
    const { calls, fetchImpl } = harness((call) => {
      if (call.url.includes('/auth/refresh')) {
        refreshCount += 1;
        if (refreshCount > 1) return json({ error: 'invalid_grant' }, 401);
        return refreshOk('at-new');
      }
      if (headerOf(call.init, 'authorization') === 'Bearer workos:stale-token') {
        return json({ error: { message: 'token expired' } }, 401);
      }
      return chatOk('after refresh');
    });
    const provider = makeProvider(fetchImpl, runtime);

    const [first, second] = await Promise.all([
      provider.chat(req('z-ai/glm-5.3-flash')),
      provider.chat(req('z-ai/glm-5.3-flash')),
    ]);
    assert.equal(first.content, 'after refresh');
    assert.equal(second.content, 'after refresh');
    assert.equal(refreshCalls(calls).length, 1);

    const pool = await runtime.getPool('cline');
    assert.equal(pool.accounts[0]?.status, 'active');
  });

  it('does not count refresh failures as requests but keeps lastError', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1' }]);
    const { fetchImpl } = harness((call) =>
      call.url.includes('/auth/refresh') ? json({ error: 'boom' }, 500) : chatOk(),
    );
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), /refresh failed 500/);
    const usage = runtime.snapshotUsage('cline');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.requests, 0);
    assert.match(usage[0]?.lastError ?? '', /refresh failed 500/);
  });

  it('treats numeric expiresAt as epoch seconds like the auto-router', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      {
        id: 'a1',
        accessToken: 'at-1',
        expiresAt: String(Math.floor((Date.now() + 3_600_000) / 1000)),
      },
    ]);
    const { calls, fetchImpl } = harness(() => chatOk());
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req('z-ai/glm-5.3-flash'));
    assert.equal(response.content, 'hello world');
    assert.equal(refreshCalls(calls).length, 0);
    assert.equal(chatCalls(calls).length, 1);
  });

  it('redacts upstream bearer tokens from the bubbled 429 message and usage lastError', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness(() =>
      rateLimited('60', 'rate limited for Authorization: Bearer sk-secret-123'),
    );
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), (error: unknown) => {
      assert.ok(error instanceof ClineError);
      assert.match(error.message, /Bearer \[REDACTED\]/);
      assert.ok(!error.message.includes('sk-secret-123'));
      return true;
    });
    const usage = runtime.snapshotUsage('cline');
    assert.match(usage[0]?.lastError ?? '', /Bearer \[REDACTED\]/);
    assert.ok(!(usage[0]?.lastError ?? '').includes('sk-secret-123'));
  });

  it('persists a rotated refreshToken to disk', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', refreshToken: 'rt-old' }]);
    const { fetchImpl } = harness((call) =>
      call.url.includes('/auth/refresh') ? refreshOk('at-rotated', 'rt-rotated') : chatOk(),
    );
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(req('z-ai/glm-5.3-flash'));
    await runtime.waitForPersist();

    const pools = await loadPools();
    assert.equal(pools.cline?.accounts[0]?.payload.refreshToken, 'rt-rotated');
    assert.equal(pools.cline?.accounts[0]?.payload.accessToken, 'at-rotated');
  });

  it('keeps originToken untouched when a refresh rotates the refreshToken', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', refreshToken: 'rt-current', originToken: 'rt-original' }]);
    const { fetchImpl } = harness((call) =>
      call.url.includes('/auth/refresh') ? refreshOk('at-rotated', 'rt-rotated') : chatOk(),
    );
    const provider = makeProvider(fetchImpl, runtime);

    await provider.chat(req('z-ai/glm-5.3-flash'));
    await runtime.waitForPersist();

    const pools = await loadPools();
    assert.equal(pools.cline?.accounts[0]?.payload.refreshToken, 'rt-rotated');
    assert.equal(pools.cline?.accounts[0]?.payload.originToken, 'rt-original');
  });

  it('exposes hasCredentials from the active account pool', async () => {
    const runtime = newRuntime();
    const { fetchImpl } = harness(() => chatOk());
    const provider = makeProvider(fetchImpl, runtime);
    assert.equal(provider.hasCredentials(), false);

    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    assert.equal(provider.hasCredentials(), true);

    runtime.reportInvalid('cline', 'a1');
    assert.equal(provider.hasCredentials(), false);
  });
});

describe('ClineProvider error matrix', () => {
  beforeEach(resetHome);

  it('cools the account on 429 and switches to the next account', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { calls, fetchImpl } = harness((call) => {
      if (headerOf(call.init, 'authorization') === 'Bearer workos:at-a1') {
        return rateLimited('120');
      }
      return chatOk('ok from a2');
    });
    const provider = makeProvider(fetchImpl, runtime);

    const model = 'z-ai/glm-5.3-flash';
    const response = await provider.chat(req(model));
    assert.equal(response.content, 'ok from a2');
    assert.equal(chatCalls(calls).length, 2);

    const before = Date.now();
    const cooldowns = runtime.listAccountCooldowns('cline', 'a1');
    assert.equal(cooldowns.length, 1);
    assert.equal(cooldowns[0]?.model, model);
    expectInRange(cooldowns[0]?.resetAt, before + 118_000, before + 123_000, 'retry-after tier');

    await provider.chat(req(model));
    assert.equal(chatCalls(calls).length, 3);
    const second = chatCalls(calls)[2];
    assert.equal(headerOf(second?.init, 'authorization'), 'Bearer workos:at-a2');
  });

  it('parses 429 reset tiers: header > resets_at > text duration > midnight > fallback', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const cases: Array<{
      model: string;
      make: () => Response;
      expect: (before: number, after: number) => number | [number, number];
    }> = [
      {
        model: 't-header',
        make: () =>
          new Response(
            JSON.stringify({
              error: { resets_at: new Date(Date.now() + 3_600_000).toISOString() },
            }),
            { status: 429, headers: { 'retry-after': '60' } },
          ),
        expect: (before, after) => [after + 58_000, after + 63_000] as [number, number],
      },
      {
        model: 't-resets',
        make: () =>
          json({ error: { resets_at: new Date(Date.now() + 3_600_000).toISOString() } }, 429),
        expect: (before) => [before + 3_540_000, before + 3_660_000] as [number, number],
      },
      {
        model: 't-text',
        make: () => json({ error: 'rate limit exceeded, try again in 2h 30m' }, 429),
        expect: (before) => [before + 8_940_000, before + 9_060_000] as [number, number],
      },
      {
        model: 't-midnight',
        make: () => json({ error: 'free limit reached on model z-ai/glm-5.3-flash' }, 429),
        expect: (_before, after) => {
          const d = new Date(after);
          const midnight = new Date(
            d.getFullYear(),
            d.getMonth(),
            d.getDate() + 1,
            0,
            0,
            0,
            0,
          ).getTime();
          return [midnight - 1_000, midnight + 1_000] as [number, number];
        },
      },
      {
        model: 't-cap',
        make: () => json({ error: 'rate limit, try again in 48 hours' }, 429),
        expect: (before) =>
          [before + 86_400_000 - 60_000, before + 86_400_000 + 60_000] as [number, number],
      },
      {
        model: 't-fallback',
        make: () => json({ error: 'slow down' }, 429),
        expect: (before) => [before + 295_000, before + 305_000] as [number, number],
      },
    ];
    const { fetchImpl } = harness((call) => {
      const body = bodyOf(call.init);
      const testCase = cases.find(
        (candidate) => typeof body.model === 'string' && body.model === candidate.model,
      );
      return testCase ? testCase.make() : chatOk();
    });
    const provider = makeProvider(fetchImpl, runtime);

    for (const testCase of cases) {
      const before = Date.now();
      await assert.rejects(provider.chat(req(testCase.model)), /failed 429/);
      const after = Date.now();
      const cooldown = runtime
        .listAccountCooldowns('cline', 'a1')
        .find((entry) => entry.model === testCase.model);
      const expected = testCase.expect(before, after);
      if (typeof expected === 'number') {
        expectInRange(cooldown?.resetAt, expected, expected, testCase.model);
      } else {
        expectInRange(cooldown?.resetAt, expected[0], expected[1], testCase.model);
      }
    }
  });

  it('throws a pool-exhausted 429 that parseRateLimitError understands', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness(() => rateLimited('90'));
    const provider = makeProvider(fetchImpl, runtime);

    const started = Date.now();
    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), (error: unknown) => {
      const parsed = parseRateLimitError(error);
      assert.equal(parsed.isRateLimit, true);
      expectInRange(parsed.resetAt, started + 85_000, started + 95_000, 'parsed resetAt');
      return true;
    });
  });

  it('falls back to the 60s parser default when upstream omits reset info', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness(() => rateLimited(undefined, 'slow down'));
    const provider = makeProvider(fetchImpl, runtime);

    const started = Date.now();
    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), (error: unknown) => {
      const parsed = parseRateLimitError(error);
      assert.equal(parsed.isRateLimit, true);
      expectInRange(parsed.resetAt, started + 55_000, started + 65_000, 'default resetAt');
      return true;
    });
  });

  it('marks the account invalid on 403 and switches accounts', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { calls, fetchImpl } = harness((call) =>
      headerOf(call.init, 'authorization') === 'Bearer workos:at-a1'
        ? json({ error: { message: 'forbidden' } }, 403)
        : chatOk('ok from a2'),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req('z-ai/glm-5.3-flash'));
    assert.equal(response.content, 'ok from a2');
    assert.equal(chatCalls(calls).length, 2);

    const pool = await runtime.getPool('cline');
    assert.equal(pool.accounts.find((account) => account.id === 'a1')?.status, 'invalid');
    assert.equal(pool.accounts.find((account) => account.id === 'a2')?.status, 'active');
  });

  it('does not switch accounts on 400', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { calls, fetchImpl } = harness(() => json({ error: { message: 'model unknown' } }, 400));
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), /failed 400/);
    assert.equal(chatCalls(calls).length, 1);

    const pool = await runtime.getPool('cline');
    assert.equal(pool.accounts.find((account) => account.id === 'a1')?.status, 'active');
    assert.equal(pool.accounts.find((account) => account.id === 'a2')?.lastUsedAt, undefined);
  });

  it('caps account switches at min(pool size, 3)', async () => {
    const runtime = newRuntime();
    await seed(
      runtime,
      Array.from({ length: 5 }, (_, index) => ({
        id: `a${index + 1}`,
        accessToken: `at-a${index + 1}`,
        expiresAt: VALID_EXPIRY(),
      })),
    );
    const { calls, fetchImpl } = harness(() => rateLimited('30'));
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), /failed 429/);
    assert.equal(chatCalls(calls).length, 4);

    const pool = await runtime.getPool('cline');
    for (const account of pool.accounts) {
      const cooled = runtime
        .listAccountCooldowns('cline', account.id)
        .some((entry) => entry.model === 'z-ai/glm-5.3-flash');
      if (account.id === 'a5') {
        assert.equal(cooled, false, 'the 5th account must stay untouched');
      } else {
        assert.equal(cooled, true, `${account.id} should be cooling`);
      }
    }
  });

  it('stops after trying each account once when the whole pool is rate limited', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { calls, fetchImpl } = harness(() => rateLimited('30'));
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), (error: unknown) => {
      assert.equal(parseRateLimitError(error).isRateLimit, true);
      return true;
    });
    assert.equal(chatCalls(calls).length, 2);
  });

  it('composes a parseable 429 when every account is already cooling', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness(() => rateLimited('60'));
    const provider = makeProvider(fetchImpl, runtime);

    const model = 'z-ai/glm-5.3-flash';
    await assert.rejects(provider.chat(req(model)), /failed 429/);
    assert.equal(chatCalls(calls).length, 1);

    const secondAttempt = Date.now();
    await assert.rejects(provider.chat(req(model)), (error: unknown) => {
      const parsed = parseRateLimitError(error);
      assert.equal(parsed.isRateLimit, true);
      expectInRange(
        parsed.resetAt,
        secondAttempt + 55_000,
        secondAttempt + 65_000,
        'cooling reset',
      );
      return true;
    });
    assert.equal(chatCalls(calls).length, 1, 'no upstream call while all accounts cool');
  });

  it('switches accounts on network errors and 5xx responses', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);

    const network = harness((call) => {
      if (headerOf(call.init, 'authorization') === 'Bearer workos:at-a1') {
        throw new TypeError('network down');
      }
      return chatOk('after network error');
    });
    const provider = makeProvider(network.fetchImpl, runtime);
    const first = await provider.chat(req('z-ai/glm-5.3-flash'));
    assert.equal(first.content, 'after network error');
    assert.equal(chatCalls(network.calls).length, 2);

    const server = harness((call) =>
      headerOf(call.init, 'authorization') === 'Bearer workos:at-a1'
        ? json({ error: { message: 'upstream exploded' } }, 500)
        : chatOk('after 5xx'),
    );
    const second = await makeProvider(server.fetchImpl, runtime).chat(req('z-ai/glm-5.3-flash'));
    assert.equal(second.content, 'after 5xx');
    assert.equal(chatCalls(server.calls).length, 2);
  });

  it('fails fast without an active account pool', async () => {
    const runtime = newRuntime();
    const { fetchImpl } = harness(() => chatOk());
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), /has no available credentials/);
    assert.equal(chatCalls([]).length, 0);
  });

  it('attaches platform, masked account id and model to rate limit errors', async () => {
    const runtime = newRuntime();
    const accountId = 'acct-0123456789abcdef';
    await seed(runtime, [{ id: accountId, accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness(() => rateLimited('90'));
    const provider = makeProvider(fetchImpl, runtime);

    const model = 'z-ai/glm-5.3-flash';
    await assert.rejects(provider.chat(req(model)), (error: unknown) => {
      assert.ok(error instanceof ClineError);
      assert.equal(error.platform, 'cline');
      assert.equal(error.accountId, accountId.slice(0, 8));
      assert.notEqual(error.accountId, accountId);
      assert.equal(error.model, model);
      assert.equal(error.status, 429);
      assert.equal(typeof error.resetAt, 'number');
      return true;
    });
  });

  it('attaches context to fatal upstream errors', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness(() => json({ error: { message: 'model unknown' } }, 400));
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), (error: unknown) => {
      assert.ok(error instanceof ClineError);
      assert.equal(error.platform, 'cline');
      assert.equal(error.accountId, 'a1');
      assert.equal(error.model, 'z-ai/glm-5.3-flash');
      assert.equal(error.status, 400);
      return true;
    });
  });

  it('counts every failed upstream attempt once and writes lastError', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { fetchImpl } = harness((call) =>
      headerOf(call.init, 'authorization') === 'Bearer workos:at-a1'
        ? rateLimited('120')
        : chatOk('ok from a2'),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req('z-ai/glm-5.3-flash'));
    assert.equal(response.content, 'ok from a2');

    const usage = runtime.snapshotUsage('cline');
    const byAccount = new Map(usage.map((entry) => [entry.accountId, entry]));
    assert.equal(byAccount.get('a1')?.requests, 1);
    assert.match(byAccount.get('a1')?.lastError ?? '', /failed 429/);
    assert.equal(byAccount.get('a2')?.requests, 1);
    assert.equal(byAccount.get('a2')?.lastError, undefined);
  });

  it('counts fatal failures before rethrowing without switching', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { calls, fetchImpl } = harness(() => json({ error: { message: 'model unknown' } }, 400));
    const provider = makeProvider(fetchImpl, runtime);

    await assert.rejects(provider.chat(req('z-ai/glm-5.3-flash')), /failed 400/);
    assert.equal(chatCalls(calls).length, 1);

    const usage = runtime.snapshotUsage('cline');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.accountId, 'a1');
    assert.equal(usage[0]?.requests, 1);
    assert.match(usage[0]?.lastError ?? '', /failed 400/);
  });

  it('cools the account 30s and switches when upstream returns empty content', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { calls, fetchImpl } = harness((call) =>
      headerOf(call.init, 'authorization') === 'Bearer workos:at-a1'
        ? json({
            id: 'chat-1',
            created: 1,
            choices: [{ index: 0, message: { role: 'assistant', content: '' } }],
          })
        : chatOk('ok from a2'),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const model = 'z-ai/glm-5.3-flash';
    const before = Date.now();
    const response = await provider.chat(req(model));
    const after = Date.now();
    assert.equal(response.content, 'ok from a2');
    assert.equal(chatCalls(calls).length, 2);

    const cooldown = runtime.listAccountCooldowns('cline', 'a1');
    assert.equal(cooldown.length, 1);
    assert.equal(cooldown[0]?.model, model);
    expectInRange(cooldown[0]?.resetAt, before + 29_000, after + 31_000, 'empty cooldown');

    const usage = runtime.snapshotUsage('cline');
    const a1 = usage.find((entry) => entry.accountId === 'a1');
    assert.equal(a1?.requests, 1);
    assert.match(a1?.lastError ?? '', /empty content/);
  });

  it('bubbles an empty-content error when every account returns empty', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness(() => sseResponse([deltaFrame('')]));
    const provider = makeProvider(fetchImpl, runtime);

    const before = Date.now();
    await assert.rejects(provider.chat(req('cline-free/deepseek-v4.1-flash')), /empty content/);
    const after = Date.now();
    assert.equal(chatCalls(calls).length, 1);

    const cooldown = runtime.listAccountCooldowns('cline', 'a1');
    assert.equal(cooldown.length, 1);
    expectInRange(
      cooldown[0]?.resetAt,
      before + 29_000,
      after + 31_000,
      'empty cooldown single account',
    );
  });
});

describe('ClineProvider chat and stream fixtures', () => {
  beforeEach(resetHome);

  it('sends the Cline fingerprint, session id and no max_tokens on non-streaming chat', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness(() =>
      json({
        data: {
          id: 'chat-1',
          model: 'upstream-model',
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello world' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req('z-ai/glm-5.3-flash', { max_tokens: 999 }));
    assert.equal(response.content, 'hello world');
    assert.equal(response.usage?.total_tokens, 15);

    const call = chatCalls(calls)[0];
    const body = bodyOf(call?.init);
    assert.equal('max_tokens' in body, false);
    assert.equal(body.stream, undefined);
    assert.equal(body.model, 'z-ai/glm-5.3-flash');
    assert.equal(body.reasoning_effort, 'high');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(typeof body.session_id, 'string');
    assert.equal(headerOf(call?.init, 'authorization'), 'Bearer workos:at-1');
    assert.equal(headerOf(call?.init, 'user-agent'), 'Cline/3.0.47');
    assert.equal(headerOf(call?.init, 'x-client-type'), 'cline-sdk');
    assert.equal(headerOf(call?.init, 'x-platform'), 'terminal');
    assert.equal(headerOf(call?.init, 'x-task-id'), body.session_id);

    const usage = runtime.snapshotUsage('cline');
    assert.equal(usage[0]?.requests, 1);
    assert.equal(usage[0]?.promptTokens, 10);
    assert.equal(usage[0]?.completionTokens, 5);
  });

  it('forces SSE aggregation for deepseek/cline-free models in non-streaming chat', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness(() =>
      sseResponse([deltaFrame('hello '), deltaFrame('world', 'stop')], {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
      }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req('cline-free/deepseek-v4.1-flash'));
    assert.equal(response.content, 'hello world');
    assert.equal(response.finish_reason, 'stop');
    assert.equal(response.usage?.total_tokens, 10);

    const call = chatCalls(calls)[0];
    assert.equal(bodyOf(call?.init).stream, true);
    const usage = runtime.snapshotUsage('cline');
    assert.equal(usage[0]?.promptTokens, 7);
    assert.equal(usage[0]?.completionTokens, 3);
  });

  it('falls back to reasoning when upstream content is empty', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { fetchImpl } = harness(() =>
      json({
        id: 'chat-1',
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning: 'thinking hard' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const response = await provider.chat(req('z-ai/glm-5.3-flash'));
    assert.equal(response.content, 'thinking hard');
  });

  it('streams deltas with the same fingerprint headers and records usage', async () => {
    const runtime = newRuntime();
    await seed(runtime, [{ id: 'a1', accessToken: 'at-1', expiresAt: VALID_EXPIRY() }]);
    const { calls, fetchImpl } = harness(() =>
      sseResponse([deltaFrame('hello '), deltaFrame('world', 'stop')], {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      }),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(req('z-ai/glm-5.3-flash', { stream: true }))) {
      chunks.push(chunk);
    }
    assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'hello world');
    assert.equal(chunks[chunks.length - 1]?.finish_reason, 'stop');

    const call = chatCalls(calls)[0];
    const body = bodyOf(call?.init);
    assert.equal(body.stream, true);
    assert.equal(headerOf(call?.init, 'authorization'), 'Bearer workos:at-1');
    assert.equal(headerOf(call?.init, 'x-task-id'), body.session_id);

    const usage = runtime.snapshotUsage('cline');
    assert.equal(usage[0]?.requests, 1);
    assert.equal(usage[0]?.promptTokens, 4);
  });

  it('switches accounts when the stream fails to open, but never mid-stream', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { calls, fetchImpl } = harness((call) =>
      headerOf(call.init, 'authorization') === 'Bearer workos:at-a1'
        ? rateLimited('30')
        : sseResponse([deltaFrame('recovered', 'stop')]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream(req('z-ai/glm-5.3-flash', { stream: true }))) {
      chunks.push(chunk);
    }
    assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'recovered');
    assert.equal(chatCalls(calls).length, 2);
  });

  it('propagates mid-stream breaks without switching or marking invalid', async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { id: 'a1', accessToken: 'at-a1', expiresAt: VALID_EXPIRY() },
      { id: 'a2', accessToken: 'at-a2', expiresAt: VALID_EXPIRY() },
    ]);
    const { calls, fetchImpl } = harness((call) =>
      headerOf(call.init, 'authorization') === 'Bearer workos:at-a1'
        ? brokenStreamResponse('partial ')
        : sseResponse([deltaFrame('never reached', 'stop')]),
    );
    const provider = makeProvider(fetchImpl, runtime);

    const chunks: StreamChunk[] = [];
    await assert.rejects(async () => {
      for await (const chunk of provider.stream(req('z-ai/glm-5.3-flash', { stream: true }))) {
        chunks.push(chunk);
      }
    }, /connection reset/);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.delta, 'partial ');
    assert.equal(chatCalls(calls).length, 1, 'mid-stream failure must not switch accounts');

    const pool = await runtime.getPool('cline');
    assert.equal(pool.accounts.find((account) => account.id === 'a1')?.status, 'active');
    assert.equal(runtime.listAccountCooldowns('cline', 'a1').length, 0);

    const usage = runtime.snapshotUsage('cline');
    assert.equal(usage[0]?.accountId, 'a1');
    assert.equal(usage[0]?.requests, 1);
    assert.match(usage[0]?.lastError ?? '', /connection reset/);
  });

  it('returns the built-in catalog without touching the network', async () => {
    const runtime = newRuntime();
    const { fetchImpl } = harness(() => {
      throw new Error('network must not be used');
    });
    const provider = makeProvider(fetchImpl, runtime);

    const models = await provider.listModels();
    assert.deepEqual(
      models.map((model) => model.id),
      [
        'cline:cline-free/deepseek-v4.1-flash',
        'cline:deepseek/deepseek-v4-flash',
        'cline:z-ai/glm-5.3-flash',
        'cline:poolside/laguna-s-2.1:free',
      ],
    );
    assert.deepEqual(
      models.map((model) => model.displayName),
      [
        'cline-free/deepseek-v4.1-flash',
        'deepseek/deepseek-v4-flash',
        'z-ai/glm-5.3-flash',
        'poolside/laguna-s-2.1:free',
      ],
    );
    assert.ok(models.every((model) => model.provider === 'cline'));
    assert.ok(models.every((model) => model.free === true));
  });
});
