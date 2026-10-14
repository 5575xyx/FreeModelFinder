# 统计看板：分页 / 日周月粒度 / 图表切换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让首页统计页支持调用日志游标分页、按天/周/月粒度的时间趋势，以及表格 ↔ 柱状图 ↔ 环形图切换。

**Architecture:** 数据聚合继续留在 `CallLogger`（core），新增一个「时间序列分桶」方法与一个「游标分页」入口；server 只做参数解析与透传，新增 `/api/stats/series`、给 `/api/logs` 加 `cursor`/`nextCursor`；UI 用**手写 SVG** 渲染图表（不引入任何图表依赖），并把 `StatsView` 的表格区做成可切换视图 + 日志区「加载更多」滚动容器。

**Tech Stack:** TypeScript、React 19、Next.js 16、Fastify、Node 内置 test runner（core/server）、Vitest + React Testing Library + msw（ui）。无新增运行时依赖。

**Spec:** 本次为对话内定的直接需求（无独立 design 文档）。需求原话：日志分页、按天/周/月统计、可滚动、可切换成图表/饼状图。

## Global Constraints

- 必须使用中文回复与中文提交信息；每个任务一个 commit。
- **不得引入图表库**（recharts/chart.js/d3/echarts 等一律不加）；图表用手写 SVG。
- 保持现有链路语义：`CallLogger.aggregate(range)` 的 `range` 取值在 `'today' | '7d' | '30d' | 'all'` 基础上**追加** `'90d'`，旧值行为不变。
- 时间分桶一律用**本地时区**，与既有 `dayKey()`/`startOfToday()` 一致；周起点为**周一**。
- 分页一律**游标式**（`cursor` 参数），不引入 offset。
- core/server 测试用 `node --test`（经 tsx）；ui 用 vitest。core 覆盖率门槛 85% lines / 74% branches，server 80%/75%，cli 80%，ui 由 vitest 配置控制。
- 门禁顺序：`prettier --check 改动集` → `eslint 改动集` → `pnpm build:runtime` → `pnpm typecheck` → 各包 `test`。**绝不并行** `build:runtime` 与 `typecheck`/`test:coverage`（共享 `packages/server/dist` → EPERM）。
- 测试隔离：core/server 测试若触达 `CONFIG_DIR`，必须在 import core 之前设 `FREEMODELFINDER_HOME`（`CONFIG_DIR` 在模块加载期解析）。**禁止**让测试写入开发机真实 `~/.freemodelfinder`。
- 测试命令：`pnpm --filter @freemodelfinder/core exec node --import tsx --test <file>`；UI 用 `pnpm --filter @freemodelfinder/ui test -- <name>`。

## Review Focus

以下 5 类输入/失败模式是 spec 未明说但最可能咬人的地方，各自已在对应任务的测试里钉死：

1. **同一毫秒的多条日志跨页丢失** —— 两条 `ts` 完全相同的记录恰好落在分页边界：期望两条都恰好返回一次，一条不丢、一条不重。→ Task 1 用例 3。
2. **空数据下的图表除零** —— `byModel` 为空或总量为 0 时环形图不能出现 `NaN`/除零，应渲染空态。→ Task 4 用例 3。
3. **周/月边界的本地时区归属** —— 周日 23:59 与周一 00:01 必须落到不同周；月末 23:59 与次月 1 日 00:01 必须落到不同月。→ Task 2 用例 2、3。
4. **空桶补齐** —— 某天/某周零调用时，趋势序列仍要产出该桶（值为 0），否则折线/柱状图会把时间轴压扁、看不出"哪天断了"。→ Task 2 用例 4。
5. **`cursor` 非法输入** —— 手改 URL 传入 `cursor=abc` / 负 skip：期望按"从头开始"而不是 500 或抛异常。→ Task 1 用例 4。

---

### Task 1: core —— 调用日志游标分页

**Files:**
- Modify: `packages/core/src/call-logger.ts`（新增 `CallLogCursor`、`parseCursor`、`CallLogPage`；改 `list`）
- Test: `packages/core/src/__tests__/call-logger.test.ts`（追加用例）

