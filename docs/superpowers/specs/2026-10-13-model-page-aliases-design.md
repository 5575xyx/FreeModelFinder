# 设计：别名统一到「模型」页 + 模型选择器可搜索

- **Date:** 2026-10-13
- **Status:** 待实现
- **前置:** `272b0a2`（模型页刷新修复）。本文**下线** `2026-10-13-source-scoped-aliases-design.md` 的来源级别名入口，但保留其写下的别名数据。

## 目标（Why）

1. 别名现在只能在「设置 → 自定义」里按**来源**配置（`来源id/别名名`），**内置厂商的模型没有入口**。用户要给内置厂商模型起短名（如 `nvidia/nemotron-3-super-120b-a12b` → `nemotron`），并且认为「模型」页最方便——那里本来就按厂商把所有模型列出来了。
2. 「网关 → 可用模型」的选择框（`ModelMultiSelect`）在 30+ 模型时只能靠滚，需要搜索。
3. 用户确认要**单一入口**：别名只在「模型」页配，设置里那套来源级编辑器下线。

## 关键决策

| 决策               | 结论                                                                              | 理由                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 入口唯一           | 别名只在「模型」页配；下线设置 →「自定义」的来源级编辑器                          | 「模型」页列表来自 `/v1/models`，天然覆盖内置厂商 + 自定义来源；避免两处编辑同一张表                                                      |
| 每模型一个别名     | 每张卡片一个输入框                                                                | 与现有 `validateModelAliases` 的「一模型一别名」约束吻合（两个别名指向同一 target 会被 400 拒）                                           |
| 命名规则           | 自由取名，**不强制** `厂商/` 前缀                                                 | 用户要的是短名；后端只禁 `:`、`auto`/`default`、自指、`Object.prototype` 上的键                                                           |
| 冲突处理           | UI **行内拦截**，绝不静默覆盖                                                     | 后端是整表替换 + fail-fast；静默覆盖会让客户端某个名字悄悄指向别的模型                                                                    |
| 前缀命名空间的替代 | 用「显式冲突提示」代替来源前缀                                                    | 前缀当初就是为了消除静默覆盖；有明确提示后它不再必要。历史前缀名保留为普通合法名字                                                        |
| 历史前缀别名       | **原样保留、不迁移**，在模型页卡片上照常显示/可改/可删                            | 零数据丢失；`/` 只是普通字符                                                                                                              |
| 悬空别名清理       | 交给 core 的 watcher（`buildRemovalCleanupPlan`）                                 | 该逻辑已在跑；删自定义来源/来源内删模型会让模型从目录消失 → 下一轮 watcher 剥掉指向它的别名条目                                           |
| 清理时机代价       | 从「保存那一刻」变成「下一轮 watcher（默认 1 小时）」                             | 用户已明确接受。中间态表现为该别名报 `model not found`，**不会误路由**                                                                    |
| 保存并发           | 读最新全表 → 只改当前这一个 key → POST 全表                                       | 避免覆盖别处（CLI / 手改 / removal-cleanup）的并发改动                                                                                    |
| 别名 target 口径   | target 必须是 **composed 真实 id**（`modelValue(m)` = `provider:alias_of ?? id`） | `/v1/models` 的 `data[].id` 是**别名**、`alias_of` 才是真实 id；用错会把别名指到一个不存在的 id                                           |
| core 改动          | **零**                                                                            | `resolveModel` / `toClientFacingModel` / `resolveAlias` / `validateModelAliases` / `removal-cleanup` 全不动                               |
| server 改动        | **零**                                                                            | `/api/model-aliases` GET/POST、`/api/auto-route/model-options` 全不动；别名信息由 UI 从已有的 `/v1/models` 响应（`id` vs `alias_of`）推导 |

### 别名的唯一数据源在 UI 顶层

