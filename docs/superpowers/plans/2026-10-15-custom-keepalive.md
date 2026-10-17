# 自定义 CPA 保活（Keep-Alive）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网关后台定期 ping 用户接入的每个自定义 CPA（Render 免费容器），防止其 15 分钟无流量被 spin down；每个 source 独立开关与间隔，默认 14 分钟。

**Architecture:** server 层新增 `KeepAliveService`，`createApp` 启动时以 `unref` 定时器运行、`onClose` 时停止（复用 ModelWatcher 范式）。固定 1 分钟 tick，每轮对每个启用保活的自定义 source 判断是否到期（距上次 ping ≥ 该 source 的 `keepAliveMinutes`），到期则发 `GET <baseUrl>/models`（baseUrl 已规范化带 `/v1`）并记录 `lastPingedAt`（内存）。配置仅落在 `CustomSource` 上：`keepAlive?: boolean`（默认 true）+ `keepAliveMinutes?: number`（默认 14）。UI 在每个自定义 source 行加「参与保活」开关 + 间隔输入。

**Tech Stack:** TypeScript、Fastify、Node 内置 test runner（core/server）、Vitest + msw（ui）。无新增运行时依赖。

**Spec:** 对话内定需求（无独立 design 文档）。Render 免费 web 服务 15 分钟无入站流量即 spin down（官方文档）；保活间隔默认 14 分钟（< 15，留 1 分钟边界）；每个 source 独立控制。

## Global Constraints

- 必须中文回复与中文提交信息；每个任务一个 commit。
- ping 端点用 `GET <baseUrl>/models`（免费、不消耗 chat token）；**绝不**用 chat/completions。
- 默认间隔 **14 分钟**（< Render 15 分钟休眠阈值）；每个 source 可独立覆盖；可调范围 clamp 到 1..60 分钟。
- 每个 source 独立控制：`keepAlive` 默认 true（参与），`keepAliveMinutes` 默认 14；**无顶层总开关**。
- ping 失败一律**静默忽略**，不阻塞正常请求、不抛错、不记 call log。
- 定时器必须 `unref()`，`app.close()` 时 `clearInterval`（挂 `onClose` 钩子），不拖累进程退出。
- 出站用全局 `fetch`（`packages/server/src/proxy.ts` 已装 undici 代理），自带 `AbortSignal.timeout(15_000)`。
- 测试隔离：触达 `CONFIG_DIR` 的 core/server 测试须先设 `FREEMODELFINDER_HOME` 再动态 import。
- 门禁：改动集 `prettier --check` → `eslint` → `build:runtime` → `typecheck` → 各包 `test`。**绝不并行** `build:runtime` 与 `typecheck`/`test`。
- 测试命令：`pnpm --filter @freemodelfinder/core exec node --import tsx --test <file>`；server 同；UI 用 `pnpm --filter @freemodelfinder/ui test -- <name>`。

## Review Focus

1. **CPA 正好在休眠时 ping 失败** → 期望静默忽略、下轮重试，不抛错、不记日志。→ Task 2 用例 3。
2. **source 的 key 是加密存储的** → ping 必须用解密后的明文 key（`reg.getConfig()` 返回的 config 应为解密态，需实测确认）。→ Task 2 用例 2。
3. **source 没配 baseUrl 或 keepAlive=false** → 期望跳过该 source，不发请求。→ Task 2 用例 1。
4. **到期判断**：距上次 ping < 该 source 的 keepAliveMinutes 时不发，≥ 时才发；重启后首次 tick 应立即 ping 所有启用源（lastPingedAt 为空）。→ Task 2 用例 4、5。
5. **per-source 间隔不同** → 每个 source 按自己的 keepAliveMinutes 独立到期，不互相干扰。→ Task 2 用例 6。

---

### Task 1: core —— CustomSource 保活字段与默认值

**Files:**

- Modify: `packages/core/src/types.ts:32-38`（`CustomSource` 加两个字段）
- Modify: `packages/core/src/config/store.ts`（旧 config 迁移：缺失字段回落默认）
- Test: `packages/core/src/config/__tests__/store.test.ts` 或 `packages/core/src/providers/__tests__/`（追加）

**Interfaces:**

- Consumes: 既有 `CustomSource`（types.ts:32-38）。
- Produces:
  - `CustomSource` 新增 `keepAlive?: boolean`（默认 true；false 表示该 source 不参与保活）
  - `CustomSource` 新增 `keepAliveMinutes?: number`（默认 14；clamp 1..60）
  - `export function normalizeKeepAliveMinutes(value: unknown): number`（非法回落 14，clamp 1..60）—— 供 store 迁移与 server/UI 共用
  - `export const DEFAULT_KEEP_ALIVE_MINUTES = 14`

