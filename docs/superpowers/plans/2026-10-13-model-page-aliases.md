# 别名统一到「模型」页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「模型」页每张卡片上直接配别名（内置厂商 + 自定义来源都覆盖），下线「设置 → 自定义」的来源级别名编辑器，并让「网关 → 可用模型」的模型选择框可搜索。

**Architecture:** 别名仍存全局扁平 `config.modelAliases`（别名名 → composed 模型 id），解析内核与服务端接口**零改动**。UI 顶层（`page.tsx`）持有一份别名 map（`GET /api/model-aliases`），反查后向下传给 `FinderView`（卡片编辑）与 `SettingsView`（选择器补 `alias`）。保存走既有 `POST /api/model-aliases`（整表替换）：**先 re-fetch 最新表作为基底，只改当前这一个 key，再整表提交**。

**Tech Stack:** Next.js 16（React 19）+ Vitest + React Testing Library + msw。

**Spec:** `docs/superpowers/specs/2026-10-13-model-page-aliases-design.md`

## Global Constraints

- core **零改动**：`registry.ts`（`resolveModel`/`toClientFacingModel`/`resolveAlias`）、`config/aliases.ts`、`config/removal-cleanup.ts` 一行不改。
- server **零改动**：`/api/model-aliases` GET/POST、`/api/auto-route/model-options` 不新增不修改。
- 别名 target 必须是 **composed 真实 id**（`modelValue(m)` = `alias_of ?? id` 再拼 `provider:`）；禁用 `/v1/models` 的 `data[].id`（那是别名）当 target。
- 存储语义：**一个模型一个别名**。`POST /api/model-aliases` 是整表替换 + fail-fast（首个非法条目 400 整表拒绝）。
- 后端已拒：别名名含 `:`、等于 `auto`/`default`、`Object.prototype` 上的键、指向自身、两个别名指向同一 target。
- 别名名**允许**含 `/`（历史 `novaway/glm` 必须继续有效）；**允许**等于某个真实模型 id。
- 历史前缀别名不迁移、不特殊处理。
- 悬空别名清理交给 core 的 watcher（`buildRemovalCleanupPlan`），UI 不做清理。
- i18n 中英文**双份**都要加/删。
- UI 基线：改动前 `pnpm --filter @freemodelfinder/ui test` 全绿；每个 Task 后必须仍全绿。
- 提交规则：每个 Task 一个 commit；**不自动 push**（用户说「推送」才推）。
- 测试命令：单文件 `pnpm --filter @freemodelfinder/ui test app/path/to/file.test.tsx`；全量 `pnpm --filter @freemodelfinder/ui test`。

## Review Focus

以下五类输入/失败模式是 spec 暗示但任务测试容易漏掉、真实使用中最可能被踩到的。每行注明归属 Task 的测试：

1. **target 口径用错**（拿 `/v1/models` 的 `data[].id`——也就是别名——当 target）→ 别名指向一个不存在的模型。归属 **Task 3**：用一个 `id !== alias_of` 的模型，断言 `POST` payload 的 **value 是真实 composed id**。
2. **改名的旧名残留**（`glm` → `gpt` 后 `glm` 仍指向同一模型）→ 后端直接 400 `duplicates an existing alias target`。归属 **Task 1**：`applyAliasEdit` 必须先删掉所有 `value === target` 的条目再写入新名。
3. **保存基底陈旧**（用组件初始 map 而非服务端最新表当基底）→ 覆盖掉 CLI / 手改 / removal-cleanup 的并发改动。归属 **Task 3**：`GET` 返回的表与本地 state 故意不同，断言 `POST` 以服务端最新表为基础。
4. **纯空白 / 首尾空格输入**（输入 `"   "` 或 `" x "`）→ 前者必须按「清除」处理（不写 key），后者必须 trim 后写入 `x`。归属 **Task 1**。
5. **搜索框空/空白查询**（清空搜索词、只输入空格）→ 必须恢复完整列表且不显示空态。归属 **Task 4**。

---

### Task 1: 纯函数 `lib/modelAliases.ts`

**Files:**

- Create: `packages/ui/app/lib/modelAliases.ts`
- Test: `packages/ui/app/lib/__tests__/modelAliases.test.ts`

