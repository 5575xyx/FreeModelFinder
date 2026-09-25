# Auto 全量候选 Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** auto 请求失败后按分数降序逐个尝试全部候选直到成功；不可用模型进程内永久剔除，限流冷却到期回池，候选穷尽才报错。

**Architecture:** core `AutoRouter` 新增 `rankCandidates()` 全量排序快照 + `markModelUnavailable` 改永久（`resetAt=Infinity` 复用现有 cooldowns 过滤/gc/诊断）；server `openai.ts` 用 `classifyFailure` 统一分类，流式/非流式共享 `advanceFailover` 游标推进，穷尽抛 `CandidatesExhaustedError`（503/SSE error envelope 带分类摘要）。

**Tech Stack:** TypeScript, node:test, tsup, vitest (ui)。Spec: `docs/superpowers/specs/2026-09-25-auto-full-failover-design.md`

**环境须知（每步遵守）:**
- PowerShell 链接用 `; if ($?) { ... }`，禁用 `&&`；`rg` 不可用。
- server 测试加载 core 的 `dist`——**core 改动后必须先** `pnpm --filter @freemodelfinder/core build`。
- 禁止 build 与 typecheck 并行。
- 完成修改提醒用户推送，用户未说"推送"不得 push。

---

### Task 1: core `AutoRouter.rankCandidates`

**Files:**
- Create: `packages/core/src/router/__tests__/rank-candidates.test.ts`
- Modify: `packages/core/src/router/auto-router.ts`（`pickFallback` 之后、`notify` 之前，约 :396）

- [ ] **Step 1: 写失败测试**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeModel, makeRouter, makeSettings } from './fixtures.js';

describe('AutoRouter.rankCandidates', () => {
  it('returns every healthy model in descending score order', async () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    const ranked = await harness.router.rankCandidates();
    assert.deepEqual(
      ranked.map((m) => m.id),
      ['deepseek-v3.1-dead', 'alive-mini'],
    );
  });

  it('excludes unavailable-marked and rate-limited models', async () => {
    const harness = makeRouter([
      makeModel('deepseek-v3.1-dead', 'custom'),
      makeModel('qwen-other-dead', 'custom'),
      makeModel('alive-mini', 'custom'),
    ]);
    harness.router.markModelUnavailable('deepseek-v3.1-dead', 'custom', 'no provider supported');
    harness.router.markRateLimited('qwen-other-dead', 'custom', {
      isRateLimit: true,
      resetAt: Date.now() + 60_000,
      message: '429',
    });
    const ranked = await harness.router.rankCandidates();
    assert.deepEqual(
      ranked.map((m) => m.id),
      ['alive-mini'],
    );
  });

  it('returns an empty list when auto route is disabled', async () => {
    const harness = makeRouter([makeModel('alive-mini', 'custom')], makeSettings({ enabled: false }));
    assert.deepEqual(await harness.router.rankCandidates(), []);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/router/__tests__/rank-candidates.test.ts`
Expected: FAIL，`harness.router.rankCandidates is not a function`

- [ ] **Step 3: 实现**

`auto-router.ts` 中 `pickFallback` 方法结束后（`notify()` 之前）加入：

```ts
  /**
   * Full scored ranking of every candidate currently eligible for auto
   * routing (cooldown/removed models excluded). Used by the gateway to
   * walk the ENTIRE pool on failover instead of stopping at Top-3.
   * Ties break by model id so ordering matches pickFromScoredPool.
   */
  async rankCandidates(): Promise<ModelInfo[]> {
    const settings = this.opts.getSettings();
    if (!settings?.enabled) return [];
    const all = await this.opts.listAllModels();
    const candidates = all.filter((m) => {
      if (this.isProviderRateLimited(m.provider)) return false;
      if (this.isRateLimited(m.id) || this.isRateLimited(`${m.provider}:${m.id}`)) return false;
      return true;
    });
    return candidates
      .map((m) => ({ m, s: scoreModel(m, settings.strategy, this.getProfile(m.id)) }))
      .sort((a, b) => b.s - a.s || a.m.id.localeCompare(b.m.id))
      .map((x) => x.m);
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/router/__tests__/rank-candidates.test.ts`
Expected: PASS 3/3

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/auto-router.ts packages/core/src/router/__tests__/rank-candidates.test.ts
git commit -m "feat(core): rankCandidates for full-pool failover walks"
```

---

### Task 2: core 永久剔除标记 + `formatResetTime`

**Files:**
- Modify: `packages/core/src/router/auto-router.ts`（:28 常量、:291 默认值、:190 formatResetTime）
- Modify: `packages/core/src/index.ts`（:19 导出）
- Modify: `packages/core/src/router/__tests__/model-unavailable.test.ts`

- [ ] **Step 1: 改测试断言（先红）**

`model-unavailable.test.ts` 文件头 import 改为：

```ts
import { formatResetTime, parseModelUnavailableError } from '../auto-router.js';
```

第一个 `markModelUnavailable` 用例中把：

```ts
    assert.ok(state.resetAt > Date.now(), 'cooldown expires in the future');
```

替换为：

```ts
    assert.equal(state.resetAt, Number.POSITIVE_INFINITY, 'unavailable models are removed permanently');
```

文件末尾追加：

```ts
describe('formatResetTime with permanent markers', () => {
  it('renders Infinity as permanently excluded', () => {
    assert.equal(formatResetTime(Number.POSITIVE_INFINITY), '已永久剔除');
  });

  it('keeps normal timestamps unchanged', () => {
    const ts = new Date(2026, 8, 25, 10, 30, 0).getTime();
    assert.equal(formatResetTime(ts), '2026-09-25 10:30:00');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/router/__tests__/model-unavailable.test.ts`
Expected: FAIL（resetAt 不是 Infinity；formatResetTime 返回 Invalid Date 行）

- [ ] **Step 3: 实现三处**

1) `auto-router.ts:28` 删除整行 `export const MODEL_UNAVAILABLE_COOLDOWN_MS = 10 * 60_000;`

2) `markModelUnavailable` 内 `resetAt` 默认值改为永久：

```ts
      resetAt: resetAt ?? Number.POSITIVE_INFINITY,
```

3) `formatResetTime` 开头补有限性判断：

```ts
export function formatResetTime(resetAt: number | undefined): string {
  if (resetAt === undefined) return '未知';
  if (!Number.isFinite(resetAt)) return '已永久剔除';
  const d = new Date(resetAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
```

4) `packages/core/src/index.ts` 删除导出行 `MODEL_UNAVAILABLE_COOLDOWN_MS,`

