# models.dev 全局 context 兜底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任何 provider 的模型缺失 `contextWindow` 时，用 models.dev 全局数据补齐，使模型页不再大面积显示"上下文未知"。

**Architecture:** core 新增一个独立模块 `models-dev-context.ts`，拉取 `https://models.dev/api.json`、按模型 id 做多数投票解码成 `Map<string, number>`，磁盘缓存于 `CONFIG_DIR/models.dev.context.json`；`registry.refreshModels()` 在聚合完成后、dedup 之前，对缺失 `contextWindow` 的模型做同步 `lookup()`。UI 侧在模型卡 context 缺失且 provider 为 `custom` 时给出填写入口（复用已有 `onOpenSettings`）。

**Tech Stack:** TypeScript、Node 内置 `node --test` + tsx（core）、Vitest + RTL（ui）、tsup 构建。

**Spec:** 无独立 spec 文档；决策来源为本次 brainstorming 结论（多数投票取值、兜底落空保持未知 + 快捷入口），逐条固化在下方 Global Constraints。

## Global Constraints

- 必须用中文回复；**不得推送代码**，改完提醒用户，等用户明确同意才 push。
- 直接在 `main` 分支上做，每个 Task 一个 commit，不自行 push。
- 兜底**只补 `contextWindow === undefined` 的模型**，绝不覆盖 provider 已提供的值。
- 取值策略：**多数投票**；票数平局取**更小值**（路由器 `inputTokens <= contextWindow * 0.95`，虚高比虚低更危险）。
- 匹配策略两级：先用 `model.id` 原样查表，未命中且 `model.id` 含 `/` 时再用最后一段查表；**命中失败一律返回 `undefined`**（保持"上下文未知"，不做模糊匹配）。
- 兜底数据来源：`https://models.dev/api.json`，缓存路径 `join(CONFIG_DIR, 'models.dev.context.json')`，TTL `24 * 60 * 60 * 1000`，网络超时 `10_000`（`AbortSignal.timeout`）。
- 缓存文件格式：`{ updated_at: number; table: Record<string, number> }`。
- **兜底不得拖慢或拖垮 `refreshModels`**：磁盘读取与网络刷新失败都必须吞掉错误（记录后继续），网络刷新走后台不 await。
- **测试必须隔离配置目录**：任何触碰 `CONFIG_DIR` 的测试先设 `process.env.FREEMODELFINDER_HOME = testHome`（临时目录）并在结束时清理——这是 `478b70c` 修过的污染问题，不得复发。
- 门禁顺序：`format:check`(改动集) → `lint` → `build:runtime` → `typecheck` → `test:coverage`。**绝不并行 `build:runtime` 与 `typecheck`/`test:coverage`**（共享 `packages/server/dist` 会 EPERM）。
- PowerShell 下取退出码用 `$out = & cmd 2>&1; $code=$LASTEXITCODE`；commit message 先写文件再 `git commit -F`。

## Review Focus

1. **兜底覆盖已有值** —— openrouter 等已从上游拿到 `context_length` 的模型，经 `refreshModels()` 后值必须原样不变。归属 Task 3 测试：`keeps provider-supplied contextWindow untouched`。
2. **投票取错值** —— 同 id 出现 1000000×2、327680×3 时必须得 327680；1000000×1、1048576×1 平局必须得 1000000。归属 Task 1 测试：`picks the most frequent context value` / `breaks ties toward the smaller value`。
3. **前缀去除误匹配** —— `cline-free/deepseek-v4.1-flash` 命中 `deepseek-v4.1-flash` 是对的，但表里没有的 `some/ghost-model` 必须返回 `undefined`，不得因为去前缀而落到别的键上。归属 Task 2 测试：`returns undefined for unknown ids instead of guessing`。
4. **网络失败传染** —— fetch 拒绝或超时挂起时，`refreshModels()` 必须照常返回完整模型列表，兜底静默跳过。归属 Task 3 测试：`still returns all models when the context fetch fails`。
5. **缓存损坏/污染** —— 损坏的 `models.dev.context.json` 不得抛错，`lookup()` 保持返回 `undefined`；测试跑完不得在真实 `~/.freemodelfinder` 留下文件。归属 Task 2 测试：`ignores a corrupt cache file without throwing` + Global Constraints 的隔离要求。

---

### Task 1: `decodeContextTable` 解码与多数投票