- [ ] **Step 1: 写失败测试**

```ts
import { normalizeKeepAliveMinutes, DEFAULT_KEEP_ALIVE_MINUTES } from '<core 导出路径>';
it('falls back to the default and clamps out-of-range keep-alive minutes', () => {
  assert.equal(DEFAULT_KEEP_ALIVE_MINUTES, 14);
  assert.equal(normalizeKeepAliveMinutes(undefined), 14);
  assert.equal(normalizeKeepAliveMinutes('abc'), 14);
  assert.equal(normalizeKeepAliveMinutes(0), 1);
  assert.equal(normalizeKeepAliveMinutes(999), 60);
  assert.equal(normalizeKeepAliveMinutes(20), 20);
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test <测试文件>`
Expected: FAIL —— `normalizeKeepAliveMinutes` 未导出。

- [ ] **Step 3: 实现**

`types.ts`：`CustomSource` 加 `keepAlive?: boolean` 与 `keepAliveMinutes?: number`（带注释）。新增 `normalizeKeepAliveMinutes` + `DEFAULT_KEEP_ALIVE_MINUTES`（放 types.ts 或 providers/custom.ts，从 core index 导出）。`store.ts`：确认 loadConfig 不清除这两个新字段（它们在 `extra.sources[]` 内，store 只加解密 apiKey，其它字段原样保留——**无需迁移代码**，仅需确认 `mapExtraSecrets` 不丢弃未知字段）。

- [ ] **Step 4: 跑测试确认变绿**

Run: 同上
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/providers/custom.ts packages/core/src/config/store.ts <测试文件>
git commit -m "feat(core): CustomSource 支持 per-source 保活开关与间隔（默认 14 分钟）"
```

---

### Task 2: server —— KeepAliveService 定时保活

**Files:**

- Create: `packages/server/src/keep-alive.ts`
- Modify: `packages/server/src/server.ts`（`createApp` 内启动 + `onClose` 停止，参照 watcher `server.ts:699-716`）
- Test: Create `packages/server/src/__tests__/keep-alive.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `normalizeKeepAliveMinutes`、`CustomSource`；`reg.getConfig()` 解密语义。
- Produces:
  - `export interface KeepAliveSource { id: string; baseUrl: string; apiKey?: string | string[]; keepAlive?: boolean; keepAliveMinutes?: number }`
  - `export class KeepAliveService { constructor(getSources: () => KeepAliveSource[], tickMs?: number); start(): void; stop(): void; tick(): Promise<void> }`
    - `start()` 立即 `void this.tick()` 再 `setInterval(() => void this.tick(), tickMs ?? 60_000).unref()`。
    - `tick()`：内存维护 `lastPingedAt: Map<string, number>`；对每个 `keepAlive !== false && baseUrl` 的 source，若 `now - (lastPingedAt.get(id) ?? 0) >= normalizeKeepAliveMinutes(keepAliveMinutes) * 60_000`，则 `ping(source)` 并 `lastPingedAt.set(id, now)`。
    - `ping(source)`：`fetch(baseUrl.replace(/\/$/,'') + '/models', { headers: { Authorization: 'Bearer ' + firstKey }, signal: AbortSignal.timeout(15_000) })`，`try/catch` 静默忽略（失败也更新 lastPingedAt，避免休眠期每 tick 重试）。
  - `createApp` 内 helper `customSourcesFrom(reg): KeepAliveSource[]`：读 `reg.getConfig().providers.custom?.credentials?.extra?.sources`，映射 `{ id, baseUrl, apiKey, keepAlive, keepAliveMinutes }`；启动 `new KeepAliveService(customSourcesFrom.bind(null, reg)).start()`，`app.addHook('onClose', () => keepAlive.stop())`。

- [ ] **Step 1: 写失败测试（新建 keep-alive.test.ts）**

顶部隔离模式（`mkdtempSync` + `FREEMODELFINDER_HOME` 再动态 import）。用替换 `globalThis.fetch` 记录 URL，测后还原。