5) 确认无残留引用：`grep -rn "MODEL_UNAVAILABLE_COOLDOWN_MS" packages --include=*.ts` → 0 结果

- [ ] **Step 4: 运行确认通过 + core 构建**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/router/__tests__/model-unavailable.test.ts src/router/__tests__/rank-candidates.test.ts src/router/__tests__/auto-router.test.ts; if ($?) { pnpm --filter @freemodelfinder/core build }`
Expected: 全部 PASS + build success

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/router/auto-router.ts packages/core/src/index.ts packages/core/src/router/__tests__/model-unavailable.test.ts
git commit -m "feat(core): permanently remove upstream-unavailable models from auto scoring"
```

---

### Task 3: server 非流式全量 failover + 分类 + 穷尽报错

**Files:**
- Modify: `packages/core/src/types.ts`（:214 `SwitchNotice` 加 `cause`）
- Modify: `packages/server/src/routes/openai.ts`（:1-27 import、:64-83 helper 区、:85-186 `dispatchWithAutoRoute`、:677 外层 catch）
- Test: `packages/server/src/__tests__/model-unavailable-failover.test.ts`

- [ ] **Step 1: core 类型加 `cause`（先建再构建）**

`types.ts` 的 `SwitchNotice` 改为：

```ts
export interface SwitchNotice {
  type: 'switch-away' | 'switch-back';
  from: string;
  to: string;
  strategy?: AutoRouteStrategy;
  reason: string;
  resetAt?: number;
  /** Machine-readable failure category behind this switch. */
  cause?: 'unavailable' | 'rate-limit' | 'upstream';
}
```

Run: `pnpm --filter @freemodelfinder/core build`
Expected: build success（server 测试依赖新 d.ts）

- [ ] **Step 2: 扩展测试 harness**

`model-unavailable-failover.test.ts`：删除 `makePool` 与 `appWithUnavailableModels`，替换为：

