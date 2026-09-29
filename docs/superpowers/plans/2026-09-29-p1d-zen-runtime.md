# P1-D：Zen 代理/密钥池、刷新编排与上游状态机 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@freemodelfinder/zen` 中落地运行时：代理/密钥/匿名的节点池与健康冷却、模型与定价的刷新编排与磁盘缓存、以及「匿名优先 → key tier 回退」的上游执行状态机（含重试、错误分类、stale-reasoning 重放、attempt 监控），并组装成一个供 P1-E 消费的 `ZenGateway`。

**Architecture:** 新增 `packages/zen/src/gateway/{pool,health,refresh,runtime}.ts`；它们消费本包已有的 `http.ts`（传输）、`models/*`（目录/定价/发现/缓存）、`protocol/*`（请求/响应/流/agent/effort/stale）与 `gateway/monitor.ts`（attempt 记录）。对外暴露 `createZenGateway(...)`。

**Tech Stack:** TypeScript、Node.js 内置 test runner（`node --test` + `tsx`）。

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-zen-integration-design.md`（「路由与通道状态机」「代理池」「模型发现与定价」「错误处理」节）
**参考实现（磁盘上，逐字段对照）:** `E:\AImoney\opencode2api\opencode2api\internal\gateway\{pool,health,refresh,runtime,gateway,upstream}.go`、`internal/models\{cache,catalog,pricing,discovery}.go`

---

## 执行约定

与前面阶段一致：给出接口、测试与关键算法；逐字段行为对照磁盘 Go 源。**本阶段的重点是正确的状态机与错误处理，请务必先读对应 Go 文件。**

**必须承接的已登记项：**

- P1-B 延后清单（`LoadCache`/`SaveCache`、`PricingStore.fetch/Refresh/Start` + `loadCache`、`AvailableModels`/`Diagnostic`、`fetchModels` 返回状态码、`.mdx` 文档回退、定价 ID 归一化）。
- P1-C2 移交：流式同协议 `raw`/`rawProtocol` 回填；`signature` 承载（可显式记为有损）。
- P1-C3：`stripStaleReasoningInputs` 仅用于 Responses 载荷（调用方门控）。

## 文件结构（P1-D）

| 文件                                   | 职责                                                        | 任务 |
| -------------------------------------- | ----------------------------------------------------------- | ---- |
| `packages/zen/src/gateway/pool.ts`     | 代理传输、key 池、匿名池、绑定、游标                        | G1   |
| `packages/zen/src/gateway/health.ts`   | 代理健康与指数冷却                                          | G1   |
| `packages/zen/src/gateway/refresh.ts`  | 目录/定价刷新编排 + 磁盘缓存 + `.mdx` 回退                  | G2   |
| `packages/zen/src/gateway/upstream.ts` | `doUpstreamTiers`/匿名/key 执行、错误分类、重试、stale 重放 | G3   |
| `packages/zen/src/gateway/runtime.ts`  | `createZenGateway` 装配 + 公共 API                          | G4   |
| `packages/zen/src/index.ts`            | barrel 追加                                                 | G5   |

---

### Task G1: 代理传输、key 池、匿名池与健康冷却

**Files:**

- Create: `packages/zen/src/gateway/health.ts`
- Create: `packages/zen/src/gateway/pool.ts`
- Test: `packages/zen/src/__tests__/gateway-pool.test.ts`

参考：`internal/gateway/pool.go`（`upstreamNode`/`nodePool`/`anonymousNode`/`anonymousPool`/`Proxy`/`CursorFor`/`MarkSuccess`/`MarkFailure`）、`health.go`（代理复查）。

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/gateway-pool.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNodeHttpClient } from '../http.js';
import { parseProxyList } from '../proxy/spec.js';
import { ZenKeyPool, ZenAnonymousPool } from '../gateway/pool.js';

const proxies = parseProxyList(['direct', 'http://127.0.0.1:7890'], '');
const client = createNodeHttpClient();

describe('zen key pool', () => {
  it('balances keys across proxies and walks them by session cursor', () => {
    const pool = new ZenKeyPool(['k1', 'k2', 'k3'], proxies, client, {
      cooldownBaseMs: 15_000,
      maxAttempts: 3,
    });
    assert.equal(pool.len(), 3);
    const nodes = pool.all();
    assert.equal(nodes.length, 3);
    assert.equal(new Set(nodes.map((n) => n.proxy.name)).size, proxies.length);
    const cursor = pool.cursorFor('sess-a');
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const node = cursor.next();
      if (node) seen.add(node.keyId);
    }
    assert.equal(seen.size, 3);
  });

  it('keeps a key in cooldown out of the round-robin until it expires', () => {
    const pool = new ZenKeyPool(['k1', 'k2'], proxies, client, {
      cooldownBaseMs: 60_000,
      maxAttempts: 3,
    });
    const node = pool.all()[0]!;
    pool.markFailure(node, 429, undefined, Date.now() + 120_000);
    assert.equal(pool.inCooldown(node, Date.now()), true);
    const cursor = pool.cursorFor('s');
    const next = cursor.next();
    assert.notEqual(next?.keyId, node.keyId);
  });

  it('reports the earliest cooldown when every key is cooling', () => {
    const pool = new ZenKeyPool(['k1'], proxies, client, {
      cooldownBaseMs: 10_000,
      maxAttempts: 3,
    });
    const node = pool.all()[0]!;
    pool.markFailure(node, 500, undefined, undefined);
    const earliest = pool.earliestCooldown(Date.now());
    assert.ok(earliest === undefined || earliest > Date.now());
  });
});

describe('zen anonymous pool', () => {
  it('creates one node per proxy and walks them per session', () => {
    const pool = new ZenAnonymousPool(proxies, client);
    assert.equal(pool.len(), proxies.length);
    const cursor = pool.cursorFor('s');
    const first = cursor.next();
    assert.ok(first);
    const second = cursor.next();
    assert.ok(second);
  });

  it('marks a failing anonymous node and skips it while cooling', () => {
    const pool = new ZenAnonymousPool(proxies, client);
    const node = pool.nodes()[0]!;
    pool.markFailure(node, 403, undefined, undefined);
    assert.equal(pool.inCooldown(node, Date.now()), true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

实现要点（对照 Go）：

- `health.ts`：`ProxyHealth`（或内联）记录每个代理的失败次数与冷却到期时刻；冷却按指数增长，上限 = `failureCooldownSeconds × 8`；上游 `Retry-After` 更长时取更长。
- `pool.ts`：
  - `ZenProxyTransport { name; spec; client }`；
  - `ZenKeyNode { key; keyId; proxy }`，`keyId` 用 `config.KeyDisplayID` 等价（脱敏后缀）；
  - `ZenKeyPool`：构造时把 keys 均衡分配到 proxies（round-robin），`all()`、`len()`、`cursorFor(session)` 返回带 `next()` 的游标（会话哈希决定起点，跳过冷却节点；全部冷却时回退到最早结束冷却者，对齐 Go）、`proxy(node)`、`markSuccess`、`markFailure(node, status, error, retryAfterMs)`、`inCooldown`、`earliestCooldown`；
  - `ZenAnonymousPool`：每个代理一个 `anonymousNode`，`nodes()`、`len()`、`cursorFor(session)`、`markSuccess`、`markFailure`、`inCooldown`。

> 细节（会话哈希、指数冷却、全冷却回退、代理健康复查）以 Go `pool.go`/`health.go` 为准。请报告对照行号。

- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/gateway/health.ts packages/zen/src/gateway/pool.ts packages/zen/src/__tests__/gateway-pool.test.ts
git commit -m "feat(zen): 代理传输、密钥池、匿名池与健康冷却"
```

