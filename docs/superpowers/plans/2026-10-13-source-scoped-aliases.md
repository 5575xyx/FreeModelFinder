# 别名配置入口挪到来源级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把别名配置入口从 Settings→Models 标签的全局列表挪到 Settings→Custom 标签的每个来源卡片内，别名名带来源前缀（`来源id/别名名`），实现来源限定命名空间；core 解析内核零改动。

**Architecture:** 别名仍存全局 `config.modelAliases` map（key 形如 `novaway/glm`，value 为 composed id `custom:novaway:glm-5.3`）。现有 `resolveModel` 的别名查找在 `:` 前缀解析之前，`/` 名零改动原样命中（已由 `4ccc60d` 的目录兜底保证不静默 fall-through）。改动全部在 UI：新增 `SourceAliasesEditor` 组件 + 纯函数 `deriveSourceAliases`（改写核心逻辑，可独立测试）+ `saveCustomProvider` 扩展（先 aliases 后 sources 两次提交）。

**Tech Stack:** Next.js 16（React 19）+ Vitest + React Testing Library + msw；core/server 零改动。

**Spec:** `docs/superpowers/specs/2026-10-13-source-scoped-aliases-design.md`

## Global Constraints

- core 解析内核（`registry.ts` 的 `resolveModel`/`toClientFacingModel`/`resolveAlias`、`aliases.ts` 的 `validateModelAliases`、`removal-cleanup.ts`）**一行不改**。
- 服务端 `/api/model-aliases` GET/POST 接口**不新增不修改**。
- 别名名禁用 `/`（防双前缀）、禁用 `:`（现有校验规则，保持）；`auto`/`default` 为预留字。
- 保存顺序：**先 `POST /api/model-aliases`，后 `POST /api/providers`**（sources 提交在前会制造悬空别名）。
- 改写基底：每次保存前 re-fetch `GET /api/model-aliases`（last-write-wins，与现有 save 语义一致）。
- 来源 id 不可重命名（现状 UI 就不允许；alias 流程不覆盖 rename）。
- 旧格式裸名（无 `来源id/` 前缀的别名）接受滞留：不自动迁移、无 UI 管理入口，仅迁移提示文案说明。
- i18n 中英文双份都要加。
- UI 基线：194/194 tests（16 files）全绿；`pnpm --filter @freemodelfinder/ui test` 必须保持全绿。
- 提交规则：每个 Task 一个 commit；不自动 push（用户说「推送」才推）。
- 测试命令：UI 用 `pnpm --filter @freemodelfinder/ui test`；server 用 `pnpm --filter @freemodelfinder/server test`；全量 `pnpm test:coverage`。

## Review Focus

以下五类输入/失败模式是 spec 暗示但任务测试没有直接覆盖的，最可能在真实使用中被踩到。每行注明归属 Task 的测试（该测试要钉住行为）：

1. **删除来源时 aliases 提交成功、sources 提交失败** → 中间态"来源仍在、旧前缀别名已剥"，用户重试保存即恢复一致；行为是报错 toast（不静默）→ 归属 **Task 4**（`saveCustomProvider` 失败分支测试：断言 toast 文案含"别名未同步"或等价提示、且 sources 未提交）。
2. **双 `/` 别名名（用户输入 `a/b`）** → 客户端会调出 `novaway/a/b` 这种不存在的别名，应被 UI 拦截且不产生提交 → 归属 **Task 3**（`SourceAliasesEditor` 校验测试：含 `/` 的输入不可保存/提交 payload 不含该条目）。
3. **hydrate 时服务端残留该来源前缀条目**（外部变更路径：手改 config / 重建被删来源 id） → 条目回填编辑器供用户审阅，不丢数据 → 归属 **Task 3**（GET 返回带前缀条目时渲染回填测试）。
4. **`/v1/models` 与响应 `model` 字段回显 `novaway/glm`（alias 名）而非 composed 模型名** → 反查正确性 → 归属 **Task 2**（server 端 `toClientFacingModel` 回显测试 + `/` 名 round-trip 测试）。
5. **`auto` 候选池（白名单 ∩ 可用模型）不感知 alias 名** → 受限 key 调 `auto` 仍按 composed 层匹配，alias 前缀名不参与 → 归属 **Task 2**（alias 名带前缀不影响 allowlist 解析的回归测试，或明确标注为现有 `ac221e3` 行为不回归）。