**Interfaces:**

- Consumes: 无（纯函数，输入输出都是 plain 对象）
- Produces:
  - `function invertAliases(aliases: Record<string, string>): Map<string, string>` — 返回 `target → 别名名`
  - `type AliasNameError = { key: string; params?: Record<string, string | number> }`
  - `function validateAliasName(name: string, target: string, aliases: Record<string, string>): AliasNameError | null`
  - `function applyAliasEdit(aliases: Record<string, string>, target: string, name: string): Record<string, string>`
  - 错误 key 常量（i18n key，Task 2 会加对应文案）：`finder.alias.error.colon`、`finder.alias.error.reserved`、`finder.alias.error.invalid`、`finder.alias.error.taken`

- [ ] **Step 1: Write the failing test**

Create `packages/ui/app/lib/__tests__/modelAliases.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { applyAliasEdit, invertAliases, validateAliasName } from '../modelAliases';

const T1 = 'openrouter:gpt-4o-mini';
const T2 = 'custom:novay:glm-5.3';

describe('invertAliases', () => {
  it('maps target to alias name', () => {
    expect(invertAliases({ glm: T2, 'novay/glm': T1 })).toEqual(
      new Map([
        [T2, 'glm'],
        [T1, 'novay/glm'],
      ]),
    );
  });
  it('returns an empty map for an empty table', () => {
    expect(invertAliases({})).toEqual(new Map());
  });
});

describe('validateAliasName', () => {
  it('accepts an empty name as "clear"', () => {
    expect(validateAliasName('', T1, {})).toBeNull();
  });
  it('treats a whitespace-only name as "clear"', () => {
    expect(validateAliasName('   ', T1, {})).toBeNull();
  });
  it('accepts a normal name', () => {
    expect(validateAliasName('nemotron', T1, {})).toBeNull();
  });
  it('accepts a name containing "/" (legacy prefix form stays legal)', () => {
    expect(validateAliasName('novay/glm', T1, {})).toBeNull();
  });
  it('rejects a name containing ":"', () => {
    expect(validateAliasName('a:b', T1, {})?.key).toBe('finder.alias.error.colon');
  });
  it('rejects reserved routing keywords', () => {
    expect(validateAliasName('auto', T1, {})?.key).toBe('finder.alias.error.reserved');
    expect(validateAliasName('default', T1, {})?.key).toBe('finder.alias.error.reserved');
  });
  it('rejects Object.prototype keys', () => {
    expect(validateAliasName('toString', T1, {})?.key).toBe('finder.alias.error.invalid');
  });
  it('reports the owning target when the name is taken by another model', () => {
    const err = validateAliasName('glm', T2, { glm: T1 });
    expect(err?.key).toBe('finder.alias.error.taken');
    expect(err?.params).toEqual({ name: 'glm', model: T1 });
  });
  it('does not report a conflict when the name already belongs to this target', () => {
    expect(validateAliasName('glm', T1, { glm: T1 })).toBeNull();
  });
});

describe('applyAliasEdit', () => {
  it('writes a new alias', () => {
    expect(applyAliasEdit({}, T2, 'glm')).toEqual({ glm: T2 });
  });
  it('drops the previous name when renaming (no orphan alias for the same target)', () => {
    expect(applyAliasEdit({ glm: T2 }, T2, 'gpt')).toEqual({ gpt: T2 });
  });
  it('trims the name before writing', () => {
    expect(applyAliasEdit({}, T2, '  glm  ')).toEqual({ glm: T2 });
  });
  it('deletes the target on an empty name', () => {
    expect(applyAliasEdit({ glm: T2, keep: T1 }, T2, '')).toEqual({ keep: T1 });
  });
  it('removes the key entirely on a whitespace-only name', () => {
    expect(applyAliasEdit({ glm: T2 }, T2, '   ')).toEqual({});
  });
  it('preserves unrelated entries', () => {
    expect(applyAliasEdit({ keep: T1 }, T2, 'glm')).toEqual({ keep: T1, glm: T2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @freemodelfinder/ui test app/lib/__tests__/modelAliases.test.ts`
Expected: FAIL — 模块不存在（`Failed to resolve import "../modelAliases"`）

