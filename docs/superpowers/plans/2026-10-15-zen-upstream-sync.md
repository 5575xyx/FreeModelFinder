# 同步上游 opencode2api（10-15）到 packages/zen 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游 `jasonxu114514/opencode2api` 2026-10-15 的功能性提交移植进 `packages/zen`，恢复匿名通道（UA/头指纹 403 修复）、修复匿名通道锁死（#59），并补齐 cost/reasoning/free_only(#65/#66)、attempt deadline(#64)、client cancel 499(#76)、工具结果图片(#62)、per-session 观测(#77) 等。

**Architecture:** `packages/zen` 是 Go 项目 opencode2api 的 1:1 TS 移植。本计划按依赖分 7 阶段、15 个任务逐个移植。**参考实现**：旧版 Go 在 `E:\AImoney\opencode2api\opencode2api\`，新版上游在 `C:\Users\13428\AppData\Local\Temp\opencode\upstream-opencode2api\`（已 clone，HEAD=`25afadd`）。执行者必须对照新旧 Go 源码逐字段移植，reviewer 对照 Go 源核对。

**Tech Stack:** TypeScript、zod、Node 内置 test runner（`node --import tsx --test`）、tsup。无新增依赖。

**Spec:** 本计划即规格（无独立 design 文档）。上游提交清单见下。

## Global Constraints

- 必须中文提交信息；每个任务一个 commit；TDD（先红后绿，关键测试摘除实现复验红）。
- 测试命令：`cd packages/zen && pnpm exec node --import tsx --test <file>`；覆盖率门槛 **85% 行 / 74% 分支**（`packages/zen/package.json`），新增文件必须带测试。
- 对照 Go 源移植时，**逐字段核对**，不得凭记忆；每个任务提交信息注明对应上游 PR 号。
- 明确**跳过**（不移植）：`jsonutil/value.go` #78（TS 用 `structuredClone` 已是最终形态）、`config/secrets.go`（Go 服务日志脱敏）、`admin/api_keys.go` #58（FMF 已有 `callLogger.usageForGatewayKey`）、`telemetry` 的 ServerKeys 维度与 60 桶环形窗口（FMF 走 `callLogger`）。
- 门禁：改动集 `prettier --check` → `eslint` → `pnpm build:runtime` → `pnpm typecheck` → `pnpm --filter @freemodelfinder/zen test`。**绝不并行** `build:runtime` 与 `typecheck`/`test`。
- PowerShell 写 commit message 用 `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))`（禁 `Set-Content -Encoding utf8`，带 BOM 污染 subject）。

## Review Focus

1. **UA 与请求头指纹必须与上游逐字节一致** —— 差一个字符匿名通道就 403。→ Task 1、2。
2. **attempt deadline 不能杀已建立的流** —— 响应头已到就 disarm，Node 的 `AbortSignal.timeout` 挂整个 request 会误杀流。→ Task 9、10。
3. **#59 代理恢复必须清匿名节点冷却** —— 否则路由健康了匿名通道仍一直跳过。→ Task 12。
4. **retry-after 8 倍截断只对匿名 pool**，key pool 保持完整尊重。→ Task 12。
5. **tool-images 的每个校验分支**（Anthropic url/base64、OpenAI file_id 冲突、未知块类型）都要覆盖到 85% 分支门槛。→ Task 14。

---

## 阶段 0 — 止血（恢复匿名通道，无新文件）

### Task 1: UA 字符串改为 opencode/latest/2.0.29/cli（#httpx/client.go）

**Files:**

- Modify: `packages/zen/src/identity/client.ts:1,25-27`
- Test: `packages/zen/src/__tests__/client.test.ts:7`

**Interfaces:**

- Consumes: 无。
- Produces: `openCodeUserAgent()` 返回 `` `opencode/latest/${OPENCODE_VERSION}/cli` ``，`OPENCODE_VERSION = '2.0.29'`。删除 `runtimeOs`/`runtimeArch`（不再用于 UA）。

- [ ] **Step 1: 写失败测试**（改 `client.test.ts:7` 断言）
  ```ts
  assert.match(openCodeUserAgent(), /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/);
  assert.equal(openCodeUserAgent(), 'opencode/latest/2.0.29/cli');
  ```
- [ ] **Step 2: 跑测试确认变红**
      Run: `cd packages/zen && pnpm exec node --import tsx --test src/__tests__/client.test.ts`
      Expected: FAIL —— 旧 UA 形状不匹配。
- [ ] **Step 3: 实现**
      `OPENCODE_VERSION = '2.0.29'`；`openCodeUserAgent()` 返回 `` `opencode/latest/${OPENCODE_VERSION}/cli` ``；删除 `runtimeOs`/`runtimeArch`。对照 Go `internal/httpx/client.go` `UserAgent()`。
- [ ] **Step 4: 跑测试确认变绿**（同上，Expected: PASS）+ `pnpm --filter @freemodelfinder/zen test` 无回归。
- [ ] **Step 5: 提交**
  ```bash
  git commit -m "fix(zen): UA 改为 opencode/latest/2.0.29/cli，修复匿名通道 403（对齐上游 httpx）"
  ```

### Task 2: 请求头指纹对齐（#upstream.go + #identity/request.go）

**Files:**

- Modify: `packages/zen/src/gateway/upstream.ts:270-307`（`buildUpstreamRequest`）
- Test: `packages/zen/src/__tests__/gateway-upstream.test.ts`（新建或追加，断言头集合）

**Interfaces:**

- Consumes: Task 1 的 `openCodeUserAgent()`。
- Produces:
  - `export function clientProjectID(project: string): string` —— sha256(`"opencode-project\0"+project`) 取前 20 字节 → 40 位裸 hex（无 `prj_` 前缀）。用 `node:crypto` `createHash('sha256')`。
  - `buildUpstreamRequest` 头集合改为：`content-type`、`accept`、`user-agent`、`x-opencode-client: cli`、`x-opencode-session: ids.session`、`x-opencode-session-id: ids.session`（新增）、`x-session-affinity`、`x-session-id`、`x-opencode-project: clientProjectID(ids.project ?? '')`；**删除** `x-opencode-request`。

- [ ] **Step 1: 写失败测试**
  ```ts
  it('builds upstream headers with the new fingerprint', () => {
    const req = buildUpstreamRequest(
      'https://opencode.ai/inference',
      'chat',
      {},
      { session: 'ses_abc', request: 'req', project: 'global' } as never,
      'k',
      {} as never,
    );
    assert.equal(req.headers['x-opencode-session-id'], 'ses_abc');
    assert.equal(
      req.headers['x-opencode-request'],
      undefined,
      'x-opencode-request must be removed',
    );
    assert.match(req.headers['x-opencode-project'] as string, /^[0-9a-f]{40}$/);
    assert.equal(req.headers['user-agent'], 'opencode/latest/2.0.29/cli');
  });
  it('clientProjectID hashes to 40 hex chars', () => {
    assert.match(clientProjectID('global'), /^[0-9a-f]{40}$/);
    assert.equal(clientProjectID('global'), clientProjectID('global'));
  });
  ```
- [ ] **Step 2: 跑测试确认变红**（Expected: `clientProjectID` 未定义 / 头不匹配）。
- [ ] **Step 3: 实现**：对照 Go `internal/gateway/upstream.go:785-814` `newUpstreamRequest` 与 `identity/request.go`。加 `clientProjectID`（`createHash('sha256').update('opencode-project\0'+project).digest('hex').slice(0,40)`）；改 `buildUpstreamRequest` 头集合。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `fix(zen): 上游请求头指纹对齐（session-id/clientProjectID，移除 request 头）`

### Task 3: responses max_output_tokens 下限 16（#protocol/request.go #63）

**Files:**

- Modify: `packages/zen/src/protocol/request.ts`、`packages/zen/src/protocol/responses.ts:65`
- Test: `packages/zen/src/__tests__/protocol-request.test.ts`（新建或追加）

**Interfaces:**

- Produces:
  - `export const MIN_RESPONSES_MAX_OUTPUT_TOKENS = 16`
  - `export function floorResponsesMaxTokens(value: unknown): unknown` —— 仅 `typeof value === 'number'` 且 `0 < value < 16` 时返回 16，否则原样返回（含 undefined）。
  - `prepareRequest` 在 `target === 'responses'` 时（**含 same-protocol `cloneRaw` 返回之后**）无条件写 `max_output_tokens = floorResponsesMaxTokens(body['max_output_tokens'])`（仅当原值存在或需 floor 时）。
  - `responses.ts:65` `body['max_output_tokens'] = floorResponsesMaxTokens(request.max_tokens)`（但 undefined 不产生键）。

- [ ] **Step 1: 写失败测试**
  ```ts
  assert.equal(floorResponsesMaxTokens(4), 16);
  assert.equal(floorResponsesMaxTokens(4096), 4096);
  assert.equal(floorResponsesMaxTokens(undefined), undefined);
  assert.equal(floorResponsesMaxTokens('x'), 'x');
  // prepareRequest same-protocol responses 克隆路径也被 floor：
  const req = {
    model: 'm',
    rawProtocol: 'openai',
    raw: { model: 'm', max_output_tokens: 4 },
    messages: [],
  } as never;
  assert.equal((prepareRequest(req, 'responses') as any).max_output_tokens, 16);
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/protocol/request.go` `floorResponsesMaxTokens`/`minResponsesMaxOutputTokens`。`prepareRequest` 的 `cloneRaw` 分支返回后，若 `target==='responses'` 且 body 有 `max_output_tokens` 则 floor；`toResponsesBody` 的 max_tokens 也 floor。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `fix(zen): responses max_output_tokens 下限 16，含 same-protocol 克隆路径（#63）`