---

### Task G2: 刷新编排与磁盘缓存

**Files:**

- Create: `packages/zen/src/gateway/refresh.ts`
- Test: `packages/zen/src/__tests__/gateway-refresh.test.ts`

参考：`internal/gateway/refresh.go`、`internal/models/{cache,catalog,discovery,pricing}.go`。

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/gateway-refresh.test.ts`：用假 `fetchImpl` 喂 `/v1/models`、能力目录与 models.dev 三份固定 JSON，断言：

- 刷新后 `catalog.list()` 含两 tier 的模型并集；
- `snapshot()` 的 zen/go/total 正确；
- 定价 store 的 `decide` 对零成本模型返回 allowed；
- 刷新结果写入磁盘缓存且能重新加载（用临时目录）。

（具体断言由实现者按 `ZenCatalog`/`ZenPricingStore` 的既有 API 编写；测试文件顶部用 `mkdtemp`。）

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`gateway/refresh.ts` 提供 `ZenRefresher`：

- 依赖注入：`config`、`httpClient`（用于 `/v1/models` 的别名 GET 可用 `fetchImpl`）、`fetchImpl`、`catalog`、`pricing`、`monitor`、`logger?`、`now?`；
- `refreshOnce()`：并行抓取 zen/go `/v1/models`（`fetchModels`，Key 用 `public` 或首个 key）、能力目录（`fetchCapabilities`，含 `.mdx` 文档回退）、models.dev 定价（`decodeModelsDev`）；
- 把结果合并后调用 `catalog.replace({ zen, go, native, unsupported, metadata })`（注意 `fetchCapabilities` 不产出模型清单，需与 `fetchModels` 结果合并）；
- 更新 `pricing.replace(...)` 并写磁盘缓存（`<configPath>.models.catalog.json` / `.models.dev.json`，用 `models/cache.ts` 的 `writeJsonCache`）；
- `start()` 定时刷新（`models.refreshSeconds`），`stop()` 取消；
- `loadCache()` 启动时读缓存（覆盖 P1-B 登记的 `LoadCache`；含 `schema_version` 校验，版本不符则丢弃）。

> 逐字段的合并/缓存结构以 Go `cache.go`/`refresh.go` 为准；`schema_version` 值需与 Go 一致或自定义并记录。

- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/gateway/refresh.ts packages/zen/src/__tests__/gateway-refresh.test.ts
git commit -m "feat(zen): 刷新编排与目录/定价磁盘缓存"
```