```ts
function stubFetch(log: string[]) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    log.push(String(url));
    void init;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

it('pings only enabled sources that have a baseUrl', async () => {
  const log: string[] = [];
  const restore = stubFetch(log);
  try {
    const svc = new KeepAliveService(() => [
      { id: 'a', baseUrl: 'https://a.example.com/v1', keepAliveMinutes: 14 },
      { id: 'b', baseUrl: 'https://b.example.com/v1', keepAlive: false },
      { id: 'c', baseUrl: '' },
    ]);
    await svc.tick();
  } finally {
    restore();
  }
  assert.deepEqual(log, ['https://a.example.com/v1/models']);
});

it('sends the source key as a bearer token', async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({
      url: String(url),
      auth: (init?.headers as Record<string, string>)?.['Authorization'] ?? null,
    });
    return new Response('{}');
  }) as typeof fetch;
  try {
    const svc = new KeepAliveService(() => [
      { id: 'a', baseUrl: 'https://a.example.com/v1', apiKey: 'secret-key' },
    ]);
    await svc.tick();
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(seen[0]!.auth, 'Bearer secret-key');
});

it('ignores ping failures without throwing', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('CPA is asleep');
  }) as typeof fetch;
  try {
    const svc = new KeepAliveService(() => [{ id: 'a', baseUrl: 'https://a.example.com/v1' }]);
    await svc.tick(); // must not throw
  } finally {
    globalThis.fetch = orig;
  }
});

it('pings immediately on the first tick (fresh start) then respects the interval', async () => {
  const log: string[] = [];
  const restore = stubFetch(log);
  try {
    const svc = new KeepAliveService(() => [
      { id: 'a', baseUrl: 'https://a.example.com/v1', keepAliveMinutes: 14 },
    ]);
    await svc.tick(); // first tick → ping
    await svc.tick(); // immediate second tick → NOT due yet
  } finally {
    restore();
  }
  assert.deepEqual(
    log,
    ['https://a.example.com/v1/models'],
    'only the first tick pings; the second is not due',
  );
});

it('honors per-source intervals independently', async () => {
  const log: string[] = [];
  const restore = stubFetch(log);
  try {
    let now = 1_000_000;
    const sources = () => [
      { id: 'short', baseUrl: 'https://s.example.com/v1', keepAliveMinutes: 1 },
      { id: 'long', baseUrl: 'https://l.example.com/v1', keepAliveMinutes: 14 },
    ];
    const svc = new KeepAliveService(sources);
    await svc.tick(); // both ping (fresh)
    log.length = 0;
    now += 2 * 60_000; // 2 minutes later
    // Manually advance by re-creating with a clock is complex; instead assert
    // the interval math via a direct second construction is not needed here.
    await svc.tick();
  } finally {
    restore();
  }
  // short (1min) is due after 2min; long (14min) is not → only 'short' pings.
  assert.deepEqual(log, ['https://s.example.com/v1/models']);
});
```

注：用例 6 依赖 service 内部用 `Date.now()`；测试通过「两次 tick 间隔真实时间」不可控。**改用注入时钟**：`KeepAliveService` 构造加可选 `now: () => number = Date.now`，测试传可控时钟。更新 Interfaces：`constructor(getSources, tickMs?, now?)`。用例 6 用注入时钟推进。

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/keep-alive.test.ts`
Expected: FAIL —— `KeepAliveService` 未定义。

- [ ] **Step 3: 实现**

新建 `keep-alive.ts`：按 Interfaces（含注入时钟 `now`）实现。`server.ts` `createApp` 内加 `customSourcesFrom(reg)` + 启动/停止挂钩。

- [ ] **Step 4: 跑测试确认变绿 + server 全量**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: PASS（新定时器不破坏既有测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/keep-alive.ts packages/server/src/server.ts packages/server/src/__tests__/keep-alive.test.ts
git commit -m "feat(server): 新增自定义 CPA 定时保活服务，防 Render 免费实例休眠"
```

---

### Task 3: server —— 配置 API 透传 per-source 保活字段

**Files:**

- Modify: `packages/server/src/server.ts`（`POST /api/providers` custom 分支保留 `source.keepAlive`/`keepAliveMinutes`；`GET /api/config` 暴露）
- Test: `packages/server/src/__tests__/keep-alive.test.ts`（追加 1-2 个用例）

**Interfaces:**

- Consumes: Task 1 的 `normalizeKeepAliveMinutes`；既有 `/api/providers`、`/api/config` handler。
- Produces:
  - `POST /api/providers` 的 custom `sources[]` 每项支持 `keepAlive?: boolean`、`keepAliveMinutes?: number`（保存时用 `normalizeKeepAliveMinutes` clamp；未被提供的字段保留原值）。
  - `GET /api/config` 的 custom `sources[]` 脱敏视图每项带 `keepAlive`（布尔）与 `keepAliveMinutes`（数字，回落默认 14）。