```ts
async function appWithPool(opts: {
  models: string[];
  failures?: Record<string, string>;
  failAfterChunk?: string[];
}): Promise<{ app: FastifyInstance; seenModels: () => string[] }> {
  const { models, failures = {}, failAfterChunk = [] } = opts;
  const pool: ModelInfo[] = models.map((id) => ({
    id,
    provider: 'custom' as const,
    displayName: id,
    free: true,
  }));
  const config: AppConfig = {
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
                models: [{ id: 'alive-mini' }],
              },
            ],
          },
        },
      },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: true, strategy: 'capability' },
  };
  const registry = new ProviderRegistry(config);
  const seen: string[] = [];
  const provider = {
    id: 'custom',
    async chat(request: ChatRequest): Promise<ChatResponse> {
      seen.push(request.model);
      const failure = failures[request.model];
      if (failure) throw new Error(failure);
      return {
        id: 'ok',
        model: request.model,
        created: 1,
        content: 'healthy reply',
        finish_reason: 'stop',
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      };
    },
    async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
      seen.push(request.model);
      if (failAfterChunk.includes(request.model)) {
        yield {
          id: 's',
          model: request.model,
          created: 1,
          delta: 'partial reply',
          finish_reason: 'stop' as const,
        };
      }
      const failure = failures[request.model];
      if (failure) throw new Error(failure);
      yield {
        id: 's',
        model: request.model,
        created: 1,
        delta: 'healthy reply',
        finish_reason: 'stop' as const,
      };
    },
  };
  const internals = registry as unknown as {
    instances: Map<ProviderId, unknown>;
    modelsCache: unknown;
    cacheAt: number;
  };
  internals.instances.set('custom', provider);
  internals.modelsCache = {
    models: pool,
    succeededProviders: ['custom'],
    failedProviders: [],
  };
  internals.cacheAt = Date.now();
  registry.listAllModels = async () => ({
    models: pool,
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });

  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return { app, seenModels: () => seen };
}
```

- [ ] **Step 3: 更新既有 5 个测试到新语义**

测试 1-3 只改调用方式（期望不变）；测试 4、5 整体替换。全部 5 个（含改写后的 1-3）：

```ts
describe('model-unavailable auto failover', () => {
  it('stream fails over from an unavailable model to a healthy one', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /healthy reply/);
    assert.doesNotMatch(res.body, /no provider supported/);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'alive-mini']);
    assert.match(res.body, /fmf_route_notice/, 'failover must emit a switch notice');
  });

  it('non-stream fails over from an unavailable model to a healthy one', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: false },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]!.message.content, 'healthy reply');
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'alive-mini']);
  });

  it('permanently removes the unavailable model so the next request skips it', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'first' }], stream: false },
    });
    assert.equal(first.statusCode, 200);
    const afterFirst = seenModels().length;
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'second' }], stream: false },
    });
    assert.equal(second.statusCode, 200);
    const calls = seenModels();
    assert.equal(
      calls.filter((m) => m === 'deepseek-v3.1-dead').length,
      1,
      'dead model must be attempted only once across requests',
    );
    assert.ok(calls.length > afterFirst, 'second request still reaches a healthy model');
  });

  it('exhausts every candidate then answers 503 with a failure summary', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'deepseek-v3.2-dead'],
      failures: {
        'deepseek-v3.1-dead': UNAVAILABLE_400,
        'deepseek-v3.2-dead': UNAVAILABLE_400,
      },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: false },
    });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { error: { message: string; type: string } };
    assert.match(
      body.error.message,
      /tried 2 models: 2 unavailable, 0 rate-limited, 0 upstream errors/,
    );
    assert.equal(body.error.type, 'model_unavailable');
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'deepseek-v3.2-dead']);
  });

  it('propagates the error on stream when every candidate is unavailable', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'deepseek-v3.2-dead'],
      failures: {
        'deepseek-v3.1-dead': UNAVAILABLE_400,
        'deepseek-v3.2-dead': UNAVAILABLE_400,
      },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /tried 2 models: 2 unavailable, 0 rate-limited, 0 upstream errors/);
    assert.doesNotMatch(res.body, /healthy reply/);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead', 'deepseek-v3.2-dead']);
  });
});
```

- [ ] **Step 4: 新增 5 个行为测试（同文件追加 describe）**