---

### Task G3: 上游执行状态机

**Files:**

- Create: `packages/zen/src/gateway/upstream.ts`
- Test: `packages/zen/src/__tests__/gateway-upstream.test.ts`

参考：`internal/gateway/upstream.go`（`doUpstream`/`doUpstreamTiers`/`doAnonymousUpstream`/`doKeyUpstream`/`isNonRetryableClientResponse`/stale 重放）、`internal/telemetry`。

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/gateway-upstream.test.ts`：用假的 `ZenHttpClient`（可编程返回 200/403/429/500/网络错误 + SSE 体）驱动状态机，断言：

- 匿名成功：`doUpstream` 用匿名节点、返回 200、monitor 记录 1 次 anonymous attempt；
- 匿名 403：换下一个匿名代理；全部匿名失败后进入 key tier；
- key tier：按 prefer 顺序、`retry.maxAttempts` 内轮换 key；4xx（非 401/403/429）结束该 tier；
- stale reasoning：首次 400（含过期标记）→ 剥离后重放一次并成功；
- ctx 超时：不再对未尝试的节点记失败。

（测试用注入的 fake node pools 与 fake http client；不要打真网络。）

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

实现要点（对照 Go）：

- `doUpstream(route, request, ids, bodies)`：返回 `{ response, effectiveRoute }`；
- `doUpstreamTiers`：匿名先行（`doAnonymousUpstream`，每代理最多一次；对每个 body 先 `prepareAnonymousBody`），失败且 `ctx` 未过期则进入 `route.keyTiers`（按 prefer；每个 tier 用其协议 `prepareRequest` 重编码，`applyForcedEffort` 后发出）；tier 内 `retry.maxAttempts` 轮换；
- 错误分类：`isNonRetryableClientResponse`（4xx 除 401/403/429 → 不重试、结束 tier）；网络/5xx/429/401/403 可重试；
- stale reasoning 重放：仅当响应 400 且 `isStaleReasoningReference(体)` 且 tier 协议为 `responses` → `stripStaleReasoningInputs` 后重放一次；
- `ctx.Err()` 闸门：超时后停止、不惩罚未尝试节点；`Retry-After` 解析进冷却；
- monitor.record 每次 attempt；
- 流式：`streamUpstream` 走同一路由逻辑，成功后返回底层 `IncomingMessage` 供 SSE 解析；同协议时把原始 SSE 行填入 `StreamChunk.raw`（承接 P1-C2 移交项）。

> **这是本阶段最复杂的一块**，务必对照 `upstream.go` 逐函数移植；报告对照行号。

- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/gateway/upstream.ts packages/zen/src/__tests__/gateway-upstream.test.ts
git commit -m "feat(zen): 上游执行状态机（匿名优先/key 回退/重试/stale 重放）"
```