- [ ] **Step 3: Implement `packages/ui/app/lib/modelAliases.ts`**

三个函数都是小体量纯函数：`invertAliases` 建 Map；`validateAliasName` 按固定顺序检查（trim 后为空 → `null`；含 `:`；`auto`/`default`；`in Object.prototype`；`aliases[name]` 存在且 `!== target` → taken）；`applyAliasEdit` 先删所有 `value === target`，再在 trim 后非空时写入。`validateAliasName` 的 `taken` 分支 `params` 为 `{ name, model: aliases[name] }`（`name` 用 trim 后的值）。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @freemodelfinder/ui test app/lib/__tests__/modelAliases.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/app/lib/modelAliases.ts packages/ui/app/lib/__tests__/modelAliases.test.ts
git commit -m "feat(ui): add model-alias pure helpers (validate/invert/apply)"
```

---

### Task 2: `ModelAliasInput` 组件

**Files:**

- Create: `packages/ui/app/components/ModelAliasInput.tsx`
- Modify: `packages/ui/app/i18n.tsx`（新增 `finder.alias.*`，中英双份）
- Test: `packages/ui/app/components/__tests__/model-alias-input.test.tsx`

**Interfaces:**

- Consumes: `validateAliasName`、`AliasNameError`（Task 1）；`useI18n`（`../i18n`）；`classNames`（`../lib/utils`）
- Produces:
  - `interface ModelAliasInputProps { target: string; alias?: string; aliases: Record<string, string>; disabled?: boolean; onSave: (target: string, name: string) => Promise<void> }`
  - `export function ModelAliasInput(props: ModelAliasInputProps)`
  - i18n keys：`finder.alias.label`、`finder.alias.placeholder`、`finder.alias.saved`、`finder.alias.saving`、`finder.alias.remove`、`finder.alias.error.colon`、`finder.alias.error.reserved`、`finder.alias.error.invalid`、`finder.alias.error.taken`、`finder.alias.error.saveFailed`

- [ ] **Step 1: Add i18n keys**

在 `packages/ui/app/i18n.tsx` 的中文表（紧跟 `finder.card.desc.default` 一带）与英文表各加同一组 key。中文取值示例：`label`=`别名`、`placeholder`=`例如 nemotron`、`saved`=`已保存`、`saving`=`保存中…`、`remove`=`清除别名`、`error.colon`=`别名不能包含「:」`、`error.reserved`=`「{name}」是保留字，不能用作别名`、`error.invalid`=`「{name}」不是合法的别名`、`error.taken`=`「{name}」已被 {model} 使用`、`error.saveFailed`=`保存失败：{detail}`。英文对应：`Alias` / `e.g. nemotron` / `Saved` / `Saving…` / `Remove alias` / `Alias must not contain ":"` / `"{name}" is a reserved word` / `"{name}" is not a valid alias` / `"{name}" is already used by {model}` / `Save failed: {detail}`。

- [ ] **Step 2: Write the failing test**

Create `packages/ui/app/components/__tests__/model-alias-input.test.tsx`，用一个受控 harness 记录调用（`onSave` 为 `vi.fn(async () => {})`），覆盖：

- 无别名时渲染 `finder.alias.placeholder` 的输入框（`screen.getByPlaceholderText(/nemotron/)`）。
- 有别名（`alias="nemotron"`）时输入框 `displayValue` 为 `nemotron`。
- 输入 `glm` 后失焦（`user.click(document.body)` 或 `user.tab()`）→ `onSave` 被调用一次，参数 `(target, 'glm')`。
- 输入 `glm` 后回车 → `onSave` 被调用一次，参数 `(target, 'glm')`。
- 输入非法名 `a:b` 后失焦 → `onSave` **不被调用**，且页面出现 role=`alert` 且文案含 `:`。
- 输入已被别的 target 占用的名字（`aliases={{ other: 'some:other' }}`，别名 `other`）→ `onSave` 不被调用，alert 文案含 `已被`（zh 默认语言）。
- 清空输入框后失焦 → `onSave(target, '')` 被调用。
- `onSave` reject（`async () => { throw new Error('boom') }`）→ 出现 alert 文案含 `boom`。
- Esc 键 → 输入框恢复原值且 `onSave` 不被调用。

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @freemodelfinder/ui test app/components/__tests__/model-alias-input.test.tsx`
Expected: FAIL — `Failed to resolve import "../ModelAliasInput"`