```ts
const RATE_LIMIT_429 =
  'custom stream failed 429: rate limit exceeded, retry later';
const UPSTREAM_500 = 'custom stream failed 500: internal server error';
const PARAM_400 =
  'custom stream failed 400: {"error":{"message":"temperature must be between 0 and 2","type":"invalid_request_error"}}';

describe('full-pool failover semantics', () => {
  it('walks past the whole Top-3 down to a lower-ranked healthy model', async () => {
    const dead = ['deepseek-v3.0-dead', 'deepseek-v3.1-dead', 'deepseek-v3.2-dead', 'deepseek-v3.3-dead'];
    const failures = Object.fromEntries(dead.map((id) => [id, UNAVAILABLE_400]));
    const { app, seenModels } = await appWithPool({
      models: [...dead, 'alive-mini'],
      failures,
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seenModels(), [...dead, 'alive-mini']);
  });

  it('marks but does not switch for an explicitly requested model', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const explicit = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'custom:deepseek-v3.1-dead',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    });
    assert.equal(explicit.statusCode, 400);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead'], 'explicit failures must not fail over');
    const auto = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(auto.statusCode, 200);
    assert.deepEqual(
      seenModels(),
      ['deepseek-v3.1-dead', 'alive-mini'],
      'the explicitly failed model is now removed from auto scoring',
    );
  });

  it('cools rate-limited models down and keeps walking to the next candidate', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.0-dead', 'deepseek-v3.1-dead', 'alive-mini'],
      failures: {
        'deepseek-v3.0-dead': RATE_LIMIT_429,
        'deepseek-v3.1-dead': RATE_LIMIT_429,
      },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seenModels(), ['deepseek-v3.0-dead', 'deepseek-v3.1-dead', 'alive-mini']);
    const body = res.json() as { fmf_route_notices?: unknown[] };
    assert.equal(body.fmf_route_notices?.length, 2, 'each switch emits a notice');
  });

  it('switches on upstream 5xx without permanently removing the model', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UPSTREAM_500 },
    });
    resetAutoPoolCursor();
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'auto', messages: [{ role: 'user', content: `hi-${i}` }], stream: false },
      });
      assert.equal(res.statusCode, 200);
    }
    const deadCalls = seenModels().filter((m) => m === 'deepseek-v3.1-dead').length;
    assert.ok(deadCalls >= 2, `5xx models stay eligible (seen ${deadCalls} times)`);
  });

  it('fails fast on request-shape 4xx without switching', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': PARAM_400 },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead'], 'param errors must not walk the pool');
  });
});
```

- [ ] **Step 5: 运行确认红**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/model-unavailable-failover.test.ts`
Expected: FAIL 若干（503/摘要/不切换/继续走/5xx 等断言），测试 1、2、3 应 PASS

- [ ] **Step 6: openai.ts 加 import 与 helper**

import 块中 core import 追加：

```ts
  type AutoRouter,
  type ModelInfo,
```

（`type ModelInfo` 插入 `type ImageGenerationRequest,` 之后按字母序；`type AutoRouter` 插入 `type ChatResponse,` 之后。）

删除 :64-65 的 `MAX_MODEL_UNAVAILABLE_RETRIES` 常量及其注释。

在 `extractProviderIdFromError` 之后加入：

```ts
type FailureKind = 'unavailable' | 'rate-limit' | 'request' | 'upstream';

function classifyFailure(err: unknown): { kind: FailureKind; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const unavailable = parseModelUnavailableError(err);
  if (unavailable.isModelUnavailable) {
    return { kind: 'unavailable', message: unavailable.message };
  }
  if (parseRateLimitError(err).isRateLimit) return { kind: 'rate-limit', message };
  const match = message.match(/failed\s+(\d{3})/i);
  const status = match ? Number(match[1]) : undefined;
  if (status !== undefined && status >= 400 && status < 500) return { kind: 'request', message };
  return { kind: 'upstream', message };
}

class CandidatesExhaustedError extends Error {
  constructor(
    readonly tried: number,
    readonly counts: { unavailable: number; rateLimit: number; upstream: number },
  ) {
    super(
      `tried ${tried} models: ${counts.unavailable} unavailable, ${counts.rateLimit} rate-limited, ${counts.upstream} upstream errors`,
    );
    this.name = 'CandidatesExhaustedError';
  }
}