**Interfaces:**
- Consumes: 既有 `CallLogger`、`CallLogFilter`、`parseLine`、`collect()`。
- Produces:
  - `export interface CallLogCursor { ts: number; skip: number }`
  - `export function encodeCursor(cursor: CallLogCursor): string` → `` `${ts}:${skip}` ``
  - `export function decodeCursor(raw: string | undefined): CallLogCursor | null`（非法/缺省返回 `null`）
  - `export interface CallLogPage { data: CallLogEntry[]; nextCursor: string | null }`
  - `CallLogger.listPage(filter: CallLogFilter & { cursor?: string }): Promise<CallLogPage>`
  - `CallLogger.list()` 保持签名与返回类型不变（内部复用 `listPage`）。

- [ ] **Step 1: 写失败测试（追加到 `call-logger.test.ts`）**

沿用该文件既有的 `mkdtempSync(join(tmpdir(), ...))` + `new CallLogger(dir)` 写法（先迁 HOME 再动态 import，见该文件顶部注释）。

```ts
it('pages by cursor without losing or repeating entries that share a timestamp', async () => {
  const logger = new CallLogger(dir);
  const sameTs = 1_700_000_000_000;
  for (const model of ['a', 'b', 'c']) {
    logger.record({ ts: sameTs, kind: 'chat', provider: 'p', model, status: 'success', latencyMs: 1 });
  }
  logger.record({ ts: sameTs - 1, kind: 'chat', provider: 'p', model: 'd', status: 'success', latencyMs: 1 });
  await logger.flush();

  const first = await logger.listPage({ limit: 2 });
  assert.deepEqual(first.data.map((e) => e.model), ['a', 'b']);
  assert.ok(first.nextCursor);

  const second = await logger.listPage({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.data.map((e) => e.model), ['c', 'd']);

  const third = await logger.listPage({ limit: 2, cursor: second.nextCursor ?? undefined });
  assert.deepEqual(third.data, []);
  assert.equal(third.nextCursor, null);
});

it('starts from the beginning when the cursor is malformed', async () => {
  const logger = new CallLogger(dir);
  logger.record({ ts: 2, kind: 'chat', provider: 'p', model: 'x', status: 'success', latencyMs: 1 });
  await logger.flush();
  const page = await logger.listPage({ limit: 10, cursor: 'abc' });
  assert.deepEqual(page.data.map((e) => e.model), ['x']);
  assert.equal(page.nextCursor, null);
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/call-logger.test.ts`
Expected: FAIL —— `logger.listPage is not a function`。

- [ ] **Step 3: 实现游标分页**

在 `call-logger.ts` 加：`encodeCursor`/`decodeCursor`（`raw` 按 `lastIndexOf(':')` 拆，`ts`/`skip` 必须是有限数字且 `skip >= 0`，否则返回 `null`）；`listPage(filter)` 复用 `collect()` → 按 `ts desc` 稳定排序（`b.ts - a.ts || 稳定序`）→ 跳过已返回的 `(ts === cursor.ts && 已返回该 ts 的条数 < cursor.skip)` → 取 `limit` 条 → 若被截断则 `nextCursor = encodeCursor({ ts: last.ts, skip: <该 ts 在本页内出现次数 + (cursor 同 ts ? cursor.skip : 0)> })`，否则 `null`。`list()` 改为 `(await this.listPage(filter)).data`。

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/call-logger.test.ts`
Expected: PASS（含既有 7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/call-logger.ts packages/core/src/__tests__/call-logger.test.ts
git commit -m "feat(core): 调用日志支持游标分页，避免同毫秒记录跨页丢重"
```

---

### Task 2: core —— 日/周/月时间序列聚合 + 保留期 30→90 天