`page.tsx` 已经持有 app 级状态，别名 map 也放在这里：一次 `GET /api/model-aliases` 拿到 `Record<别名, composed target>`，反查得到 `target → 别名`，向下传给 `FinderView`（卡片编辑）和 `SettingsView`（选择器补 `alias` 字段、当前模型下拉标别名）。

这样 UI 里只有一处别名状态，保存流程也复用同一份 map；服务端只需现有的 `GET` / `POST /api/model-aliases`，两点零改动。

## 改动范围（What）

### 1. 新增：模型页卡片别名编辑（方案 A）

- **`packages/ui/app/lib/modelAliases.ts`**（纯函数，先 TDD）
  - `invertAliases(aliases: Record<string, string>): Map<string, string>` — target → 别名名
  - `type AliasNameError = { key: string; params?: Record<string, string | number> }`
  - `validateAliasName(name: string, target: string, aliases: Record<string, string>): AliasNameError | null`
    - 空 → `null`（空 = 删除，不算错误）
    - 含 `:` → error；等于 `auto` / `default` → error；`name in Object.prototype` → error
    - 已被**其他** target 占用 → error（`params.model` = 占用者的 target，供行内文案）
    - 指向自身（`aliases[name] === target`）不算冲突（改名/无变化）
  - `applyAliasEdit(aliases: Record<string, string>, target: string, name: string): Record<string, string>`
    - 先删掉所有 `value === target` 的条目（改名语义）
    - `name` 非空时写入 `{ [name]: target }`
- **`packages/ui/app/components/ModelAliasInput.tsx`**
  - props：`target: string`、`alias?: string`、`aliases: Record<string, string>`、`disabled?: boolean`、`onSave(target: string, name: string): Promise<void>`
  - 未聚焦：有别名时显示别名 chip + 编辑图标；无别名时显示淡色输入框（选项 A 的常显形态）
  - 失焦 / 回车 → `validateAliasName` → 提交；Esc → 还原；提交中显示 spinner；`onSave` 抛错时回显行内错误
- **`packages/ui/app/components/FinderView.tsx`**
  - 卡片底部（`border-t` 那一行之上）插入别名行
  - 新增 props：`aliases: Record<string, string>`（配合 `invertAliases` 得到每卡的当前别名）、`onSaveAlias`
  - 页面搜索框（决策 b）匹配时把别名一并纳入（`model.id` / `display_name` / `description` / 厂商 + 别名）
- **`packages/ui/app/lib/saveAlias.ts`**
  - `async function saveAlias(target: string, name: string): Promise<Record<string, string>>`
  - 流程：`GET /api/model-aliases`（取最新基底，失败即抛）→ `applyAliasEdit` → `POST /api/model-aliases`（失败抛服务端 `error` 文案）→ 返回服务端确认后的新表
- **`packages/ui/app/page.tsx`**
  - 新增 `aliases` state + 首次 `GET /api/model-aliases`
  - `onSaveAlias(target, name)` = `setAliases(await saveAlias(target, name))`；失败时 `saveAlias` 抛错，state 不动
  - 把 `aliases` 与 `onSaveAlias` 传给 `FinderView`、`aliases` 传给 `SettingsView`

### 2. 删除：来源级别名编辑器（净删除）

- 删 `packages/ui/app/components/SourceAliasesEditor.tsx`
- 删 `packages/ui/app/lib/sourceAliases.ts`、`packages/ui/app/lib/customAliasSave.ts`
- 删测试 `components/__tests__/source-aliases-editor.test.tsx`、`components/__tests__/settings-custom-aliases.test.tsx`、`lib/__tests__/sourceAliases.test.ts`
- `SettingsView.tsx`：去掉 `SourceAliasesEditor` 引用与渲染、`customAliases` state、`saveCustomProvider` 的别名改写分支（保存来源退回「只提交 `/api/providers`」）
- i18n：删 `settings.sourceAliases.*`、`settings.custom.legacyAliasesHint`

### 3. 「设置 → 模型」的「当前模型」下拉标出别名（决策 a）