type FailoverSeq = {
  ranked: ModelInfo[] | null;
  attempts: number;
  counts: { unavailable: number; rateLimit: number; upstream: number };
};

function newFailoverSeq(): FailoverSeq {
  return { ranked: null, attempts: 0, counts: { unavailable: 0, rateLimit: 0, upstream: 0 } };
}

/**
 * Snapshot the healthy ranked pool (BEFORE marking the current failure so
 * the failed model stays findable for ring positioning), record the failure,
 * apply the mark, then return the next candidate walking the ring. Returns
 * null once every candidate has been attempted.
 */
async function advanceFailover(
  router: AutoRouter,
  seq: FailoverSeq,
  failedKey: string,
  kind: FailureKind,
  mark: () => void,
): Promise<ModelInfo | null> {
  seq.ranked ??= await router.rankCandidates();
  seq.attempts++;
  if (kind === 'unavailable') seq.counts.unavailable++;
  else if (kind === 'rate-limit') seq.counts.rateLimit++;
  else seq.counts.upstream++;
  mark();
  if (seq.attempts >= seq.ranked.length) return null;
  const idx = seq.ranked.findIndex((m) => `${m.provider}:${m.id}` === failedKey);
  return seq.ranked[(idx + 1) % seq.ranked.length] ?? null;
}

function buildFailoverNotice(
  router: AutoRouter,
  kind: FailureKind,
  failedKey: string,
  next: ModelInfo,
): SwitchNotice {
  const to = `${next.provider}:${next.id}`;
  const cause = kind === 'unavailable' || kind === 'rate-limit' ? kind : 'upstream';
  const reason =
    kind === 'rate-limit'
      ? `⚠️ 模型 "${failedKey}" 已被限流（冷却中），已自动切换到：${to}`
      : kind === 'unavailable'
        ? `⚠️ 模型 "${failedKey}" 上游不可用，已永久剔除并自动切换到：${to}`
        : `⚠️ 模型 "${failedKey}" 上游请求失败，已自动切换到：${to}`;
  return { type: 'switch-away', from: failedKey, to, strategy: router.getStrategy(), reason, cause };
}
```

- [ ] **Step 7: 重写 `dispatchWithAutoRoute` 的 catch 分支**

整个函数体（:85-186）替换为：

```ts
async function dispatchWithAutoRoute(
  reg: ProviderRegistry,
  chatReq: ChatRequest,
): Promise<{
  finalModel: string;
  finalProviderId: string;
  response: ChatResponse;
  notices: SwitchNotice[];
}> {
  const router = reg.getAutoRouter();
  const notices: SwitchNotice[] = [];
  const originalRequested = chatReq.model;
  const isAuto = originalRequested === 'auto' || originalRequested === 'default';
  const seq = newFailoverSeq();

  // 1. Pre-flight: honor existing cooldowns before we even try upstream.
  const pre = await router.preflight(chatReq.model);
  if (pre.switched) {
    chatReq.model = pre.model.id;
    notices.push(pre.notice);
  }

  // 2. Resolve provider & dispatch. Auto requests keep walking the scored
  //    pool until every candidate has been tried; explicit requests fail
  //    fast (the original one-shot rate-limit switch still applies).
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resolved = reg.resolveModel(chatReq.model);
    const provider = resolved.provider;
    const realModelId = resolved.modelId;
    const dispatchReq: ChatRequest = { ...chatReq, model: realModelId };

    try {
      const res = await provider.chat(dispatchReq);
      const switchBack = await router.maybeSwitchBack(chatReq.model);
      if (switchBack) notices.push(switchBack);
      return {
        finalModel: `${provider.id}:${realModelId}`,
        finalProviderId: provider.id,
        response: res,
        notices,
      };
    } catch (err) {
      const failure = classifyFailure(err);
      const failedKey = `${provider.id}:${realModelId}`;
      const mark = () => {
        if (failure.kind === 'unavailable') {
          router.markModelUnavailable(realModelId, provider.id, failure.message);
        } else if (failure.kind === 'rate-limit') {
          router.markRateLimited(chatReq.model, provider.id, parseRateLimitError(err));
        }
      };

      if (isAuto && router.isEnabled() && failure.kind !== 'request') {
        const next = await advanceFailover(router, seq, failedKey, failure.kind, mark);
        if (next) {
          router.rememberPreference(originalRequested);
          const notice = buildFailoverNotice(router, failure.kind, failedKey, next);
          router.notify(notice);
          notices.push(notice);
          chatReq.model = `${next.provider}:${next.id}`;
          continue;
        }
        throw new CandidatesExhaustedError(seq.attempts, seq.counts);
      }

      // Explicit (or router disabled / request-shape errors): mark, then the
      // legacy one-shot rate-limit switch for explicit models still applies.
      mark();
      const parsed = parseRateLimitError(err);
      if (parsed.isRateLimit && router.isEnabled() && attempt === 0) {
        const fallback = await router.pickFallback(chatReq.model);
        if (fallback) {
          router.rememberPreference(originalRequested);
          const notice: SwitchNotice = {
            type: 'switch-away',
            from: chatReq.model,
            to: `${fallback.provider}:${fallback.id}`,
            strategy: router.getStrategy(),
            reason: router.buildSwitchAwayMessage(
              {
                model: chatReq.model,
                provider: provider.id,
                hitAt: Date.now(),
                resetAt: parsed.resetAt ?? Date.now() + 60_000,
                message: parsed.message,
              },
              fallback,
            ),
            resetAt: parsed.resetAt,
            cause: 'rate-limit',
          };
          router.notify(notice);
          notices.push(notice);
          chatReq.model = `${fallback.provider}:${fallback.id}`;
          attempt++;
          continue;
        }
      }
      throw err;
    }
  }
}
```

- [ ] **Step 8: 非流式外层 catch 返回 503**

`openai.ts` 非流式 handler 的 `catch (err)`（原 :677）中，`const msg = ...` 之后插入：

```ts
          if (err instanceof CandidatesExhaustedError) {
            record(req, t0, {
              kind: 'chat',
              ...resolvePM(reg, chatReq.model),
              status: 'error',
              httpStatus: 503,
              error: msg,
            });
            return reply.code(503).send({ error: { message: msg, type: 'model_unavailable' } });
          }