- [ ] **Step 4: Implement `ModelAliasInput`**

要点：内部 `useState` 维护 `draft` 与 `error`；`useEffect` 在 `alias` prop 变化且非聚焦时同步 `draft`；`commit()` 走 `validateAliasName(draft, target, aliases)` → 有错则 `setError` 直接返回 → 否则 `setSaving(true)`、`await onSave(target, draft.trim())`、成功清 `error`、`catch` 时 `setError({ key: 'finder.alias.error.saveFailed', params: { detail: message } })`。渲染：`label` 文案 + 输入框 + 有别名时的清除按钮（`aria-label={t('finder.alias.remove')}`）+ 保存中/已保存状态；错误用 `role="alert"`。

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @freemodelfinder/ui test app/components/__tests__/model-alias-input.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ui/app/components/ModelAliasInput.tsx packages/ui/app/components/__tests__/model-alias-input.test.tsx packages/ui/app/i18n.tsx
git commit -m "feat(ui): add per-model alias input component"
```

---

### Task 3: 模型页接入别名编辑（`saveAlias` + `FinderView` + `page.tsx`）

**Files:**

- Create: `packages/ui/app/lib/saveAlias.ts`
- Test: `packages/ui/app/lib/__tests__/saveAlias.test.ts`
- Modify: `packages/ui/app/components/FinderView.tsx`（卡片插入别名行、搜索按别名、新增 props）
- Modify: `packages/ui/app/page.tsx`（别名 state + 传 props）
- Test: `packages/ui/app/components/__tests__/finder-aliases.test.tsx`

**Interfaces:**

- Consumes: `ModelAliasInput`（Task 2）、`applyAliasEdit` / `invertAliases`（Task 1）、`modelValue`（`lib/models.ts`）
- Produces:
  - `async function saveAlias(target: string, name: string): Promise<Record<string, string>>`（`lib/saveAlias.ts`；成功返回服务端**确认后**的新表，失败抛 `Error`）
  - `FinderView` 新增 props：`aliases: Record<string, string>`、`onSaveAlias: (target: string, name: string) => Promise<void>`
  - `page.tsx` 新增 `aliases` state（`setAliases` 由 `saveAlias` 的返回值驱动）

- [ ] **Step 1: Write the failing test for `saveAlias`**

Create `packages/ui/app/lib/__tests__/saveAlias.test.ts`（用 `packages/ui/test/server` 的 `server`/`gateway` + msw）：

- 正常路径：`GET` 返回 `{ 'cli-added': 'other:model' }`，`POST` 返回 `{ ok: true, modelAliases }`。调 `saveAlias('openrouter:gpt-4o-mini', 'shorty')` 后，断言 **`POST` body 的 `modelAliases` 同时含 `cli-added` 与 `shorty`**（Review Focus #3：基底来自服务端最新表，不是调用方旧状态），且返回值等于服务端回包。
- 清除路径：`GET` 返回 `{ glm: 'custom:novay:glm-5.3' }`，`saveAlias('custom:novay:glm-5.3', '')` 的 `POST` body 为 `{}`。
- 改名路径：`GET` 返回 `{ glm: T }`，`saveAlias(T, 'gpt')` 的 `POST` body 为 `{ gpt: T }`（Review Focus #2）。
- `POST` 400 且 body `{ error: 'alias "auto" is a reserved routing keyword' }` → `await expect(saveAlias(...)).rejects.toThrow('reserved')`。
- `GET` 500 → reject（不得在读取基底失败时仍然提交）。
- 断言 `GET` 与 `POST` 各只发生一次。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @freemodelfinder/ui test app/lib/__tests__/saveAlias.test.ts`
Expected: FAIL — `Failed to resolve import "../saveAlias"`

- [ ] **Step 3: Implement `saveAlias` in `packages/ui/app/lib/saveAlias.ts`**