---

## 阶段 1 — config（其余前置）

### Task 4: upstream.anonymous + models.freeOnly（#config/config.go）

**Files:**

- Modify: `packages/zen/src/config/index.ts:25-30,50-55`
- Test: `packages/zen/src/__tests__/config.test.ts`（追加）

**Interfaces:**

- Produces:
  - `ZenConfig.upstream` 加 `anonymous: z.string().default('https://opencode.ai/inference')`
  - `ZenConfig.models` 加 `freeOnly: z.boolean().default(false)`
  - `providers/zen.ts:config()` 已整体透传 upstream/models，zod 加字段即生效（确认无需改）。

- [ ] **Step 1: 写失败测试**
  ```ts
  const cfg = normalizeZenConfig({});
  assert.equal(cfg.upstream.anonymous, 'https://opencode.ai/inference');
  assert.equal(cfg.models.freeOnly, false);
  assert.equal(
    normalizeZenConfig({ upstream: { anonymous: '' } }).upstream.anonymous,
    'https://opencode.ai/inference',
  );
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：`upstream` 对象加 `anonymous` 字段（默认 `https://opencode.ai/inference`）；`models` 加 `freeOnly`（默认 false）。对照 Go `internal/config/config.go` `UpstreamConfig.Anonymous` / `ModelsConfig.FreeOnly`。
- [ ] **Step 4: 跑测试确认变绿** + `pnpm --filter @freemodelfinder/core test`（zen provider config 透传）。
- [ ] **Step 5: 提交** `feat(zen): 配置新增 upstream.anonymous 与 models.freeOnly`