**Files:**
- Create: `packages/core/src/models-dev-context.ts`
- Test: `packages/core/src/__tests__/models-dev-context.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `decodeContextTable(data: unknown): Map<string, number>` —— 输入 models.dev 原始 payload，输出 `模型标识 → context window` 的全局表。Task 2 的磁盘加载与网络刷新都只消费这个函数的返回值。

- [ ] **Step 1: 写失败测试**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeContextTable } from '../models-dev-context.js';

const model = (ctx?: number, canonical?: string) => ({
  ...(ctx !== undefined ? { limit: { context: ctx } } : {}),
  ...(canonical !== undefined ? { canonical_model_id: canonical } : {}),
});

test('indexes both the model id and its canonical id', () => {
  const table = decodeContextTable({
    deepseek: {
      models: {
        'deepseek-v4-flash': {
          id: 'deepseek-v4-flash',
          ...model(1_000_000, 'deepseek/deepseek-v4-flash'),
        },
      },
    },
  });
  assert.equal(table.get('deepseek-v4-flash'), 1_000_000);
  assert.equal(table.get('deepseek/deepseek-v4-flash'), 1_000_000);
});

test('picks the most frequent context value', () => {
  const table = decodeContextTable({
    a: { models: { 'x': { id: 'x', ...model(1_000_000) } } },
    b: { models: { 'x': { id: 'x', ...model(1_000_000) } } },
    c: { models: { 'x': { id: 'x', ...model(327_680) } } },
  });
  assert.equal(table.get('x'), 1_000_000);
});

test('breaks ties toward the smaller value', () => {
  const table = decodeContextTable({
    a: { models: { 'x': { id: 'x', ...model(1_048_576) } } },
    b: { models: { 'x': { id: 'x', ...model(1_000_000) } } },
  });
  assert.equal(table.get('x'), 1_000_000);
});

test('skips models without a positive context limit', () => {
  const table = decodeContextTable({
    a: {
      models: {
        noLimit: { id: 'noLimit' },
        zero: { id: 'zero', ...model(0) },
        text: { id: 'text', limit: { context: '128k' } },
      },
    },
  });
  assert.equal(table.size, 0);
});

test('rejects a payload that is not an object', () => {
  assert.throws(() => decodeContextTable('nope'));
});

test('rejects a payload that yields no context metadata', () => {
  assert.throws(() => decodeContextTable({ a: { models: { x: { id: 'x' } } } }));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test -- models-dev-context`
Expected: FAIL，模块 `../models-dev-context.js` 不存在。

- [ ] **Step 3: 实现 `decodeContextTable`**

在 `packages/core/src/models-dev-context.ts` 中实现。要点（签名与测试已定，未定的只有内部结构）：

- 解析前先 `asRecord(data)`，非对象 `throw new Error('models.dev payload is not an object')`。
- 遍历每个 provider 的 `models` 记录；`model['id'] ?? recordKey` 作为主键，`canonical_model_id` 为非空字符串时作为第二主键。
- `limit.context` 仅接受 `> 0` 的 `number`。
- 累计结构用 `Map<string, Map<number, number>>`；每轮取 `count` 最大者，**平局取 `context` 更小者**。
- 没有任何条目入表时抛 `new Error('models.dev contains no context metadata')`（与 `decodeModelsDev` 空表抛错的既有风格一致）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test -- models-dev-context`
Expected: PASS（6 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/models-dev-context.ts packages/core/src/__tests__/models-dev-context.test.ts
git commit -F <commit-message-file>
```
commit message: `feat(zen/core): decode models.dev global context table with majority vote`

---

### Task 2: `ModelsDevContextStore` 缓存与两级匹配

**Files:**
- Modify: `packages/core/src/models-dev-context.ts`（追加 Store）
- Test: `packages/core/src/__tests__/models-dev-context.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `decodeContextTable(data: unknown): Map<string, number>`
- Produces:
  - `class ModelsDevContextStore` —— `lookup(model: { provider: string; id: string }): number | undefined`（同步）、`loadFromDisk(): Promise<void>`、`refresh(): Promise<void>`（均不抛）
  - `modelsDevContextStore(): ModelsDevContextStore` —— 模块级单例，Task 3 从 registry 调用

- [ ] **Step 1: 写失败测试**

追加到 `packages/core/src/__tests__/models-dev-context.test.ts`。**每个用例先设 `process.env.FREEMODELFINDER_HOME` 到临时目录**，用 `afterEach` 还原，并在 `afterEach` 里删除临时目录——这是 `478b70c` 修过的污染问题。`fetchImpl`、`dir`、`now` 均通过构造参数注入，参照 `packages/core/src/providers/cline-catalog.ts` 的既有注入风格。

```ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
let previousHome: string | undefined;
const writeTable = (table: Record<string, number>) => {
  mkdirSync(join(home), { recursive: true });
  writeFileSync(join(home, 'models.dev.context.json'), JSON.stringify({ updated_at: Date.now(), table }));
};
const storeOf = (fetchImpl: typeof fetch = (async () => { throw new Error('offline'); }) as typeof fetch) =>
  new ModelsDevContextStore({ dir: home, fetchImpl });