```ts
export async function saveAlias(target: string, name: string): Promise<Record<string, string>> {
  // GET /api/model-aliases -> base (non-OK => throw)
  // next = applyAliasEdit(base, target, name)
  // POST /api/model-aliases { modelAliases: next } -> (non-OK => throw body.error ?? HTTP status)
  // return (await res.json()).modelAliases
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @freemodelfinder/ui test app/lib/__tests__/saveAlias.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing `FinderView` test**

Create `packages/ui/app/components/__tests__/finder-aliases.test.tsx`，直接渲染 `FinderView`（补全其必填 props：`models`、`selectedModel`、`gatewayReachable`、`loading`、`failures`、`onSelectModel`、`onOpenTester`、`onOpenSettings`、`onRefresh`、`onProbeModel`、`probingModels`，加上新的 `aliases`、`onSaveAlias`）。测试用模型：

```ts
const ALIASED = {
  id: 'nemotron',
  provider: 'nvidia',
  display_name: 'Nemotron',
  alias_of: 'nvidia/nemotron-3-super-120b-a12b',
};
const PLAIN = { id: 'gpt-4o-mini', provider: 'openrouter', display_name: 'GPT-4o Mini' };
```

覆盖：

- `aliases={{ nemotron: 'nvidia:nvidia/nemotron-3-super-120b-a12b' }}` 时，被改名卡片的输入框 `displayValue` 为 `nemotron`；未改名卡片的输入框为空。
- 在 `PLAIN` 卡片输入 `shorty` 并失焦 → `onSaveAlias` 被调用一次，参数 `('openrouter:gpt-4o-mini', 'shorty')`。
- **target 口径断言（Review Focus #1）**：把 `ALIASED` 卡片改名为 `nemo2` → 参数必须是 `('nvidia:nvidia/nemotron-3-super-120b-a12b', 'nemo2')`，**不能**是 `'nemotron'`。
- 搜索框输入 `nemotron` 时 `ALIASED` 卡片可见（按别名匹配，决策 b）。
- 搜索框输入 `openrouter` 时只剩 `PLAIN`。

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @freemodelfinder/ui test app/components/__tests__/finder-aliases.test.tsx`
Expected: FAIL — 别名输入框不存在 / 搜索不匹配别名

- [ ] **Step 7: 接入 `FinderView`**

用 `useMemo(() => invertAliases(aliases), [aliases])` 得到 `aliasByTarget`；卡片底部 `border-t` 那一行**之上**插入：

```tsx
<ModelAliasInput
  target={value}
  alias={aliasByTarget.get(value)}
  aliases={aliases}
  onSave={onSaveAlias}
/>
```

搜索过滤谓词把该模型的别名（`aliasByTarget.get(modelValue(model))`）并入 `visibleModels` 的被匹配字段。

- [ ] **Step 8: 接入 `page.tsx`**

新增 `const [aliases, setAliases] = useState<Record<string, string>>({})`，在已有初始化 effect 里加一次 `GET /api/model-aliases`（失败留空表，不阻塞）。传给 `FinderView` 的 `onSaveAlias`：

```ts
const onSaveAlias = async (target: string, name: string) => {
  setAliases(await saveAlias(target, name)); // 失败时 saveAlias 抛错，state 不动
};
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter @freemodelfinder/ui test app/components/__tests__/finder-aliases.test.tsx app/lib/__tests__/saveAlias.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/ui/app/lib/saveAlias.ts packages/ui/app/lib/__tests__/saveAlias.test.ts packages/ui/app/components/FinderView.tsx packages/ui/app/components/__tests__/finder-aliases.test.tsx packages/ui/app/page.tsx
git commit -m "feat(ui): configure model aliases from the models page"
```

---

### Task 4: `ModelMultiSelect` 搜索框

**Files:**

- Modify: `packages/ui/app/components/ModelMultiSelect.tsx`
- Modify: `packages/ui/app/i18n.tsx`（新增 `modelMultiSelect.search`，中英双份）
- Test: `packages/ui/app/components/__tests__/model-multi-select.test.tsx`

**Interfaces:**

- Consumes: 无（组件自带 `options` prop）
- Produces:
  - `ModelOption` 新增可选字段 `alias?: string`
  - 搜索框 `role="searchbox"`，`placeholder` = `t('modelMultiSelect.search')`
  - 打开状态下按 `id` / `displayName` / `provider` / `alias`（大小写不敏感子串）过滤；查询词在关闭下拉或点「清空」时重置