---

## 阶段 2 — models（#65/#66 数据链）

### Task 5: ModelCost 类型 + pricing cache_read/cache_write（#discovery.go + #pricing.go）

**Files:**

- Modify: `packages/zen/src/models/types.ts`、`packages/zen/src/models/pricing.ts`
- Test: `packages/zen/src/__tests__/models-pricing.test.ts`（追加）

**Interfaces:**

- Produces:
  - `export interface ModelCost { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }`（types.ts，从 index 导出）
  - `ZenModelMetadata` 加 `cost?: ModelCost`
  - `ZenPrice` 加 `cacheRead?: number; cacheWrite?: number`
  - `AnonymousDecision` 加 `cacheReadCost?: number; cacheWriteCost?: number`（`decide()` 填）
  - `decodeModelsDev` 解析 `cost.cache_read` / `cost.cache_write`（用既有 `numberAt`）

- [ ] **Step 1: 写失败测试**
  ```ts
  // models.dev fixture cost: { input: 0, output: 0, cache_read: 0.5, cache_write: 1.5 }
  const d = decide(...); // 用既有测试的调用方式
  assert.equal(d.cacheReadCost, 0.5);
  assert.equal(d.cacheWriteCost, 1.5);
  // cache_read 不影响 free 判定
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/models/discovery.go` `Cost` 结构 + `internal/models/pricing.go` `Price.CacheRead/CacheWrite`。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `feat(zen): 模型定价补充 cache_read/cache_write 与 ModelCost 类型（#65）`

### Task 6: catalog freeOnly + metadataForTier cost（#catalog.go #66）

**Files:**

- Modify: `packages/zen/src/models/catalog.ts`
- Test: `packages/zen/src/__tests__/models-catalog.test.ts`（追加）

**Interfaces:**

- Consumes: Task 5 的 `ModelCost`。
- Produces:
  - `ZenCatalog` 加 `private freeOnly = false` + `setFreeOnly(enabled: boolean): void`
  - `private assertFreeOnly(model: string): void` —— `freeOnly && !anonymousDecision(model).Allowed` 抛 `model "x" is not free and models.free_only is enabled`
  - `route()` / `routeForTier()` 在 `assertNotDisabled` 之后调 `assertFreeOnly`（可用性错误优先）
  - `list()` 过滤 freeOnly
  - `metadataForTier()` 填 `cost`（从 price）