- [ ] **Step 1: 写失败测试**

```ts
it('persists and reads back per-source keep-alive fields', async () => {
  // 起 server（含一个 custom source），POST /api/providers 写该 source 的
  // keepAlive=false, keepAliveMinutes=5，再 GET /api/config 断言回读一致。
  // 沿用 UI_HEADERS 与本机鉴权绕过。
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/keep-alive.test.ts`
Expected: FAIL —— 回读的 `keepAliveMinutes` 为默认/缺失。

- [ ] **Step 3: 实现**

`POST /api/providers`：custom sources 合并处（`server.ts:1566-1621` 一带）保留并写入每项的 `keepAlive`、`keepAliveMinutes`（clamp）。`GET /api/config`：sources 脱敏映射处（`server.ts:1091-1113`）补 `keepAlive`、`keepAliveMinutes`（回落默认）。

- [ ] **Step 4: 跑测试确认变绿 + server 全量**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/server.ts packages/server/src/__tests__/keep-alive.test.ts
git commit -m "feat(server): 配置接口透传每源保活开关与间隔"
```

---

### Task 4: ui —— 设置页每源保活开关与间隔

**Files:**

- Modify: `packages/ui/app/components/SettingsView.tsx`（每个自定义 source 行：保活开关 + 间隔输入）
- Modify: `packages/ui/app/i18n.tsx`（zh + en 各补 key）
- Modify: `packages/ui/test/server.ts`（msw：`/api/config` 的 custom sources 补 `keepAlive`/`keepAliveMinutes`）
- Test: Create `packages/ui/app/components/__tests__/settings-keepalive.test.tsx`

**Interfaces:**

- Consumes: Task 3 的 `/api/config` sources[].keepAlive/keepAliveMinutes；`POST /api/providers` 接受同字段。
- Produces: 无（叶子视图）。新增 i18n key：
  - `settings.keepAlive.title`（'保活' / 'Keep-alive'）
  - `settings.keepAlive.enabled`（'参与保活' / 'Keep-alive'）
  - `settings.keepAlive.interval`（'间隔（分钟）' / 'Interval (min)'）
  - `settings.keepAlive.hint`（'定期访问该服务，防止 Render 免费实例 15 分钟无流量被休眠。' / 'Periodically pings this service so a Render free instance is not spun down after 15 idle minutes.'）

- [ ] **Step 1: 写失败测试（新建 settings-keepalive.test.tsx）**

```tsx
it('renders per-source keep-alive controls and saves on change', async () => {
  render(<SettingsView />);
  const toggle = await screen.findByRole('switch', { name: /参与保活|Keep-alive/ });
  expect(toggle).toBeInTheDocument();
  const interval = screen.getByLabelText(/间隔（分钟）|Interval \(min\)/);
  expect(interval).toHaveValue(14);
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/ui test -- settings-keepalive`
Expected: FAIL —— 找不到保活控件。

- [ ] **Step 3: 实现**

`SettingsView` 每个自定义 source 行：读 `/api/config` 该 source 的 `keepAlive`/`keepAliveMinutes`，渲染一个 switch + number input（1..60，默认 14）。变更后 `POST /api/providers`（带该 source 更新后的字段）。沿用组件既有 per-source 保存模式。i18n 补中英 key。msw 桩：`/api/config` 的 custom sources 每项补 `keepAlive: true, keepAliveMinutes: 14`。

- [ ] **Step 4: 跑测试确认变绿 + UI 全量**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/app/components/SettingsView.tsx packages/ui/app/i18n.tsx packages/ui/test/server.ts packages/ui/app/components/__tests__/settings-keepalive.test.tsx
git commit -m "feat(ui): 设置页支持每源保活开关与间隔"
```

---

## 完成定义

- 4 个任务全部 commit；改动集 `prettier --check`、`eslint`、`build:runtime`、`typecheck` 全绿。
- core / server / ui 各包 `test` 全绿；无 `~/.freemodelfinder` 污染。
- 手工验收：`fmf serve` → 设置页给某自定义源开保活（默认 14 分钟）→ 观察网络，确认每 ~14 分钟对该源 `<baseUrl>/v1/models` 发一次 GET；关闭该源后不再 ping；改间隔后按新间隔生效；server 重启后首次立即 ping 一次。