```

- [ ] **Step 9: 运行新测试到绿**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/model-unavailable-failover.test.ts`
Expected: 此时流式穷尽测试（Step 3 第 5 个）仍红（流式在 Task 4 改）——非流式 9 个全绿、流式前 2 个绿、流式穷尽红。
若其它非流式测试红：按断言逐个排查 `classifyFailure`/`advanceFailover`/503 分支。

- [ ] **Step 10: 回归（非流式改动相关）**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/vision-failover.test.ts src/__tests__/max-tokens-retry.test.ts src/__tests__/stream-error-envelope.test.ts src/__tests__/routing.test.ts src/__tests__/auto-modality.test.ts`
Expected: 全 PASS（如有失败，修实现不动测试——这些是既有行为保护）

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/types.ts packages/server/src/routes/openai.ts packages/server/src/__tests__/model-unavailable-failover.test.ts
git commit -m "feat(server): non-stream auto requests walk the whole ranked pool"
```

---

### Task 4: server 流式全量 failover

**Files:**
- Modify: `packages/server/src/routes/openai.ts`（:722-889 流式段）
- Test: `packages/server/src/__tests__/model-unavailable-failover.test.ts`

- [ ] **Step 1: 加流式新测试（先红）**

同测试文件追加：

```ts
describe('stream full-pool failover', () => {
  it('keeps walking rate-limited candidates while nothing has been streamed', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.0-dead', 'deepseek-v3.1-dead', 'alive-mini'],
      failures: {
        'deepseek-v3.0-dead': RATE_LIMIT_429,
        'deepseek-v3.1-dead': RATE_LIMIT_429,
      },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /healthy reply/);
    assert.deepEqual(seenModels(), ['deepseek-v3.0-dead', 'deepseek-v3.1-dead', 'alive-mini']);
    assert.equal(res.body.match(/fmf_route_notice/g)?.length, 2, 'two switch notices on the wire');
  });

  it('never switches after a chunk has been written', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-fail', 'alive-mini'],
      failures: { 'deepseek-v3.1-fail': UNAVAILABLE_400 },
      failAfterChunk: ['deepseek-v3.1-fail'],
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /partial reply/);
    assert.doesNotMatch(res.body, /healthy reply/);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-fail'], 'no candidate tried after first byte');
    assert.match(res.body, /no provider supported/, 'the error surfaces to the client');
  });

  it('marks but does not switch for explicit stream requests', async () => {
    const { app, seenModels } = await appWithPool({
      models: ['deepseek-v3.1-dead', 'alive-mini'],
      failures: { 'deepseek-v3.1-dead': UNAVAILABLE_400 },
    });
    resetAutoPoolCursor();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'custom:deepseek-v3.1-dead',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /no provider supported/);
    assert.deepEqual(seenModels(), ['deepseek-v3.1-dead']);
    assert.doesNotMatch(res.body, /fmf_route_notice/, 'explicit streams never fail over');
  });
});
```