- [ ] **Step 1: 写失败测试**
  ```ts
  catalog.setFreeOnly(true);
  assert.throws(() => catalog.route('paid-model'), /is not free and models.free_only is enabled/);
  catalog.route('free-model'); // 不抛
  catalog.setFreeOnly(false);
  catalog.route('paid-model'); // 恢复
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/models/catalog.go` `freeOnlyErrorLocked` / `SetFreeOnly` / `MetadataForTier`。`config/index.ts` 的 `models.freeOnly` 在 gateway 装配时调 `catalog.setFreeOnly(...)`（找 zen provider 装配点）。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `feat(zen): catalog 支持 free_only 过滤与 cost 元数据（#66/#65）`

### Task 7: reasoningEfforts 阶梯天花板（#health.go → 新建 gateway/models.ts）

**Files:**

- Create: `packages/zen/src/gateway/models.ts`
- Modify: `packages/zen/src/config/index.ts`（提 `REASONING_LEVELS` 常量）、`packages/zen/src/index.ts`（导出）
- Test: `packages/zen/src/__tests__/gateway-models.test.ts`（新建）

**Interfaces:**

- Consumes: `protocol/effort.ts` 的 `resolvedEffort`（probe.ts:368 已有引用）。
- Produces:
  - `export const REASONING_LEVELS = ['minimal','low','medium','high','xhigh','max'] as const`（config/index.ts）
  - `export function reasoningEfforts(model, tier, protocol, deps: { forcedEffort; resolvedEffort }): ZenReasoningEffort[]` —— `forcedEffort(model)==='auto'` 时返回 `REASONING_LEVELS.slice(0, resolvedEffort 下标 + 1)`，否则全量。

- [ ] **Step 1: 写失败测试**
  ```ts
  // auto + 探针确认 high → ['minimal','low','medium','high']
  assert.deepEqual(
    reasoningEfforts(m, 'zen', 'chat', {
      forcedEffort: () => 'auto',
      resolvedEffort: () => 'high',
    }),
    ['minimal', 'low', 'medium', 'high'],
  );
  // auto + max → 全量
  assert.deepEqual(
    reasoningEfforts(m, 'zen', 'chat', { forcedEffort: () => 'auto', resolvedEffort: () => 'max' }),
    [...REASONING_LEVELS],
  );
  // 非 auto → 全量
  assert.deepEqual(
    reasoningEfforts(m, 'zen', 'chat', { forcedEffort: () => 'high', resolvedEffort: () => 'low' }),
    [...REASONING_LEVELS],
  );
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/gateway/health.go` `reasoningLevels` / `reasoningEfforts`。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `feat(zen): reasoningEfforts 阶梯天花板（#65）`

### Task 8: FMF 侧 ModelInfo + /v1/models 透传 cost/reasoning（#65/#66）

**Files:**

- Modify: `packages/core/src/types.ts`（`ModelInfo` 加 `reasoningEfforts?/defaultReasoningEffort?/cost?`）、`packages/core/src/providers/zen.ts:listModels()`、`packages/server/src/routes/openai.ts:727`（`/v1/models`）
- Test: `packages/core/src/providers/__tests__/zen.test.ts`（追加）

**Interfaces:**

- Consumes: Task 7 的 `reasoningEfforts`、Task 5 的 `ModelCost`。
- Produces: `ModelInfo` 加可选字段；`/v1/models` 响应每 reasoning 模型带 `reasoning_efforts`、`compat: { supportsReasoningEffort, supportedReasoningEfforts }`、`default_reasoning_effort`（非 none）；有 cost 时带 `cost`（snake + camel 别名）。

- [ ] **Step 1: 写失败测试**（zen.test.ts：`listModels()` 返回的 ModelInfo 带 reasoningEfforts/cost）
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/gateway/health.go` `handleModels`。`providers/zen.ts:listModels()` 用 `reasoningEfforts(...)` + `metadataForTier().cost` 填充 ModelInfo；`routes/openai.ts` 透传。
- [ ] **Step 4: 跑测试确认变绿** + core + server 全量。
- [ ] **Step 5: 提交** `feat(core,server): /v1/models 暴露 reasoning_efforts 与 cost（#65）`

---

## 阶段 3 — http/identity（#64 语义修正）

### Task 9: first-event.ts —— attempt phase 分类与 upstreamAccepted（#first_event.go）

**Files:**