---

### Task G4: Gateway 装配与公共 API

**Files:**

- Create: `packages/zen/src/gateway/runtime.ts`
- Test: `packages/zen/src/__tests__/gateway-runtime.test.ts`

参考：`internal/gateway/{runtime,gateway}.go`。

- [ ] **Step 1: 写失败测试**

断言 `createZenGateway({ config, proxies, ...injectables })` 返回的对象具备：`listRoutes(hasZenKeys, hasGoKeys, hasAnonymous)`、`snapshot()`、`chat(request)`、`stream(request)`、`start()`、`stop()`、`refresh()`、`monitor()`；且在只配匿名（无 key）时 `listRoutes` 仍返回匿名可用模型。

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**

`createZenGateway(options)`：组装 `ZenKeyPool`/`ZenAnonymousPool`/`ZenCatalog`/`ZenPricingStore`/`ZenRefresher`/`ZenHttpClient`，暴露：

- `listRoutes(...)`：`catalog.availableModels(...)` 等价；
- `chat(request)`：`catalog.route(...)` → `doUpstream` → 非流式响应 → `convertResponse`（同协议回填 `raw`）；
- `stream(request)`：`doUpstream`（流式）→ SSE 解析 → `parse*Chunk` → `ZenStreamChunk` 迭代器（同协议填 `raw`）；
- `refresh`/`start`/`stop`/`monitor`（承接 P1-B 的 `AvailableModels`/`Diagnostic` 可在此暴露）。

- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/gateway/runtime.ts packages/zen/src/__tests__/gateway-runtime.test.ts
git commit -m "feat(zen): ZenGateway 装配与公共 API"
```

---

### Task G5: barrel 与整合验证

**Files:**

- Modify: `packages/zen/src/index.ts`
- Test: 无新增（跑全量）

- [ ] **Step 1: 更新 barrel**

追加 `export * from './gateway/health.js';`、`'./gateway/pool.js'`、`'./gateway/refresh.js'`、`'./gateway/upstream.js'`、`'./gateway/runtime.js'`。若有同名歧义改显式导出并报告。

- [ ] **Step 2: 全量验证**

Run: `pnpm --filter @freemodelfinder/zen test && pnpm --filter @freemodelfinder/zen typecheck && pnpm --filter @freemodelfinder/zen build && pnpm build:runtime && pnpm typecheck && pnpm lint`
Expected: 全部通过。

- [ ] **Step 3: 提交**

```bash
git add packages/zen/src/index.ts
git commit -m "feat(zen): P1-D 模块导出"
```

---

## 验收清单（P1-D）

- [ ] `pnpm --filter @freemodelfinder/zen test` 全绿
- [ ] `pnpm build:runtime`、`pnpm typecheck`、`pnpm lint` 通过
- [ ] 仅本计划列出的文件被提交
- [ ] P1-B/P1-C2/P1-C3 登记的承接项在报告中逐条说明（已实现 / 显式记为有损 / 归 P1-E）

## 后续

- **P1-E**：core 薄壳 provider（映射 core `ChatRequest`↔`ZenRequest`、`ZenChatResponse`↔`ChatResponse`）、registry/auto-router/配额接线、server `hasKey`、UI 面板/i18n、CLI、audit、Dockerfile、`verify-release`、环境变量与文档；消费 `raw`/`rawProtocol`。

## 自查记录

1. **Spec 覆盖**：spec「代理池」（G1）、「模型发现与定价」的刷新与缓存（G2）、「路由与通道状态机」「错误处理」（G3）、「包结构」的 runtime 装配（G4）。
2. **占位符扫描**：本阶段以 Go 源为权威，已在执行约定与各任务显式说明；G1 给出较完整接口与测试（具体冷却/哈希算法对照 Go）。
3. **类型一致性**：消费 P1-A/B/C 既有 API（`ZenHttpClient`/`ZenCatalog`/`ZenPricingStore`/`protocol/*`/`ZenAttemptMonitor`），不引入新协议类型。