---

### Task 1: 纯函数 `deriveSourceAliases`（改写核心逻辑）

**Files:**
- Create: `packages/ui/app/lib/sourceAliases.ts`
- Test: `packages/ui/app/lib/__tests__/sourceAliases.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，输入为 plain 对象）
- Produces:
  - `interface SourceAliasEdit { alias: string; targetModel: string }`（`alias` 是**无前缀**的别名名，如 `glm`；`targetModel` 是该来源模型 id，如 `glm-5.3`）
  - `type SourceChanges = Array<{ id: string; models: string[]; aliases: SourceAliasEdit[] }>`（id 为该来源的 source id；models 为该来源保存后的模型列表；aliases 为该来源卡片内编辑的别名行）
  - `type LegacyAliasRow = { alias: string; target: string }`（全局表中无前缀的条目，仅用于提示文案，不参与改写）
  - `function deriveSourceAliases(prevGlobal: Record<string, string>, changes: SourceChanges): Record<string, string>`
    - 语义：基于 re-fetch 的 `prevGlobal` 基底，对每个 change 来源：剥掉该来源前缀下指向**不在 `change.models` 中**的模型 composed id 的条目；写入该来源卡片内编辑的别名行（key = `来源id/别名名`，value = `custom:来源id:模型id` composed 形式）；**保留**其他来源前缀条目与所有无前缀裸名条目。
  - `function findLegacyBareAliases(global: Record<string, string>): LegacyAliasRow[]`（返回无前缀条目列表，供迁移提示）

- [ ] **Step 1: Write the failing test**

Create `packages/ui/app/lib/__tests__/sourceAliases.test.ts` with cases covering（exact values）:

```ts
import { describe, expect, it } from 'vitest';
import { deriveSourceAliases, findLegacyBareAliases } from '../sourceAliases';