- Create: `packages/zen/src/gateway/first-event.ts`
- Modify: `packages/zen/src/index.ts`（导出）
- Test: `packages/zen/src/__tests__/gateway-first-event.test.ts`（新建）

**Interfaces:**

- Produces:
  - `export type AttemptPhase = 'dial' | 'write' | 'headers' | 'first_event'`
  - `export function classifyAttemptError(error: unknown): string` —— 返回 `attempt_timeout_<phase>` / `first_event` / `timeout_<phase>` / `transport_<phase>`（phase 从错误的标记读取）。
  - `export function upstreamAccepted(error: unknown): boolean` —— `phase === 'first_event'`（上游已应答，慢生成，不算坏代理）。
  - `export class PhasedError extends Error` —— 带 `phase: AttemptPhase`，`cause` 保留原错误。

- [ ] **Step 1: 写失败测试**
  ```ts
  assert.equal(upstreamAccepted(new PhasedError('first_event', new Error('slow'))), true);
  assert.equal(upstreamAccepted(new PhasedError('dial', new Error('x'))), false);
  assert.equal(
    classifyAttemptError(
      new PhasedError('dial', Object.assign(new Error('t'), { name: 'TimeoutError' })),
    ),
    'attempt_timeout_dial',
  );
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/gateway/first_event.go` `phasedError` / `classifyAttemptError` / `upstreamAccepted` / `attemptTrace`。Node 无 `httptrace`，phase 用近似（见 Task 10）。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `feat(zen): attempt phase 分类与 upstreamAccepted（#64/#77 地基）`

### Task 10: http.ts attempt 超时只覆盖到响应头（#first_event.go + #httpx）

**Files:**

- Modify: `packages/zen/src/http.ts:70-71`（`attemptTimeoutMs`）
- Test: `packages/zen/src/__tests__/http.test.ts`（追加）

**Interfaces:**

- Consumes: Task 9 的 `PhasedError`。
- Produces: `ZenHttpResponse` 加 `committed: boolean`（响应头已到达标记）。`attemptTimeoutMs` 触发的 abort 在 `resolve()`（拿到响应头）时 disarm；已建立流在 request 级预算下继续。用 `req.on('socket')` / `socket.once('connect'|'secureConnect')` / `res.on('data')` 近似 phase，超时抛 `PhasedError(phase, TimeoutError)`。

- [ ] **Step 1: 写失败测试**
  ```ts
  // attempt 超时触发但响应头已收到 → 不 abort 已建立的流，committed=true
  // attempt 超时在 dial 阶段 → PhasedError('dial')，isProxyFailure=true
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `first_event.go` `doInferenceAttempt` 的 `time.AfterFunc` + `commitDeadline`。TS 用 `AbortController` + 手动 timer，`res`（响应对象）到达时 `clearTimeout` + 标 `committed`。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `fix(zen): attempt 超时只覆盖到响应头，不再杀已建立的流（#64）`

### Task 11: attemptDeadline 封顶 + makeRequestIds.project（#gateway.go + #identity/request.go）

**Files:**

- Modify: `packages/zen/src/gateway/runtime.ts:139,128-133`、`packages/zen/src/gateway/upstream.ts:29-35`（`ZenRequestIds`）
- Test: `packages/zen/src/__tests__/gateway-runtime.test.ts`（追加）

**Interfaces:**

- Produces:
  - `attemptDeadlineMs(config): number` —— `attemptTimeoutSeconds <= 0` 返回 0；否则 `min(attemptTimeoutSeconds, retry.timeoutSeconds) * 1000`。`withConfiguredTimeouts` 用它（现在直接 `attemptTimeoutSeconds*1000`，无封顶）。
  - `ZenRequestIds` 加 `project?: string`（原始信号，不哈希）；`makeRequestIds` 填。
  - **不需要**移植多 header 候选（FMF 是库形态，header 解析在 server 层）。

- [ ] **Step 1: 写失败测试**
  ```ts
  assert.equal(
    attemptDeadlineMs({
      performance: { attemptTimeoutSeconds: 600 },
      retry: { timeoutSeconds: 300 },
    } as any),
    300000,
  ); // min(600,300)
  assert.equal(
    attemptDeadlineMs({
      performance: { attemptTimeoutSeconds: 0 },
      retry: { timeoutSeconds: 300 },
    } as any),
    0,
  );
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `gateway.go` `attemptDeadline` + `identity/request.go`（只取 project 语义变化）。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `fix(zen): attempt deadline 加 request 级封顶；requestIds 补 project（#64）`

---

## 阶段 4 — gateway（#59 匿名锁死 + 匿名 base）