- [ ] **Step 2: 运行确认红**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/model-unavailable-failover.test.ts`
Expected: 新 3 个 + 既有"stream exhausted summary"共 4 个 FAIL，其余 PASS

- [ ] **Step 3: 重写流式 catch**

流式段改动：

1) :759 `let modelUnavailableRetries = 0;` 替换为：

```ts
      const seq = newFailoverSeq();
```

2) catch 内 vision 分支之后的整段（原 :825-884，unavailable 块 + rate-limit 块 + 报错尾巴）替换为：

```ts
            const failure = classifyFailure(err);
            const failedKey = `${provider.id}:${realModelId}`;
            const isAutoReq = originalRequested === 'auto' || originalRequested === 'default';
            const mark = () => {
              if (failure.kind === 'unavailable') {
                router.markModelUnavailable(realModelId, provider.id, failure.message);
              } else if (failure.kind === 'rate-limit') {
                router.markRateLimited(
                  chatReq.model,
                  extractProviderIdFromError(chatReq, reg) as ProviderId,
                  parseRateLimitError(err),
                );
              }
            };

            let reportErr: unknown = err;
            if (isAutoReq && router.isEnabled() && !wroteChunk && failure.kind !== 'request') {
              const next = await advanceFailover(router, seq, failedKey, failure.kind, mark);
              if (next) {
                router.rememberPreference(originalRequested);
                const notice = buildFailoverNotice(router, failure.kind, failedKey, next);
                router.notify(notice);
                reply.raw.write(
                  `data: ${JSON.stringify({ fmf_route_notice: notice, id: 'fmf', object: 'chat.completion.chunk', choices: [] })}\n\n`,
                );
                chatReq.model = `${next.provider}:${next.id}`;
                try {
                  const resolved = reg.resolveModel(chatReq.model);
                  provider = resolved.provider;
                  realModelId = resolved.modelId;
                  maxTokensRetried = false;
                  continue;
                } catch {
                  // fall through to error reporting below
                }
              } else {
                reportErr = new CandidatesExhaustedError(seq.attempts, seq.counts);
              }
            } else {
              mark();
            }

            const msg = reportErr instanceof Error ? reportErr.message : String(reportErr);
            const { status, httpStatus } = classifyStatus(reportErr);
            record(req, t0, {
              kind: 'chat',
              ...resolvePM(reg, chatReq.model),
              status,
              httpStatus,
              error: msg,
            });
            reply.raw.write(
              `data: ${JSON.stringify({
                error: {
                  message: msg,
                  type:
                    reportErr instanceof CandidatesExhaustedError
                      ? 'model_unavailable'
                      : streamErrorType(msg, reportErr),
                },
              })}\n\n`,
            );
            break;
```

注意保持其上的 max_tokens 分支、vision 分支原样不动；catch 内 `parseModelUnavailableError`/`parseRateLimitError` 旧 import 仍被 helper 使用，无需删。

- [ ] **Step 4: 运行确认绿**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/model-unavailable-failover.test.ts`
Expected: 全部 PASS（10 个用例）

- [ ] **Step 5: 全 server 回归**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: 全 PASS（此前基线 114 + 新增）

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/openai.ts packages/server/src/__tests__/model-unavailable-failover.test.ts
git commit -m "feat(server): stream auto requests walk the whole ranked pool"
```

---

### Task 5: UI 永久剔除显示

**Files:**
- Modify: `packages/ui/app/components/SettingsView.tsx`（:1408-1411）
- Modify: `packages/ui/app/i18n.tsx`（:244 zh、:717 en）

- [ ] **Step 1: i18n 文案**

zh 块（`'settings.autoRoute.cooldown.reset'` 行后）加：

```ts
  'settings.autoRoute.cooldown.permanent': '永久剔除',