**Files:**
- Modify: `packages/core/src/call-logger.ts`（`RETENTION_DAYS`、新增 `series()` 与桶助手；`CallStatsResult['range']` 追加 `'90d'`）
- Test: `packages/core/src/__tests__/call-logger.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `collect()` 语义（未改动）；既有 `startOfToday`。
- Produces:
  - `export type CallStatsRange = 'today' | '7d' | '30d' | '90d' | 'all'`
  - `export type CallStatsBucket = 'day' | 'week' | 'month'`
  - `export interface CallStatsSeriesPoint { start: number; calls: number; errors: number; rateLimited: number; promptTokens: number; completionTokens: number; cachedTokens: number }`
  - `export interface CallStatsSeries { range: CallStatsRange; bucket: CallStatsBucket; since: number; until: number; points: CallStatsSeriesPoint[] }`
  - `CallLogger.series(range: CallStatsRange, bucket: CallStatsBucket, now?: number): Promise<CallStatsSeries>`
  - `export function startOfBucket(ts: number, bucket: CallStatsBucket): number`（day=本地 0 点；week=本地周一 0 点；month=本地 1 号 0 点）
  - `export function nextBucket(ts: number, bucket: CallStatsBucket): number`
  - `CallStatsResult['range']` 类型改为 `CallStatsRange`；`aggregate` 的 `since` 计算加 `'90d'` 分支（`now - 90 * 86_400_000`）。

- [ ] **Step 1: 写失败测试**

```ts
it('buckets a series by local day and zero-fills empty days', async () => {
  const logger = new CallLogger(dir);
  const now = new Date(2026, 9, 14, 12, 0, 0).getTime(); // 2026-10-14 本地
  logger.record({ ts: new Date(2026, 9, 12, 9, 0, 0).getTime(), kind: 'chat', provider: 'p', model: 'a', status: 'success', latencyMs: 1, promptTokens: 10 });
  logger.record({ ts: new Date(2026, 9, 14, 9, 0, 0).getTime(), kind: 'chat', provider: 'p', model: 'a', status: 'error', latencyMs: 1, promptTokens: 5 });
  await logger.flush();

  const series = await logger.series('7d', 'day', now);
  assert.equal(series.points.length, 8); // 10-07..10-14 含两端
  const byStart = new Map(series.points.map((p) => [new Date(p.start).getDate(), p]));
  assert.equal(byStart.get(13)!.calls, 0, '空缺日必须补 0');
  assert.equal(byStart.get(12)!.calls, 1);
  assert.equal(byStart.get(14)!.calls, 1);
  assert.equal(byStart.get(14)!.errors, 1);
  assert.equal(byStart.get(14)!.promptTokens, 5);
});

it('starts weeks on Monday in local time', () => {
  const sunday = new Date(2026, 9, 11, 23, 59, 0).getTime(); // 周日
  const monday = new Date(2026, 9, 12, 0, 1, 0).getTime(); // 周一
  assert.notEqual(startOfBucket(sunday, 'week'), startOfBucket(monday, 'week'));
  assert.equal(new Date(startOfBucket(monday, 'week')).getDay(), 1);
});

it('starts months at the local first day', () => {
  const monthEnd = new Date(2026, 8, 30, 23, 59, 0).getTime();
  const nextMonth = new Date(2026, 9, 1, 0, 1, 0).getTime();
  assert.notEqual(startOfBucket(monthEnd, 'month'), startOfBucket(nextMonth, 'month'));
  assert.equal(new Date(startOfBucket(nextMonth, 'month')).getDate(), 1);
});