### Task 12: 匿名 base 拆分 + pool.restoreProxy + 8x 截断 + isProxyFailure 豁免（#upstream.go + #pool.go + #probe.go #59）

**Files:**

- Modify: `packages/zen/src/gateway/upstream.ts`（`baseUrlFor` + `doAnonymousUpstream` + `isProxyFailure`）、`packages/zen/src/gateway/pool.ts`（`restoreProxy` + `markFailure` 8x）、`packages/zen/src/gateway/probe.ts`（`ProbeLane.baseUrl` + `ids.project` 裸串）、`packages/zen/src/gateway/runtime.ts`（代理恢复调 restoreProxy）
- Test: `packages/zen/src/__tests__/gateway-pool.test.ts`、`gateway-probe.test.ts`（追加/更新）

**Interfaces:**

- Consumes: Task 4 的 `upstream.anonymous`、Task 9 的 `upstreamAccepted`、Task 11 的 `project`。
- Produces:
  - `ZenUpstreamOptions.upstream` 加 `anonymous`；`baseUrlFor(route)` 加 `route==='anonymous' → upstream.anonymous` 分支。
  - `ZenAnonymousPool.restoreProxy(proxy): number` —— 遍历节点，`node.proxy===proxy` 时 `resetCooldown`，返回 cleared 数。
  - `markFailure` 匿名 pool：`retryAfterMs` 截断 `min(retryAfterMs, maxCooldownMs(baseMs))`（`health.ts:34` 的 `maxCooldownMs` = base*2^3 = 8x，复用）；key pool 不截断。
  - `isProxyFailure` 加 `if (upstreamAccepted(error)) return false`。
  - `runtime.ts` `verifyProxy`/`runProxyHealthChecks` 代理恢复时调 `anonymousPool.restoreProxy(proxy)`（key pool 同样）。
  - `ProbeLane` 加 `baseUrl`；`ids.project` 改裸串（如 `'opencode2api:default-project'`，probe.ts:235 的 `'prj_opencode2api_default'` 要改）。

- [ ] **Step 1: 写失败测试**
  ```ts
  // restoreProxy：节点冷却中 + 代理恢复 → 返回 1 且 inCooldown=false
  // 匿名节点 Retry-After: 7200 → 冷却不超过 maxCooldownMs
  // key 节点同一响应 → 冷却仍 7200s
  // upstreamAccepted 错误不翻转 proxy.health.healthy
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/gateway/pool.go` `anonymousPool.RestoreProxy` / `maxAnonymousRetryAfterMultiplier=8` / `isProxyFailure`；`upstream.go` base 拆分；`probe.go` `lane.baseURL` + `ids.Project`。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `fix(zen): 匿名通道锁死修复——代理恢复清冷却、retry-after 8x 截断、匿名 base 拆分（#59）`

### Task 13: refresh 匿名 tier 发现 + 404 legacy 回退（#refresh.go）

**Files:**

- Modify: `packages/zen/src/gateway/refresh.ts`、`packages/zen/src/models/discovery.ts`（`fetchModels` 暴露 status）
- Test: `packages/zen/src/__tests__/gateway-refresh.test.ts`（追加）

**Interfaces:**

- Produces:
  - `export const LEGACY_ZEN_BASE = 'https://opencode.ai/zen'`（refresh.ts，对应 `modelcatalog.LegacyZenBase`）
  - `ZenRefresher` 匿名 tier 发现：`upstream.zen` 用 key 拉失败且 `config.anonymous` 时改用 `upstream.anonymous` + `'public'` 拉，记到 `zenModels`。
  - `fetchModels` 抛带 `status` 的错误（或返回 status），404 → 用 `LEGACY_ZEN_BASE` 重试一次。

- [ ] **Step 1: 写失败测试**
  ```ts
  // upstream.zen 404 → 回退 LEGACY_ZEN_BASE 成功
  // upstream.anonymous 404 → 回退 LEGACY_ZEN_BASE
  // 两者都失败 → errors 有记录且 zen 计数不变
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/gateway/refresh.go` `refreshAnonymousTier` 404 回退 + `refreshZen` 末尾匿名回退。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `feat(zen): 匿名 tier 模型发现与 404 legacy base 回退`

### Task 14: client cancel 499（#gateway.go #76）

**Files:**

- Modify: `packages/zen/src/gateway/runtime.ts`、`packages/zen/src/gateway/upstream.ts`（`doUpstream`/`doAnonymousUpstream` 返回值带取消标记）
- Test: `packages/zen/src/__tests__/gateway-runtime.test.ts`（追加）

**Interfaces:**