- `SettingsView` 当前模型 `<option>` 文案：有别名时 `[厂商] 显示名 · 别名 <别名>`

### 4. 「可用模型」选择框加搜索（决策 5 + b）

- `packages/ui/app/components/ModelMultiSelect.tsx`：下拉面板顶部加一个搜索输入框
  - 匹配 `id` / `displayName` / `provider`，**外加别名**（`ModelOption.alias?`）
  - 关闭下拉、清空按钮、重新打开时重置查询词
  - 无匹配时沿用现有 `modelMultiSelect.empty` 空态
- `packages/ui/app/components/SettingsView.tsx`：构建 `modelOptions` 时用 `invertAliases(aliases)` 补 `alias` 字段（`aliases` 由 `page.tsx` 作为 prop 传入）
  - `ModelItem` 类型加 `alias_of?: string`（供实现参考；别名本身来自 `aliases` prop）
- 搜索框做在组件内，**自动路由那几个多选下拉同时获得搜索**（用户已确认接受扩散）

## 非目标

- 不自动迁移历史前缀别名 / 裸名。
- 不改 `validateModelAliases` 规则集。
- 不支持「一个模型多个别名」。
- 不改别名存储结构（仍是全局扁平 map）。
- 不让别名参与 key allowlist 匹配（allowlist 仍收 composed 模型 id，`ac221e3` 行为不变）。
- 不新增/修改任何服务端接口。
- 不做来源 id 重命名。

## 测试

| 层级         | 文件                                                               | 覆盖                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯函数（新） | `packages/ui/app/lib/__tests__/modelAliases.test.ts`               | 冲突（被别的 target 占用）、改名（旧名被清）、清除（空名）、非法名（`:` / `auto` / `default` / `toString`）、`invertAliases` 反查（含同 target 多键时的确定性） |
| 组件（新）   | `packages/ui/app/components/__tests__/finder-aliases.test.tsx`     | 卡片输入：失焦提交、回车提交、Esc 还原、清空即删除、冲突拦截不提交、非法名拦截、提交 payload = 全表且含其他条目                                                 |
| 组件（新）   | `packages/ui/app/components/__tests__/model-multi-select.test.tsx` | 搜索过滤（id / 显示名 / 厂商 / 别名）、无匹配空态、关闭重置、清空搜索词                                                                                         |
| 组件（改）   | `packages/ui/app/components/__tests__/`（现有 settings 用例）      | 设置 →「自定义」不再渲染别名编辑器；「当前模型」下拉带别名文案；「可用模型」选择框可搜索                                                                        |
| 删除         | 上述 3 个来源级别名测试文件                                        | —                                                                                                                                                               |
| 回归         | core / server 现有用例                                             | 零改动 → 全绿即通过                                                                                                                                             |

命令：`pnpm --filter @freemodelfinder/ui test`；全量 `pnpm test:coverage`。

## 风险与回滚

- **最大实现陷阱：target 口径。** `/v1/models` 的 `data[].id` 是别名、`alias_of` 才是真实 id。别名 target 必须写成 `modelValue(m)`（composed 真实 id），否则别名会指向一个不存在的模型，表现是客户端调用报 `model not found`。测试必须钉住这一点（用一个 `id !== alias_of` 的模型断言提交 payload）。
- **悬空别名窗口期。** 由用户已接受：删来源/删模型后，指向它的别名最多存活到下一轮 watcher（默认 1 小时），期间调用报 `model not found` 且不误路由。
- **`/v1/models` 两条同 id 条目。** 若用户把别名取成另一个真实模型 id（后端明确允许），`/v1/models` 会出现两条同名条目。这是既有行为，本次不改，但「冲突提示」文案不覆盖这种情况（同名是允许的，指向同 target 才是冲突）。
- **回滚：** 改动集中在 UI（新增 3 个文件、删除 5 个文件、2 个组件内改）+ i18n；revert 即可。已写入的别名数据在任何回滚方向下都仍然合法。