- [ ] **Step 1: Write the failing test**

Create `packages/ui/app/components/__tests__/model-multi-select.test.tsx`，用 `options`：

```ts
const OPTIONS = [
  { id: 'nvidia:nemotron', provider: 'nvidia', displayName: 'Nemotron', alias: 'nemotron' },
  { id: 'openrouter:gpt-4o-mini', provider: 'openrouter', displayName: 'GPT-4o Mini' },
];
```

覆盖：

- 打开下拉后出现 `role="searchbox"`。
- 输入 `gpt` → 只剩 `openrouter:gpt-4o-mini`（按 id/显示名）。
- 输入 `nemotron` → 只剩 `nvidia:nemotron`（**按别名**）。
- 输入 `nvidia` → 只剩 `nvidia:nemotron`（按厂商）。
- 输入 `zzz` → 显示 `modelMultiSelect.empty` 空态。
- **Review Focus #5**：输入 `   `（全空格）→ 不显示空态、两个选项都在；清空搜索词 → 两个选项都恢复。
- 关闭下拉再打开 → 搜索框回到空、两个选项都在。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @freemodelfinder/ui test app/components/__tests__/model-multi-select.test.tsx`
Expected: FAIL — 找不到 `role="searchbox"`

- [ ] **Step 3: Implement the search box**

`useState('')` 存 `query`；`filtered` 在现有 `matchesCapability` 之外再叠加查询谓词（`query.trim().toLowerCase()` 为空则不过滤）；面板顶部渲染 `<input role="searchbox" …>`；`useEffect` 在 `open` 变 false 时 `setQuery('')`；`clear()` 里一并 `setQuery('')`。`ModelOption` 接口加 `alias?: string`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @freemodelfinder/ui test app/components/__tests__/model-multi-select.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/app/components/ModelMultiSelect.tsx packages/ui/app/components/__tests__/model-multi-select.test.tsx packages/ui/app/i18n.tsx
git commit -m "feat(ui): add search to ModelMultiSelect"
```

---

### Task 5: 下线来源级别名编辑器

**Files:**

- Delete: `packages/ui/app/components/SourceAliasesEditor.tsx`
- Delete: `packages/ui/app/lib/sourceAliases.ts`、`packages/ui/app/lib/customAliasSave.ts`
- Delete: `packages/ui/app/components/__tests__/source-aliases-editor.test.tsx`、`packages/ui/app/components/__tests__/settings-custom-aliases.test.tsx`、`packages/ui/app/lib/__tests__/sourceAliases.test.ts`
- Modify: `packages/ui/app/components/SettingsView.tsx`、`packages/ui/app/i18n.tsx`
- Test: 沿用 `packages/ui/app/components/__tests__/settings*.test.tsx` 中现有的来源保存用例（若不存在则本 Task 新建一条最小用例）

**Interfaces:**

- Consumes: 无
- Produces: `SettingsView` 保存自定义来源时**只** `POST /api/providers`；不再有任何 `来源id/*` 别名改写

- [ ] **Step 1: 解绑 `SettingsView`**

删除 `SourceAliasesEditor` 的 import 与渲染（来源卡片内）、`customAliases` state（含 `setCustomAliases`）、`saveCustomProvider` 中对 `customAliases` 的读取与「先 aliases 后 sources」两次提交（退回只提交 `/api/providers`）、以及迁移提示（`settings.custom.legacyAliasesHint`）的渲染分支。确认 `commitCustomAliasSave` / `deriveSourceAliases` / `findLegacyBareAliases` 在 `packages/ui` 内再无引用（`grep` 一次）。

- [ ] **Step 2: 删文件与 i18n key**

删除上面列出的 6 个文件；`i18n.tsx` 删除 `settings.sourceAliases.*`（7 个 key × 中英）与 `settings.custom.legacyAliasesHint`（中英）。

- [ ] **Step 3: 写/改测试**