- Produces:
  - `export function isClientCanceled(requestSignal: AbortSignal | undefined, error: unknown): boolean` —— 请求信号已 abort 且错误不是 DeadlineExceeded（对应 Go `wire.ClientCanceled`）。
  - 上游错误的 outcome 区分 `client_canceled` vs `transport_error`；传播到 runtime，让上层能返回 499 而非 502。

- [ ] **Step 1: 写失败测试**
  ```ts
  const ac = new AbortController();
  ac.abort();
  assert.equal(isClientCanceled(ac.signal, new Error('socket hang up')), true);
  assert.equal(
    isClientCanceled(ac.signal, Object.assign(new Error('d'), { name: 'TimeoutError' })),
    false,
  );
  assert.equal(isClientCanceled(undefined, new Error('x')), false);
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `gateway.go` `statusClientClosedRequest=499` + 取消分支。注意 zen 无 `wire.ClientCanceled`/`telemetry` 体系，用 AbortSignal 近似。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `feat(zen): 客户端取消区分为 client_canceled（#76）`

---

## 阶段 5 — 匿名工具真值化（需内嵌资产）

### Task 15: opencode-tools.ts + agent 工具覆盖（#upstream.go + #tool_images 前的 agent 部分）

**Files:**

- Create: `packages/zen/src/protocol/opencode-tools.ts`（内联 12 个工具真值，从上游 `internal/gateway/opencode_tools.json` 转 TS 常量）
- Modify: `packages/zen/src/protocol/agent.ts`（`CORE_AGENT_TOOLS` 改 `['shell','edit','glob','grep','read']`；`ensureTools` 改「已知名就地替换官方定义 + 追加缺失核心 + 未知名保持原样」）
- Modify: `packages/zen/src/index.ts`（导出）
- Test: `packages/zen/src/__tests__/protocol-agent.test.ts`（更新 `'bash'`→`'shell'` + 新增「官方定义覆盖客户端自带 shell」用例）

**Interfaces:**

- Produces:
  - `export const OPENCODE_TOOLS: Record<string, { description: string; parameters: unknown }>`（从 `opencode_tools.json` 逐字转）
  - `export function knownOpencodeTool(name: string): {...} | undefined`
  - `CORE_AGENT_TOOLS = ['shell','edit','glob','grep','read']`
  - `ensureTools`：客户端工具里已知名 → 用官方定义**就地替换**；未知名保持原样；追加缺失核心工具。

- [ ] **Step 1: 写失败测试**（更新 `protocol-agent.test.ts`：`'bash'`→`'shell'`；新增「客户端自带 shell 工具被官方定义覆盖」断言 `tools.find(t=>t.function.name==='shell').function.description === OPENCODE_TOOLS.shell.description`）
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/gateway/opencode_tools.json`（逐字转 TS 常量，16KB）+ `upstream.go` `anonymousCoreTools`/`ensureAnonymousTools`/`anonymousTool` + `protocol/agent.ts` 对应逻辑。tsup 单文件打包，直接 TS 常量，无需 embed。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `feat(zen): 匿名工具真值化——内联 opencode_tools 并覆盖客户端同名工具`

---

## 阶段 6 — protocol tool images（#62）

### Task 16: tool-images.ts + 三协议接线（#tool_images.go + #request.go + #content.go）

**Files:**

- Create: `packages/zen/src/protocol/tool-images.ts`
- Modify: `packages/zen/src/protocol/types.ts`（`ZenContentPart` 加 `mediaType?/data?` 或局部 block 类型）、`packages/zen/src/protocol/request.ts`（decode 接线）、`packages/zen/src/protocol/chat.ts` / `responses.ts` / `anthropic.ts`（tool 消息读 contentParts）、`packages/zen/src/index.ts`（导出）
- Test: `packages/zen/src/__tests__/protocol-tool-images.test.ts`（新建，覆盖每个校验分支到 85% 分支门槛）

**Interfaces:**

- Consumes: Task 15 的 agent 结构（同改 tool/匿名 body）。
- Produces:
  - `decodeToolImages(from: ZenProtocol, value: unknown): ZenContentPart[] | undefined` —— 仅 `[]any` 含 image 块时介入；Anthropic 用 `image`/`text`，OpenAI 用 `input_image`/`input_text`；逐块校验（Anthropic `source.type` url/base64；OpenAI `image_url` 非空无 file_id）；未知块报错；`data:` URI 拆成 `{url:'', mediaType, data}`。
  - `chatToolImages(result): { text: string; images: ZenContentPart[] }` —— 非数组回落纯文本；非 text part 写 marker `\n[tool_image call_id=<id> index=<n>]\n`（n 从 1）并成对产出 `[markerBlock, imageBlock]`。
  - `responsesToolContent(value): unknown` —— `input_text`/`input_image`（`image_url` 缺失用 `data:${mediaType};base64,${data}` 重建）。
  - `chat.ts` tool 消息：images 作为**额外 user 消息**追加在 tool 消息后；text 进 `role:'tool'` content。
  - `anthropic.ts` tool_result：`[]bridgeBlock` 递归 `encodeAnthropicBlocks`（对应 `content.go`）。

- [ ] **Step 1: 写失败测试**
  ```ts
  // Anthropic→Responses tool_result 带 base64 image → input_image + data: URI
  // tool_result 带 URL image → input_url 原样
  // 纯文本 tool_result 完全不变
  // Chat 目标 tool_result 不被 decode
  // 缺 call_id 的 image tool_result 抛错
  // Anthropic source base64 缺 media_type 抛错；OpenAI image_url + file_id 冲突抛错
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `internal/protocol/tool_images.go` 三个纯函数 + `request.go` `decodeBridgeRequest` 末尾接线 + `content.go` 递归 + 三协议编码器。建模决策：`ZenContentPart` 扩 `mediaType?/data?`（推荐，与 Go block 对齐）。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量（确认 85% 分支门槛，`tool-images.ts` 每个校验分支都有用例）。
- [ ] **Step 5: 提交** `feat(zen): 跨协议工具结果保留图片（#62）`