```

en 块（`'settings.autoRoute.cooldown.reset': 'Reset: ',` 行后）加：

```ts
  'settings.autoRoute.cooldown.permanent': 'permanently excluded',
```

- [ ] **Step 2: 显示分支**

`SettingsView.tsx` 冷却列表 span 内 `new Date(c.resetAt).toLocaleString()` 替换为：

```tsx
                        {Number.isFinite(c.resetAt)
                          ? new Date(c.resetAt).toLocaleString()
                          : t('settings.autoRoute.cooldown.permanent')}
```

（JSON 会把 `Infinity` 序列化为 `null`；`Number.isFinite(null)` 为 false，同一分支覆盖两种表示。"清除冷却"按钮走既有 `clearCooldown`，可手动恢复永久剔除。）

- [ ] **Step 3: UI 测试回归**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: 全 PASS（历史基线 53；若有用例断言冷却日期渲染，按"永久"分支更新该用例）

- [ ] **Step 4: Commit**

```bash
git add packages/ui/app/components/SettingsView.tsx packages/ui/app/i18n.tsx
git commit -m "feat(ui): show permanently removed models in the cooldown list"
```

---

### Task 6: 全量验证

- [ ] **Step 1: 格式化本次全部改动文件**

Run:
```bash
npx prettier --write 'packages/core/src/router/auto-router.ts' 'packages/core/src/router/__tests__/rank-candidates.test.ts' 'packages/core/src/router/__tests__/model-unavailable.test.ts' 'packages/core/src/index.ts' 'packages/core/src/types.ts' 'packages/server/src/routes/openai.ts' 'packages/server/src/__tests__/model-unavailable-failover.test.ts' 'packages/ui/app/components/SettingsView.tsx' 'packages/ui/app/i18n.tsx'
```
Expected: 无报错

- [ ] **Step 2: ESLint 零警告**

Run:
```bash
npx eslint 'packages/core/src/router/auto-router.ts' 'packages/core/src/router/__tests__/rank-candidates.test.ts' 'packages/core/src/router/__tests__/model-unavailable.test.ts' 'packages/core/src/index.ts' 'packages/core/src/types.ts' 'packages/server/src/routes/openai.ts' 'packages/server/src/__tests__/model-unavailable-failover.test.ts' 'packages/ui/app/components/SettingsView.tsx' 'packages/ui/app/i18n.tsx' --max-warnings=0
```
Expected: 无输出（0 problems）

- [ ] **Step 3: 构建 + 类型检查（严格串行）**

Run: `pnpm build:runtime; if ($?) { pnpm typecheck }`
Expected: 全部 Done，无 TS 错误

- [ ] **Step 4: 三包全量测试**

Run:
```bash
pnpm --filter @freemodelfinder/core test; if ($?) { pnpm --filter @freemodelfinder/server test }
```
Run: `pnpm --filter @freemodelfinder/ui test`
Expected: 全 PASS

- [ ] **Step 5: 汇总提交（若前序步骤有格式化残留）**

```bash
git status -s
git add -A packages/
git commit -m "chore: formatting and lint cleanups for full-pool failover"
```
（若 Step 1-4 无 diff 则跳过。）

---

## Self-Review 结论

1. **Spec 覆盖:** ①候选序列→Task 1+3/4 advanceFailover 环游标；②永久剔除/限流回池/分类表→Task 2+3 classifyFailure+mark；③执行层（循环/共享 helper/notice cause/穷尽 503 摘要）→Task 3/4；④范围边界（仅 auto、显式标记不切换、显式限流一次切换保留、anthropic/gemini/preflight/vision 不动）→Task 3 Step 7 的 isAuto 门 + 既有块保留；⑤测试→Task 3/4 全部断言与 spec 测试清单一一对应。
2. **占位符:** 无 TBD/无"类似 Task N"——每个代码步骤均含完整代码。
3. **类型一致性:** `rankCandidates(): Promise<ModelInfo[]>`（Task 1）= `advanceFailover` 参数类型（Task 3）；`FailureKind`/`FailoverSeq`/`CandidatesExhaustedError`/`buildFailoverNotice` 均在 Task 3 定义、Task 4 复用；`cause` 字段类型与 types.ts 一致；测试断言文案 `tried N models: ...` 与 `CandidatesExhaustedError` 构造一致。