断言：设置里渲染自定义来源卡片时**不存在**别名编辑器（`screen.queryByText(/别名名/)` 为 null）；保存来源时**只**发出 `POST /api/providers`（msw 记录请求，断言没有 `POST /api/model-aliases`）。**同时断言保存来源不会再改写已存在的别名**（例如 `GET /api/model-aliases` 返回 `{ 'novay/glm': 'custom:novay:glm-5.3' }` 时，保存来源后 `POST /api/model-aliases` 未被调用）。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: PASS；且 `grep -r "sourceAliases\|SourceAliasesEditor\|customAliasSave\|legacyAliasesHint" packages/ui/app` 无输出

- [ ] **Step 5: Commit**

```bash
git add -A packages/ui
git commit -m "refactor(ui): remove source-scoped alias editor"
```

---

### Task 6: 设置里的别名可见性（当前模型下拉 + 可用模型选择框）

**Files:**

- Modify: `packages/ui/app/components/SettingsView.tsx`（新增 `aliases` prop；当前模型下拉文案；`modelOptions` 补 `alias`）
- Modify: `packages/ui/app/page.tsx`（把 `aliases` 传给 `SettingsView`）
- Modify: `packages/ui/app/i18n.tsx`（新增 `settings.modelSelector.alias`，中英双份）
- Test: `packages/ui/app/components/__tests__/settings-alias-visibility.test.tsx`

**Interfaces:**

- Consumes: `aliases: Record<string, string>`（Task 3 的 state）、`invertAliases`（Task 1）
- Produces: `SettingsView` 新增 prop `aliases: Record<string, string>`；`ModelOption.alias`（Task 4）在 `modelOptions` 中被填充

- [ ] **Step 1: Write the failing test**

Create `packages/ui/app/components/__tests__/settings-alias-visibility.test.tsx`：

- **当前模型下拉（决策 a）**：`models` 含 `{ id: 'nemotron', provider: 'nvidia', display_name: 'Nemotron', alias_of: 'nvidia/nemotron-3-super-120b-a12b' }`、`aliases={{ nemotron: 'nvidia:nvidia/nemotron-3-super-120b-a12b' }}` → 该 `<option>` 文案含 `nemotron`。
- **可用模型选择框（决策 5）**：msw 让 `/api/auto-route/model-options` 返回 `{ models: [{ id: 'nvidia:nemotron', provider: 'nvidia', displayName: 'Nemotron' }] }`，`aliases` 同上 → 打开某个 key 的「可用模型」下拉，输入 `nemotron`（别名）仍能筛出该选项。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @freemodelfinder/ui test app/components/__tests__/settings-alias-visibility.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

- `SettingsView` props 加 `aliases`；`page.tsx` 传入。
- 当前模型 `<option>`（约 L1804）在 `invertAliases(aliases).get(modelValue(m))` 存在时把文案拼成 `[厂商] 显示名 · {t('settings.modelSelector.alias', { alias })}`。
- 构建 `modelOptions` 时（`/api/auto-route/model-options` 拉取后）用 `invertAliases(aliases)` 给每项补 `alias`。**注意**：`aliases` 变化时要重算（把补 alias 的动作放在渲染期的 `useMemo`，而不是只在 fetch 的 `.then` 里写死）。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @freemodelfinder/ui test app/components/__tests__/settings-alias-visibility.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/app/components/SettingsView.tsx packages/ui/app/components/__tests__/settings-alias-visibility.test.tsx packages/ui/app/page.tsx packages/ui/app/i18n.tsx
git commit -m "feat(ui): surface aliases in settings model pickers"
```

---

## 收尾（不属于任何 Task 的交付物）

- [ ] `pnpm --filter @freemodelfinder/ui test` 全绿
- [ ] `pnpm test:coverage` 全绿（core / server / cli / ui）
- [ ] `pnpm build:runtime` → `pnpm typecheck` → `pnpm lint`（0 warning）
- [ ] `pnpm format:check`（改动集干净）
- [ ] 人工冒烟：本地起 `pnpm dev:server` + `pnpm dev:ui`，在「模型」页给一个内置厂商模型配别名 → 在「网关 → 可用模型」里搜该别名 → 用该别名调一次 `/v1/chat/completions`；再把别名改成已被其他模型占用的名字，确认行内报错且不提交
- [ ] 提醒用户：远端 `119.29.157.227:11435` 跑的是旧构建，需要拉新包重启才生效