describe('deriveSourceAliases', () => {
  it('writes edited alias rows as 来源id/别名 → composed target', () => {
    const out = deriveSourceAliases(
      {},
      [{ id: 'novaway', models: ['glm-5.3', 'qwen-8b'], aliases: [{ alias: 'glm', targetModel: 'glm-5.3' }] }],
    );
    expect(out).toEqual({ 'novaway/glm': 'custom:novaway:glm-5.3' });
  });

  it('strips 来源id/* entries pointing at models no longer in the source', () => {
    const prev = {
      'novaway/glm': 'custom:novaway:glm-5.3',
      'novaway/old': 'custom:novaway:old-model',
    };
    // source novaway now only has glm-5.3 → old-model entry must be dropped
    const out = deriveSourceAliases(prev, [
      { id: 'novaway', models: ['glm-5.3'], aliases: [] },
    ]);
    expect(out).toEqual({ 'novaway/glm': 'custom:novaway:glm-5.3' });
  });

  it('preserves other sources' prefixed entries and bare legacy entries', () => {
    const prev = {
      'cpa/gpt': 'custom:cpa:gpt-mini',
      legacyname: 'custom:cpa:gpt-mini', // bare, kept as-is
    };
    // only novaway is being saved this round; cpa + bare must survive
    const out = deriveSourceAliases(prev, [
      { id: 'novaway', models: ['glm-5.3'], aliases: [] },
    ]);
    expect(out['cpa/gpt']).toBe('custom:cpa:gpt-mini');
    expect(out['legacyname']).toBe('custom:cpa:gpt-mini');
    expect(Object.keys(out)).toHaveLength(2);
  });

  it('replaces a previous edit to the same alias row (no duplicate key)', () => {
    const prev = { 'novaway/glm': 'custom:novaway:glm-5.3' };
    const out = deriveSourceAliases(prev, [
      { id: 'novaway', models: ['glm-5.3', 'qwen-8b'], aliases: [{ alias: 'glm', targetModel: 'qwen-8b' }] },
    ]);
    expect(out).toEqual({ 'novaway/glm': 'custom:novaway:qwen-8b' });
  });

  it('findLegacyBareAliases returns only prefix-less entries', () => {
    const rows = findLegacyBareAliases({ 'novaway/glm': 'x', legacy1: 'y', legacy2: 'z' });
    expect(rows.map((r) => r.alias).sort()).toEqual(['legacy1', 'legacy2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @freemodelfinder/ui test -- sourceAliases`
Expected: FAIL（`Cannot find module '../sourceAliases'`）

- [ ] **Step 3: Implement `deriveSourceAliases` + `findLegacyBareAliases` in `packages/ui/app/lib/sourceAliases.ts`**

算法要点（signature 和上面的测试钉死行为，这是实现者需要知道的）：
- `deriveSourceAliases`：以 `prevGlobal` 为基底（深拷贝）。先收集本次涉及的所有 source id（`changes` 里的）。对每个 `change`：① 从基底中剥掉所有 `change.id/*` 前缀条目里 value 对应的模型不在 `change.models` 中的（value 形如 `custom:change.id:model`，取 model 段判断）；② 写入 `change.aliases` 的每一行：key = `${change.id}/${edit.alias}`，value = `custom:${change.id}:${edit.targetModel}`。未涉及来源的前缀条目与所有无前缀条目原样保留（深拷贝天然保证）。
- `findLegacyBareAliases`：遍历 `global`，key 中不含 `/` 的条目视为裸名（含 `:` 的也不存在——校验禁止 `:`），返回 `{ alias: key, target: value }` 列表。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @freemodelfinder/ui test -- sourceAliases`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/app/lib/sourceAliases.ts packages/ui/app/lib/__tests__/sourceAliases.test.ts
git commit -m "feat(ui): add deriveSourceAliases pure function for source-scoped alias rewrite"
```

---

### Task 2: 服务端回归（`/` 名 round-trip + 反查回显 + allowlist 不感知）

**Files:**
- Test: `packages/server/src/__tests__/model-aliases.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: 现有 `/api/model-aliases` GET/POST、`toClientFacingModel`（均零改动，本 Task 只加测试钉住行为）
- Produces: 无新接口；钉住"含 `/` 的别名名在现有接口下天然合法"的事实，后续 Task 3/4 依赖此事实。

- [ ] **Step 1: Write the regression tests**

在 `packages/server/src/__tests__/model-aliases.test.ts` 追加（沿用文件内现有 `appWith` + `localUiHeaders` 模式，参照现有 `/api/model-aliases` describe 块的写法）：

```ts
describe('/api/model-aliases with source-scoped (slashed) alias names', () => {
  it('round-trips a slashed alias name through GET/POST', async () => {
    // POST { 'novaway/glm': 'custom:novaway:glm-5.3' } → 200；再 GET → 原样取回
    // 断言：GET 返回的 modelAliases['novaway/glm'] === 'custom:novaway:glm-5.3'
  });

  it('echoes the slashed alias name from toClientFacingModel', async () => {
    // 配置 alias {'novaway/glm': 'custom:novaway:glm-5.3'}
    // registry.toClientFacingModel('custom:novaway:glm-5.3') === 'novaway/glm'
  });

  it('does not let a slashed alias name leak into auto allowlist matching', async () => {
    // 受限 key（modelAllowlist: ['custom:novaway:glm-5.3']）调 auto → 候选池仍按 composed id 匹配，
    // alias 名 'novaway/glm' 不在 allowlist 中也不影响；钉住 ac221e3 的白名单∩可用模型语义不回退。
  });
});
```

（具体断言参照文件内既有测试的 fixture 风格；`custom` 来源 fixture 在文件头部已有，直接复用。）

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @freemodelfinder/server test -- model-aliases`
Expected: PASS（现有接口对 `/` 名天然兼容，本 Task 预期零实现代码，纯测试钉住）

若 FAIL（说明某处对 `/` 名有隐性拒绝），定位并修到 PASS——这是 Bug 修复，不是计划外改动；修完在 commit message 里注明。

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/__tests__/model-aliases.test.ts
git commit -m "test(server): pin source-scoped (slashed) alias round-trip and reverse echo"
```

---

### Task 3: `SourceAliasesEditor` 组件（来源卡片内嵌）

**Files:**
- Create: `packages/ui/app/components/SourceAliasesEditor.tsx`
- Modify: `packages/ui/app/i18n.tsx`（新增 `settings.sourceAliases.*` 中英双份 key）
- Test: `packages/ui/app/components/__tests__/source-aliases-editor.test.tsx`（新建）

**Interfaces:**
- Consumes: `deriveSourceAliases`/`SourceAliasEdit`（Task 1）；`GET /api/model-aliases`（现有）；i18n `settings.sourceAliases.*`
- Produces:
  - `SourceAliasesEditor({ sourceId, sourceLabel, sourceModels, onAliasesChange }: { sourceId: string; sourceLabel?: string; sourceModels: string[]; onAliasesChange: (edits: SourceAliasEdit[]) => void })`
    - 组件自持该来源的别名行状态（`SourceAliasEdit[]`），hydrate 时从 `GET /api/model-aliases` 读 `sourceId/*` 前缀条目回填（**Review Focus 3**：服务端残留条目会 hydrate 回来）；行增删改通过 `onAliasesChange` 上报父组件（`SettingsView` 持有全部来源的编辑状态，供 `saveCustomProvider` 读取）。
  - i18n key（中英双份，语义对应）：
    - `settings.sourceAliases.title`（'别名' / 'Aliases'）
    - `settings.sourceAliases.hint`（'别名名不能含 / 或 :；保存后客户端按 {prefix}/别名 调用' / 对应英文）
    - `settings.sourceAliases.aliasPlaceholder`（'别名名（如 glm）' / 'Alias name (e.g. glm)'）
    - `settings.sourceAliases.targetPlaceholder`（'选择该来源的模型' / 'Pick a model from this source'）
    - `settings.sourceAliases.add`（'添加别名' / 'Add alias'）
    - `settings.sourceAliases.remove`（'删除别名 {index}' / 'Remove alias {index}'）
    - `settings.sourceAliases.lockedPrefix`（只读前缀展示 `{sourceId}/` 的 aria/文案）
    - `settings.sourceAliases.legacyHint`（'检测到旧格式别名（如 {names}），建议在本标签重建为 来源id/别名 形式；旧名仍有效，不会自动迁移，删除需手改 config.json。' / 对应英文）

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/app/components/__tests__/source-aliases-editor.test.tsx`（沿用 `model-aliases.test.tsx` 的 msw + `test/server.ts` 的 `gateway`/`server` 模式）：

```ts
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { SourceAliasesEditor } from '../SourceAliasesEditor';
import { gateway, server } from '../../../test/server';

const SRC_MODELS = ['glm-5.3', 'qwen-8b'];

function renderEditor(onChange?: (edits: unknown) => void) {
  return render(
    <SourceAliasesEditor sourceId="novaway" sourceLabel="NovaWay" sourceModels={SRC_MODELS} onAliasesChange={(edits) => onChange?.(edits)} />,
  );
}

describe('SourceAliasesEditor', () => {
  it('hydrates 来源id/* entries from the global table', async () => {
    // Review Focus 3：服务端残留条目回填
    server.use(http.get(`${gateway}/api/model-aliases`, () =>
      HttpResponse.json({ modelAliases: { 'novaway/glm': 'custom:novaway:glm-5.3', 'other/x': 'custom:other:x' } }),
    ));
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() => expect(screen.getByDisplayValue('glm')).toBeTruthy(), { timeout: 3000 });
    // 只回填 novaway/ 前缀；other/x 不出现
    expect(screen.queryByDisplayValue('x')).toBeNull();
  });

  it('locks the source prefix as read-only text and edits only the alias name', async () => {
    renderEditor();
    // 'novaway/' 前缀是展示文本，不是可编辑 input 的值；别名名输入框 placeholder 为 aliasPlaceholder
    expect(screen.getByText('novaway/')).toBeTruthy();
    // 该来源模型下拉只列 novaway 的模型
    await waitFor(() => {
      const select = screen.getByRole('combobox');
      const opts = Array.from(select.options).map((o) => o.value);
      expect(opts).toContain('custom:novaway:glm-5.3');
      expect(opts).not.toContain('custom:other:x');
    }, { timeout: 3000 });
  });

  it('blocks alias names containing "/" or reserved words from being reported', async () => {
    // Review Focus 2：双 / 拦截；auto/default 拦截
    const reports: unknown[] = [];
    renderEditor((edits) => reports.push(edits));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /添加别名/ }));
    await user.type(screen.getByPlaceholderText(/别名名/), 'bad/name');
    // 含 / 的行不可保存/上报：reports 中不含 'novaway/bad/name'
    await user.click(screen.getByRole('button', { name: /保存/ }) ?? screen.getByRole('button', { name: /添加别名/ }));
    // 断言：reports 的每行 alias 都不含 '/'
    for (const ed of reports.flat()) {
      const e = ed as { alias?: string };
      expect(e.alias?.includes('/')).toBe(false);
    }
  });

  it('reports valid edits upward via onAliasesChange', async () => {
    const reports: unknown[] = [];
    renderEditor((edits) => reports.push(edits));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /添加别名/ }));
    await user.type(screen.getByPlaceholderText(/别名名/), 'glm');
    // 选目标 + 触发上报
    await user.selectOptions(screen.getByRole('combobox'), 'custom:novaway:glm-5.3');
    await waitFor(() => {
      const flat = reports.flat() as Array<{ alias?: string; targetModel?: string }>;
      expect(flat.some((e) => e.alias === 'glm' && e.targetModel === 'glm-5.3')).toBe(true);
    }, { timeout: 3000 });
  });

  it('shows the legacy-bare-alias migration hint when bare entries exist', async () => {
    server.use(http.get(`${gateway}/api/model-aliases`, () =>
      HttpResponse.json({ modelAliases: { legacy1: 'custom:novaway:glm-5.3', 'novaway/glm': 'custom:novaway:glm-5.3' } }),
    ));
    renderEditor();
    await waitFor(() => expect(screen.getByText(/旧格式别名/)).toBeTruthy(), { timeout: 3000 });
  });
});
```

（`保存`按钮语义：该组件本身不直接提交全局表——提交由父组件 `saveCustomProvider` 统一做；组件内的"保存"行为定义为"把当前合法行上报 `onAliasesChange`"。若实现者认为应去掉组件内保存按钮、仅靠行增删改即上报，则测试断言相应调整为"行变更即上报"——**实现者定，但必须保证 Review Focus 2/3 的断言成立**。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @freemodelfinder/ui test -- source-aliases-editor`
Expected: FAIL（`Cannot find module '../SourceAliasesEditor'`）

- [ ] **Step 3: Implement `SourceAliasesEditor`**

实现要点（signature 和测试钉死行为）：
- `useState<SourceAliasEdit[]>` 持行；`useEffect` 首次 `GET /api/model-aliases`，把 `modelAliases` 中 key 以 `${sourceId}/` 开头的条目拆成 `{ alias: key.slice(sourceId.length + 1), targetModel: value.split(':').pop() }` 回填；同时收集无前缀条目（key 不含 `/`）用于 legacyHint。
- 行 = 只读前缀文本 `{sourceId}/` + 别名名 input + 目标下拉（只列 `custom:{sourceId}:{m}` for `m in sourceModels`）+ 删除按钮。
- 别名名校验：非空、不含 `/`、不含 `:`、非 `auto`/`default`（后两条是 `validateModelAliases` 已有规则，UI 提前拦更友好；拦住则不上报该行）。
- 行增删改即调用 `onAliasesChange(currentValidRows)`。
- legacyHint 存在时用 `settings.sourceAliases.legacyHint` 渲染一行提示（把裸名 list 填进 `{names}`）。

- [ ] **Step 4: Add i18n keys**

在 `packages/ui/app/i18n.tsx` 中文字典（约 L445-456 的 `settings.aliases.*` 附近）和英文字典（约 L1083-1094）各加 8 个 `settings.sourceAliases.*` key（见 Interfaces 列出的 key 与文案）。

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @freemodelfinder/ui test -- source-aliases-editor`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ui/app/components/SourceAliasesEditor.tsx packages/ui/app/i18n.tsx packages/ui/app/components/__tests__/source-aliases-editor.test.tsx
git commit -m "feat(ui): add SourceAliasesEditor embedded in custom source cards"
```

---

### Task 4: `SettingsView` 集成（搬家 + saveCustomProvider 扩展 + 迁移提示）

**Files:**
- Modify: `packages/ui/app/components/SettingsView.tsx`（删 Models 标签的 `ModelAliasesSection`、Custom 标签来源卡片内嵌 `SourceAliasesEditor`、`saveCustomProvider` 扩展、迁移提示）
- Delete: `packages/ui/app/components/ModelAliasesSection.tsx`（搬家后无引用）
- Modify: `packages/ui/app/components/__tests__/model-aliases.test.tsx`（删/改——组件没了，测试改到 `source-aliases-editor.test.tsx` 已覆盖；若无残留断言则删整个文件）
- Test: `packages/ui/app/components/__tests__/settings-custom-aliases.test.tsx`（新建，钉住 saveCustomProvider 的 alias 改写与两次提交顺序）

**Interfaces:**
- Consumes: `SourceAliasesEditor` + `onAliasesChange`（Task 3）；`deriveSourceAliases`/`SourceChanges`（Task 1）；`GET /api/model-aliases`；`POST /api/model-aliases`；`POST /api/providers`（现有）
- Produces: 无新导出；`SettingsView` 行为变更（Custom 标签内嵌别名编辑器 + 保存时先 aliases 后 sources）。

- [ ] **Step 1: Write the failing integration tests**

Create `packages/ui/app/components/__tests__/settings-custom-aliases.test.tsx`。该测试渲染 `SettingsView`（或抽出 `saveCustomProvider` 的 alias 段做函数级测试——**实现者定**，若抽出则把 alias 改写 + 两次 fetch 的调用序列做成可测的 `commitCustomSave` 辅助函数）：

```ts
describe('SettingsView saveCustomProvider alias rewrite', () => {
  it('submits aliases before sources when saving custom provider', async () => {
    // msw 记录两次 POST 的 url 顺序
    // GET /api/model-aliases 返回基底 { 'novaway/glm': 'custom:novaway:glm-5.3' }
    // 保存来源（只改 novaway 的模型列表）→ 先 POST /api/model-aliases（基底+改写），再 POST /api/providers（sources）
    // 断言：model-aliases 的 fetch 时间戳 < providers 的 fetch 时间戳
  });

  it('strips alias entries pointing at models removed in the source', async () => {
    // 基底 { 'novaway/old': 'custom:novaway:old-model' }，保存时 novaway.models 不含 old-model
    // → POST /api/model-aliases 的 body 不含 'novaway/old'
  });

  it('shows an error toast when aliases saved but sources save fails', async () => {
    // Review Focus 1：POST /api/providers 返回 500 → toast 文案提示"别名未同步，请重试"（或等价）
    // 且 sources 未成功提交（providers POST 已发生但失败）
  });

  it('preserves unrelated prefixed and bare alias entries in the rewrite', async () => {
    // 基底 { 'cpa/gpt': '...', 'legacy1': '...' }，只保存 novaway
    // → POST /api/model-aliases 的 body 仍含 'cpa/gpt' 和 'legacy1'
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @freemodelfinder/ui test -- settings-custom-aliases`
Expected: FAIL

- [ ] **Step 3: Implement in `SettingsView`**

实现要点：
1. **搬家**：删 L2065 `{tab === 'models' && <ModelAliasesSection />}` 与 import；Custom 标签每个来源 `<li>` 卡片内（模型列表之后）嵌 `<SourceAliasesEditor sourceId={src.id} sourceLabel={src.label} sourceModels={src.models.map(m => m.id)} onAliasesChange={...} />`，`onAliasesChange` 把该来源的编辑行存进 `customAliases` state（`Record<sourceId, SourceAliasEdit[]>`）。
2. **`saveCustomProvider` 扩展**：
   - 保存前 `GET /api/model-aliases` 取基底 `prevGlobal`。
   - 构造 `SourceChanges` = 本次要保存的所有来源（id + 新 models 列表 + `customAliases[sourceId] ?? []`）。
   - `const nextGlobal = deriveSourceAliases(prevGlobal, SourceChanges)`。
   - **先** `POST /api/model-aliases { modelAliases: nextGlobal }`；成功后**再** `POST /api/providers`（sources 整表）。
   - sources 提交失败 → `setToast({ kind:'error', text: t('settings.custom.saveFailed', { msg: '别名已保存但来源未同步，请重试保存来源' }) })`（**Review Focus 1**）；aliases 提交失败 → 整体报错不继续。
   - 成功 → 现有 success toast + refresh config。
3. **迁移提示**：Custom 标签顶部（或来源卡片上方）若 `findLegacyBareAliases` 有结果，渲染一行 `settings.custom.legacyAliasesHint`（新 i18n key，中英双份，文案见 spec §3）。

- [ ] **Step 4: Delete `ModelAliasesSection.tsx` and its test**

删 `packages/ui/app/components/ModelAliasesSection.tsx`；`model-aliases.test.tsx` 若无其他组件断言则整删（其覆盖点已进 `source-aliases-editor.test.tsx`）。

- [ ] **Step 5: Run the full UI test suite**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: PASS（194 基线 + 新增 − 删掉的 model-aliases.test.tsx 的条数，净变化按实际；**全绿**是硬门槛）

- [ ] **Step 6: Commit**

```bash
git add packages/ui/app/components/SettingsView.tsx packages/ui/app/i18n.tsx packages/ui/app/components/__tests__/settings-custom-aliases.test.tsx
git rm packages/ui/app/components/ModelAliasesSection.tsx packages/ui/app/components/__tests__/model-aliases.test.tsx
git commit -m "feat(ui): move alias config into custom source cards; save aliases before sources"
```

---

### Task 5: 全量回归 + 文档

**Files:**
- Modify: `docs/superpowers/plans/2026-10-13-pool-failover-alias-fix.md`（追加本 feature 完成记录）

**Interfaces:** 无新接口；纯验证 + 文档。

- [ ] **Step 1: Run full gates**

Run（按 CI 顺序）:
```bash
pnpm format:check
pnpm lint
pnpm build:runtime
pnpm typecheck
pnpm test:coverage
```
Expected: 全绿（core 635、server 357、cli、ui 新增后全绿；coverage 阈值 core 85%lines/74%branches、server 80%/75%、cli 80% 不降）。

若 coverage 因删了 `ModelAliasesSection` 而掉线：`SourceAliasesEditor` 的测试应已覆盖等价行为；若仍不足，给 `sourceAliases.ts` 纯函数补边界测试（空前缀表、全裸名表）拉回阈值。

- [ ] **Step 2: 手动 smoke（可选，需用户在场）**

跑 `pnpm dev:ui` + `pnpm dev:server`，在 Custom 标签给某来源加一个别名（如 `glm`），保存；用客户端 key 调 `POST /v1/chat/completions` `model: "novaway/glm"` 验证 200 且响应 `model` 字段回显 `novaway/glm`。

- [ ] **Step 3: 更新计划文档 + Commit**

在 `docs/superpowers/plans/2026-10-13-pool-failover-alias-fix.md` 追加"来源级别名"完成记录（各 Task commit 号 + 全量结果），然后：

```bash
git add docs/superpowers/plans/2026-10-13-pool-failover-alias-fix.md
git commit -m "docs: record source-scoped alias feature completion"
```

- [ ] **Step 4: 提醒用户推送**

本地领先 origin/main 若干 commit，提醒用户说「推送」再 push（遵守 AGENTS.md：不自动推）。