---

## 阶段 7 — monitor/usage（#77）

### Task 17: ZenAttemptRecord.session + per-session 用量（#telemetry/metrics.go #77）

**Files:**

- Modify: `packages/zen/src/gateway/monitor.ts`（`ZenAttemptRecord` 加 `session?`）、`packages/zen/src/gateway/upstream.ts`（`recordUpstreamAttempt` 填 `ids.session`）
- Create: `packages/zen/src/gateway/usage.ts`（per-session 累加 + LRU 500）
- Modify: `packages/zen/src/index.ts`（导出）
- Test: `packages/zen/src/__tests__/gateway-usage.test.ts`（新建）

**Interfaces:**

- Consumes: Task 11 的 `ZenRequestIds.session`、Task 9 的 `classifyAttemptError`。
- Produces:
  - `ZenAttemptRecord` 加 `session?: string`
  - `export class SessionUsageTracker` —— `record(session, tokens)` + `snapshot(): Map<string, TokenCounts>`；**LRU 上限 500，满时驱逐最久未见面**（不是总量最小——照 Go 注释，否则新对话顶掉上一个）。
  - `recordUpstreamAttempt` 填 `session: ids.session` + outcome 用 `classifyAttemptError` phase 后缀。

- [ ] **Step 1: 写失败测试**
  ```ts
  const t = new SessionUsageTracker(3);
  t.record('a', 10);
  t.record('b', 20);
  t.record('c', 30);
  t.record('a', 5); // touch a
  t.record('d', 40); // evict LRU (b, since a was touched)
  assert.equal(t.snapshot().has('b'), false);
  assert.equal(t.snapshot().get('a'), 15);
  ```
- [ ] **Step 2: 跑测试确认变红**。
- [ ] **Step 3: 实现**：对照 Go `telemetry/metrics.go` `addLifetimeSessionLocked` / `maxLifetimeSessions=500` / `Monitor.Record`。**不做** ServerKeys 维度与 60 桶环形窗口（FMF 走 callLogger）。
- [ ] **Step 4: 跑测试确认变绿** + zen 全量。
- [ ] **Step 5: 提交** `feat(zen): per-session token 用量追踪，LRU 500（#77）`

---

## 完成定义

- 17 个任务全部 commit；改动集 `prettier --check`、`eslint`、`build:runtime`、`typecheck` 全绿。
- `pnpm --filter @freemodelfinder/zen test` 全绿，覆盖率 ≥85% 行 / 74% 分支；core/server 全量无回归；无 `~/.freemodelfinder` 污染。
- 同步改的既有测试（避免 CI 红）：`client.test.ts`（UA）、`protocol-agent.test.ts`（bash→shell）、`gateway-probe.test.ts`（project/baseUrl）、`config.test.ts`（anonymous/freeOnly）、`core/providers/zen.test.ts`（listModels 结构）。
- 手工验收：`fmf serve` 后 opencode 匿名模型可正常调用（不再 403）；连续调用不锁死；`/v1/models` 带 reasoning_efforts/cost。