beforeEach(() => {
  previousHome = process.env.FREEMODELFINDER_HOME;
  home = mkdtempSync(join(tmpdir(), 'fmf-ctx-'));
  process.env.FREEMODELFINDER_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.FREEMODELFINDER_HOME;
  else process.env.FREEMODELFINDER_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test('matches a prefixed cline id by its last segment', async () => {
  writeTable({ 'deepseek-v4.1-flash': 1_000_000 });
  const store = storeOf();
  await store.loadFromDisk();
  assert.equal(store.lookup({ provider: 'cline', id: 'cline-free/deepseek-v4.1-flash' }), 1_000_000);
  assert.equal(store.lookup({ provider: 'cline', id: 'deepseek/deepseek-v4-flash' }), undefined);
});

test('returns the raw id hit before trying the last segment', async () => {
  writeTable({ 'a/b': 8_192, b: 65_536 });
  const store = storeOf();
  await store.loadFromDisk();
  assert.equal(store.lookup({ provider: 'custom', id: 'a/b' }), 8_192);
});

test('returns undefined for unknown ids instead of guessing', async () => {
  writeTable({ 'deepseek-v4.1-flash': 1_000_000 });
  const store = storeOf();
  await store.loadFromDisk();
  assert.equal(store.lookup({ provider: 'custom', id: 'some/ghost-model' }), undefined);
});

test('ignores a corrupt cache file without throwing', async () => {
  writeFileSync(join(home, 'models.dev.context.json'), '{ not json');
  const store = storeOf();
  await store.loadFromDisk();
  assert.equal(store.lookup({ provider: 'custom', id: 'anything' }), undefined);
});

test('refresh survives a network failure', async () => {
  const store = storeOf();
  await store.refresh();
  assert.equal(store.lookup({ provider: 'custom', id: 'anything' }), undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test -- models-dev-context`
Expected: FAIL，`ModelsDevContextStore is not a function/undefined`。

- [ ] **Step 3: 实现 `ModelsDevContextStore` 与单例**

- 构造参数：`{ dir?: string; fetchImpl?: typeof fetch; ttlMs?: number; timeoutMs?: number; now?: () => number }`，默认值 `dir = CONFIG_DIR`、`ttlMs = 24*60*60*1000`、`timeoutMs = 10_000`。
- 缓存文件 `join(dir, 'models.dev.context.json')`，写入 `{ updated_at, table: Object.fromEntries(map) }`。
- `lookup()` 按 Global Constraints 的两级匹配，`undefined` 一律透传。
- `loadFromDisk()` / `refresh()` 内部 `try/catch` 全包，失败只记录 `lastError`，**不 reject**。
- `refresh()`：`AbortSignal.timeout(timeoutMs)` 的 fetch → `decodeContextTable` → 内存表 + 写盘；`updated_at` 超过 `ttlMs` 时 `loadFromDisk` 才重新读盘。
- 单例 `modelsDevContextStore()` 持有一个实例，构造后立即 `void refresh()`（后台预热）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test -- models-dev-context`
Expected: PASS（Task 1 的 6 个 + 本任务 5 个）。

- [ ] **Step 5: Commit**

commit message: `feat(core): models.dev context store with disk cache and two-level id match`

---

### Task 3: registry 兜底接入

**Files:**
- Modify: `packages/core/src/registry.ts`（`refreshModels()` 内，`deduped` Map 构建之前）
- Test: `packages/core/src/registry/__tests__/registry.test.ts`（追加用例）

**Interfaces:**
- Consumes: `modelsDevContextStore(): ModelsDevContextStore` 的 `lookup(model)`（Task 2）
- Produces: `refreshModels()` 返回的 `ListAllModelsResult.models[]` 中，缺失 `contextWindow` 的条目被补上（表内有匹配时）

- [ ] **Step 1: 写失败测试**

沿用该测试文件既有的 registry 搭配方式（注入 provider 列表 + 临时 `FREEMODELFINDER_HOME`），追加三条：

1. `fills contextWindow from the models.dev table` —— provider 返回 `{ id: 'cline-free/deepseek-v4.1-flash', free: true, contextWindow: undefined }`，预置 context 表含 `deepseek-v4.1-flash → 1_000_000`，断言 refresh 后 `contextWindow === 1_000_000`。
2. `keeps provider-supplied contextWindow untouched` —— provider 返回 `contextWindow: 32_768` 且表内同 id 为 `1_000_000`，断言结果仍为 `32_768`。
3. `still returns all models when the context fetch fails` —— `fetchImpl` 拒绝，断言模型列表长度与 id 完整、且 `contextWindow` 为 `undefined`、整个 `refreshModels()` 正常 resolve。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test -- registry`
Expected: FAIL —— 用例 1、3 失败（当前无人兜底）；用例 2 因无兜底逻辑而"意外通过"，属正常，Step 4 一并复验。

- [ ] **Step 3: 实现接入**

在 `registry.ts` 的 `refreshModels()` 中、`const deduped = new Map<string, ModelInfo>()` 之前插入：

```ts
const contextTable = modelsDevContextStore();
for (const model of models) {
  if (model.contextWindow !== undefined) continue;
  const ctx = contextTable.lookup(model);
  if (ctx !== undefined) model.contextWindow = ctx;
}
```

`lookup` 是同步内存操作；Store 的磁盘加载与网络刷新由 Task 2 的单例构造时后台完成，**此处不加 await、不加网络调用**。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test -- registry`
Expected: PASS（含用例 2 的复验）。

- [ ] **Step 5: Commit**

commit message: `feat(core): backfill missing model contextWindow from models.dev`

---

### Task 4: UI 快捷入口

**Files:**
- Modify: `packages/ui/app/components/FinderView.tsx`（第 362-365 行 context 展示区）
- Modify: `packages/ui/app/i18n.tsx`（中英各一条新 key）
- Test: `packages/ui/app/components/__tests__/finder-context.test.tsx`（新建，渲染方式照抄 `finder-aliases.test.tsx` 的 `renderFinder`/`cardOf`）

**Interfaces:**
- Consumes: 已有 `FinderView` prop `onOpenSettings: () => void`
- Produces: i18n key `models.ctx.set`（中文"填写上下文"、英文"Set context"）

- [ ] **Step 1: 写失败测试**

```tsx
const CUSTOM_NO_CTX: ModelItem = { id: 'my-model', provider: 'custom', display_name: 'My Model' };
const CLINE_NO_CTX: ModelItem = { id: 'cline-free/x', provider: 'cline', display_name: 'Cline X' };
const WITH_CTX: ModelItem = { id: 'gpt', provider: 'openrouter', display_name: 'GPT', context_window: 128_000 };
```

1. custom 且 `context_window` 缺失 → 卡片内出现"填写上下文"按钮；点击调用 `onOpenSettings`（`toHaveBeenCalledTimes(1)`）。
2. cline 且缺失 → 卡片内**只有**"上下文未知"，**没有**该按钮。
3. `context_window: 128_000` → 显示含 `128,000` 的文本，**没有**该按钮。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/ui test -- finder-context`
Expected: FAIL，`Unable to find Text = 上下文未知/填写上下文` 之一（按钮尚不存在）。

- [ ] **Step 3: 实现**

`FinderView.tsx` 把 `{formatContext(item.context_window, t)}` 改为条件渲染：

- `item.context_window` 有值 → 现状不变。
- 无值且 `item.provider === 'custom'` → 保留"上下文未知"文本，另加一个 `<button onClick={onOpenSettings}>` 文案 `t('models.ctx.set')`。
- 无值且非 custom → 仅"上下文未知"。

`i18n.tsx` 在 `models.ctx.unknown` 旁各加中英一条 `models.ctx.set`。

- [ ] **Step 4: 运行确认通过 + UI 回归**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: PASS（新用例 + 既有 251 个）。

- [ ] **Step 5: Commit**

commit message: `feat(ui): offer a context entry point for custom models left unknown`

---

### 收尾（不属于独立 Task）

- [ ] 全量门禁：`pnpm format:check`（只看改动集）→ `pnpm lint` → `pnpm build:runtime` → `pnpm typecheck` → `pnpm test:coverage`（串行，后者 >15 分钟，用 background 跑并读日志确认 EXIT=0）。
- [ ] 确认工作区无残留（`git status` 干净，测试未在真实 `~/.freemodelfinder` 留下 `models.dev.context.json` 之外的新文件）。
- [ ] 提醒用户可推送，**等用户同意后再 push**。