// 既有用例「cleans up files older than retention」必须同步改：
// 它用 40 天前的记录断言被删，保留期改 90 天后会变红。
it('cleans up files older than the 90-day retention window', async () => {
  logger.record(entry({ ts: Date.now() - 91 * 86_400_000, model: 'ancient' }));
  logger.record(entry({ ts: Date.now() - 89 * 86_400_000, model: 'recent' }));
  await logger.flush();

  const removed = await logger.cleanup(Date.now());
  assert.equal(removed, 1, '只有 91 天前的文件被删');

  // 89 天前的记录仍能从磁盘读回（内存 buffer 里也有）
  const kept = await logger.list({ model: 'recent' });
  assert.ok(kept.length >= 1);
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/call-logger.test.ts`
Expected: FAIL —— `startOfBucket is not a function` / `logger.series is not a function`。

- [ ] **Step 3: 实现**

`startOfBucket`：day → `new Date(ts); setHours(0,0,0,0)`；week → 先取 day 起点，再 `setDate(getDate() - ((getDay() + 6) % 7))`（周一为 0）；month → `setDate(1)` 后取 day 起点。`nextBucket` 用 `setDate/setMonth` 加一（月用 `setMonth(getMonth()+1)` 前先 `setDate(1)` 防溢出）。`series()`：按 `range` 算 `since`（复用 `aggregate` 的同一张表，`'all'` 取最早记录 ts，无记录则 `since = until`），`until = now ?? Date.now()`，从 `startOfBucket(since)` 迭代到 `startOfBucket(until)` 生成全部桶（含空桶），`collect({ since })` 后按 `startOfBucket(e.ts)` 累加。`RETENTION_DAYS = 90`。

**桶数上限（防病态输入）**：若 `startOfBucket(since)` 到 `startOfBucket(until)` 的桶数 > 366，则把 `bucket` 降为 `'month'` 重算（`range='all'` 且历史跨度大时避免生成上千个点）。降级后的 `bucket` 必须如实出现在返回值里。

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/call-logger.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/call-logger.ts packages/core/src/__tests__/call-logger.test.ts
git commit -m "feat(core): 新增日周月时间序列聚合，保留期延长至 90 天"
```

---

### Task 3: server —— `/api/logs` 游标与 `/api/stats/series`

**Files:**
- Modify: `packages/server/src/server.ts:2034-2064`
- Test: Create `packages/server/src/__tests__/stats-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `listPage`、`decodeCursor`；Task 2 的 `series`、`CallStatsRange`、`CallStatsBucket`。
- Produces:
  - `GET /api/logs` 新增 query `cursor?: string`，返回 `{ data, nextCursor }`（`nextCursor: string | null`）；既有 query 与 `data` 语义不变。
  - `GET /api/stats/series?range=<today|7d|30d|90d|all>&bucket=<day|week|month>` → `CallStatsSeries`；非法 `range` 回落 `today`，非法 `bucket` 回落 `day`。
  - `GET /api/stats` 的 `range` 白名单追加 `'90d'`。

- [ ] **Step 1: 写失败测试（新建 `stats-routes.test.ts`）**

顶部沿用 `stream-usage.test.ts` 的隔离模式（先 `mkdtempSync` + `process.env.FREEMODELFINDER_HOME`，再动态 import core/server）。
**注意**：`createServer` 的返回值**不含** `callLogger`，因此测试自己 `new CallLogger(TMP_HOME)` 记录数据——server 内部实例用的是同一个 `CONFIG_DIR/logs` 目录（同进程、同 `TMP_HOME`），读得到。

```ts
it('returns a cursor page of logs and honors the status filter', async () => {
  const { app } = await createServer({ registry: stubRegistry(), watchIntervalMs: 3_600_000 });
  const logger = new CallLogger(TMP_HOME);
  for (const s of ['success', 'error', 'success'] as const) {
    logger.record({ ts: Date.now(), kind: 'chat', provider: 'p', model: 'm', status: s, latencyMs: 1 });
  }
  await logger.flush();

  const first = await app.inject({ method: 'GET', url: '/api/logs?limit=2' });
  assert.equal(first.statusCode, 200);
  const page = first.json() as { data: unknown[]; nextCursor: string | null };
  assert.equal(page.data.length, 2);
  assert.ok(page.nextCursor);

  const second = await app.inject({ method: 'GET', url: `/api/logs?limit=2&cursor=${encodeURIComponent(page.nextCursor!)}` });
  assert.equal((second.json() as { data: unknown[] }).data.length, 1);

  const errors = await app.inject({ method: 'GET', url: '/api/logs?status=error' });
  assert.equal((errors.json() as { data: unknown[] }).data.length, 1);
  await app.close();
});

it('serves a bucketed series and falls back on bad params', async () => {
  const { app } = await createServer({ registry: stubRegistry(), watchIntervalMs: 3_600_000 });
  const logger = new CallLogger(TMP_HOME);
  logger.record({ ts: Date.now(), kind: 'chat', provider: 'p', model: 'm', status: 'success', latencyMs: 1, promptTokens: 7 });
  await logger.flush();

  const ok = await app.inject({ method: 'GET', url: '/api/stats/series?range=today&bucket=week' });
  assert.equal(ok.statusCode, 200);
  const series = ok.json() as { bucket: string; points: { calls: number }[] };
  assert.equal(series.bucket, 'week');
  assert.equal(series.points.reduce((n, p) => n + p.calls, 0), 1);

  const bad = await app.inject({ method: 'GET', url: '/api/stats/series?range=nope&bucket=nope' });
  const badSeries = bad.json() as { range: string; bucket: string };
  assert.equal(badSeries.range, 'today');
  assert.equal(badSeries.bucket, 'day');
  await app.close();
});
```

（`stubRegistry()` 为测试内本地 helper，可照抄 `stream-usage.test.ts` 里 `registryWithStreamingProvider` 的最小形态：`new ProviderRegistry({ version: 2, port: 0, providers: {}, gateway: { requireAuth: false } })` 并 stub `listAllModels`。）

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/stats-routes.test.ts`
Expected: FAIL —— `/api/stats/series` 404、`nextCursor` 为 `undefined`。

- [ ] **Step 3: 实现路由**

`/api/logs` 的 handler 改用 `callLogger.listPage({...})`，query 加 `cursor`，直接 `return page`（`{ data, nextCursor }`）。新增 `/api/stats/series` handler：解析 `range`（白名单含 `90d`）与 `bucket`（`day|week|month`），回落默认后 `return await callLogger.series(range, bucket)`。/api/stats 的 `range` 白名单同步加 `'90d'`。（handler 内的 `callLogger` 是 `createServer` 内部的模块级实例，测试通过共享 `logs` 目录读写同一份数据，无需改 `createServer` 返回值。）

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --test src/__tests__/stats-routes.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/server.ts packages/server/src/__tests__/stats-routes.test.ts
git commit -m "feat(server): 日志接口返回游标，新增按日周月分桶的 stats series 接口"
```

---

### Task 4: ui —— 手写 SVG 图表组件

**Files:**
- Create: `packages/ui/app/components/charts/BarChart.tsx`
- Create: `packages/ui/app/components/charts/DonutChart.tsx`
- Test: `packages/ui/app/components/__tests__/charts.test.tsx`

**Interfaces:**
- Produces:
  - `BarChart({ points, ariaLabel, formatValue }: { points: { label: string; value: number; secondary?: number }[]; ariaLabel: string; formatValue?: (v: number) => string })` —— 纯 SVG，`role="img"`、`aria-label={ariaLabel}`，每根柱子带 `data-testid="bar"` 与 `data-value`。
  - `DonutChart({ slices, ariaLabel, formatValue }: { slices: { label: string; value: number }[]; ariaLabel: string; formatValue?: (v: number) => string })` —— 纯 SVG，`role="img"`，每个扇区 `data-testid="slice"`；**总量为 0 时渲染 `<p data-testid="chart-empty">` 而非扇区**。

- [ ] **Step 1: 写失败测试**

```tsx
it('renders one bar per point and labels the chart', () => {
  render(<BarChart points={[{ label: '10-14', value: 3 }, { label: '10-15', value: 0 }]} ariaLabel="趋势" />);
  expect(screen.getByRole('img', { name: '趋势' })).toBeInTheDocument();
  expect(screen.getAllByTestId('bar')).toHaveLength(2);
});

it('renders one slice per non-zero entry', () => {
  render(<DonutChart slices={[{ label: 'a', value: 5 }, { label: 'b', value: 5 }]} ariaLabel="占比" />);
  expect(screen.getAllByTestId('slice')).toHaveLength(2);
});

it('renders an empty state instead of dividing by zero when all values are zero', () => {
  render(<DonutChart slices={[{ label: 'a', value: 0 }]} ariaLabel="占比" />);
  expect(screen.getByTestId('chart-empty')).toBeInTheDocument();
  expect(screen.queryAllByTestId('slice')).toHaveLength(0);
  expect(document.body.textContent).not.toContain('NaN');
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/ui test -- charts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`BarChart`：`viewBox` 固定宽高，`max = Math.max(1, ...values)` 防除零；柱高按比例；`aria-label` 在 `<svg>`；值文本可选。`DonutChart`：`total = sum(values)`，`total <= 0` → 空态；否则用 `stroke-dasharray` 在圆形 `path`/`circle` 上按比例画扇区（避免手算 path 弧线），每段一个 `<circle data-testid="slice">`。均用现有 `classNames` 与主题色变量（`text-success`/`text-destructive`/`bg-surface` 等），不引入新依赖。`BarChart` 对 `points.length > 400` 只渲染末尾 400 个点（横轴过密无法阅读），并在 `aria-label` 末尾加上省略说明。

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm --filter @freemodelfinder/ui test -- charts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/app/components/charts packages/ui/app/components/__tests__/charts.test.tsx
git commit -m "feat(ui): 手写 SVG 柱状图与环形图组件，零新增依赖"
```

---

### Task 5: ui —— StatsView 接入分页、粒度切换与图表视图

**Files:**
- Modify: `packages/ui/app/components/StatsView.tsx`
- Modify: `packages/ui/app/i18n.tsx`（zh + en 各补 key）
- Modify: `packages/ui/test/server.ts`（msw：`/api/stats/series` 桩 + `/api/logs` 返回 `nextCursor`）
- Test: Create `packages/ui/app/components/__tests__/stats-view.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `/api/stats/series`（`{ range, bucket, since, until, points }`）与 `/api/logs`（`{ data, nextCursor }`）；Task 4 的 `BarChart`/`DonutChart`。
- Produces: 无（叶子视图）。新增 i18n key 清单：
  - `stats.range.90d`（'90 天' / '90 days'）
  - `stats.granularity.day|week|month`（'按天' '按周' '按月' / 'Daily' 'Weekly' 'Monthly'）
  - `stats.view.table|bar|pie`（'表格' '柱状图' '环形图' / 'Table' 'Bar' 'Pie'）
  - `stats.series.title`（'调用趋势' / 'Call trend'）
  - `stats.byModel.pie`（'模型占比' / 'Model share'）
  - `stats.logs.loadMore`（'加载更多' / 'Load more'）
  - `stats.logs.loadedCount`（'已加载 {count} 条' / 'Loaded {count}'）
  - `stats.chart.empty`（'该时间范围内暂无数据' / 'No data in this range'）

- [ ] **Step 1: 写失败测试（新建 `stats-view.test.tsx`）**

```tsx
it('appends older log entries when loading more and stops at the last page', async () => {
  // msw：首屏 /api/logs 返回 2 条 + nextCursor:'c1'；带 cursor=c1 返回 1 条 + nextCursor:null
  render(<StatsView />);
  expect(await screen.findAllByTestId('log-row')).toHaveLength(2);
  await userEvent.click(screen.getByRole('button', { name: /加载更多|Load more/ }));
  expect(await screen.findAllByTestId('log-row')).toHaveLength(3);
  expect(screen.queryByRole('button', { name: /加载更多|Load more/ })).toBeNull();
});

it('switches the trend between table, bar and pie views', async () => {
  render(<StatsView />);
  await userEvent.click(await screen.findByRole('button', { name: /柱状图|Bar/ }));
  expect(screen.getAllByTestId('bar').length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole('button', { name: /环形图|Pie/ }));
  expect(screen.getAllByTestId('slice').length).toBeGreaterThan(0);
});

it('requests the series endpoint with the selected granularity', async () => {
  const seen: string[] = [];
  // msw：记录 /api/stats/series 的 URL
  render(<StatsView />);
  await userEvent.click(await screen.findByRole('button', { name: /按月|Monthly/ }));
  expect(seen.some((u) => u.includes('bucket=month'))).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认变红**

Run: `pnpm --filter @freemodelfinder/ui test -- stats-view`
Expected: FAIL —— `log-row` 找不到、无"柱状图"按钮。

- [ ] **Step 3: 实现**

`StatsView`：`range` 增加 `'90d'`；新增 `granularity: 'day'|'week'|'month'`、`trendView: 'table'|'bar'|'pie'`、`logCursor`、`logsLoadingMore`。`refresh()` 并发拉 `/api/stats`、`/api/stats/series?range=&bucket=`、`/api/logs?limit=50&...`（首屏重置 `logCursor` 与 logs）；「加载更多」用当前 `logCursor` 追加并更新 `nextCursor`。趋势区头部放粒度切换（按天/周/月）与视图切换（表格/柱状图/环形图）；日志表外层加 `max-h-[420px] overflow-y-auto`，每行 `data-testid="log-row"`，表格下方放「加载更多」按钮（`nextCursor` 为空时不渲染）。柱状图喂 series points（label 用桶起始日期，value 用 `calls`，`secondary` 用 `errors + rateLimited`）；环形图喂 `byModel`（取前 8 名 + 其余合并为"其他"，i18n `stats.byModel.other`）。

- [ ] **Step 4: 跑测试确认变绿**

Run: `pnpm --filter @freemodelfinder/ui test -- stats-view`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/app/components/StatsView.tsx packages/ui/app/i18n.tsx packages/ui/test/server.ts packages/ui/app/components/__tests__/stats-view.test.tsx
git commit -m "feat(ui): 统计页支持分页加载、日周月粒度与图表切换"
```

---

## 完成定义

- 5 个任务全部 commit；`prettier --check` 改动集、`eslint` 改动集、`build:runtime`、`typecheck` 全绿。
- core / server / ui 各包 `test` 全绿；无 `~/.freemodelfinder` 污染。
- 手工验收：`fmf serve` 后打开首页统计页 —— 日志可「加载更多」并出现纵向滚动条；切换按天/周/月时趋势与接口 `bucket` 同步变化；表格/柱状图/环形图三态可切换；空数据下无 `NaN`。
