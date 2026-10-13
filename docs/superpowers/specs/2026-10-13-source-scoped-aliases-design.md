# 设计：别名配置入口挪到来源级（最小侵入版）

- **Date:** 2026-10-13
- **Status:** 待实现
- **前置:** Bug A/B 已修复（`4ccc60d`），`resolveModel` 已有目录兜底，别名表对 `/` 前缀名零改动可用。

## 目标（Why）

客户端（调网关的 key）靠全局扁平别名表（`config.modelAliases`）把长模型 id 简化成短名。痛点：

1. 入口在 Settings → Models 标签的全局 `ModelAliasesSection`，与 custom 来源的管理位置（Settings → Custom 标签）割裂；来源级配置（哪个来源的模型起了什么短名）要跨两个标签对照。
2. 全局命名空间下，两个来源都给模型起 `glm` 短名时，`modelAliases` map 的 key 撞车——后配置的直接覆盖先配置（UI 提交整张表，无冲突提示），且 `toClientFacingModel` 反查依赖"一模型一别名"约束，撞车时表现不直观。

**本设计**：把别名配置入口挪到 Custom 标签、嵌进每个来源卡片，别名名带上来源前缀（`来源id/别名名`），实现来源限定命名空间——同名不冲突、无静默覆盖，客户端按 `novaway/glm` 调用。

## 关键决策（已确认）

| 决策 | 结论 | 理由 |
|------|------|------|
| 作用域 | 来源限定命名空间 | 客户端别名几乎都指向 custom 来源模型；消除跨来源同名撞车 |
| 落地范围 | 最小侵入版 | **core 解析内核一行不改**（`resolveModel`、`toClientFacingModel`、`validateModelAliases`、`removal-cleanup` 全部保持现状） |
| 前缀格式 | `来源id/别名名` | 现有 `resolveModel` 的别名查找在 `:` 前缀解析之前，`/` 名零改动原样命中；模型 id 里的 `/`（如 `nvidia/nemotron-…`）不冲突 |
| 存储 | 仍存全局 `modelAliases` map（值为 composed id） | 不动 schema、不动清理逻辑 |
| 现有别名 | 不自动迁移，裸名继续有效 | 零数据丢失；用户在 Custom 标签重建时自然得到带前缀名 |
| 来源删除/重命名 | 由 UI 保存流程（`saveCustomProvider`）负责：读当前 `modelAliases`，按来源前缀删/改条目，与 sources 变更一并提交 | 复用现有 `POST /api/model-aliases`，不新增服务端接口 |
| 客户端调用 | `novaway/glm`；`/v1/models` 与响应 `model` 字段回显 `novaway/glm` | 反查命中 composed target 后返回 alias 名（含前缀），正是来源限定想要的效果 |
| 来源 id 重命名 | **不支持**（现状 UI 就不允许改 source id；alias 流程只处理"新增来源 / 删除来源"两种） | 改 id 等价于删旧建新，超出最小侵入范围；rename 分支不实现 |
| 删来源内模型 | **顺手清**：`saveCustomProvider` 提交时，剥掉所有指向该来源已删模型的 `来源id/*` 别名条目 | 杜绝悬空别名（查无模型报 `model not found`）；与 removal-cleanup 对上游 provider 的行为对齐 |
| 旧格式裸名 | **接受滞留**：不自动迁移、无独立管理入口；迁移提示文案强调"旧名永久有效，删除需手改 config.json" | 最简；裸名在 Custom 标签来源卡片里不显示（卡片只列 `来源id/*` 条目） |
| 并发编辑 / 陈旧读 | **last-write-wins**，保存前 re-fetch 全局 `modelAliases` 作为改写基底 | 与现有 `ModelAliasesSection.save` 语义一致；不引入冲突检测（CLI/手改/移除清理等外部变更路径靠 re-fetch 吸收） |
| 删除来源 id 后重建 | 编辑器 hydrate 时 re-read 全局表；重建来源默认空列表，但服务端残留的 `来源id/*` 条目（外部变更路径）会 hydrate 回编辑器供用户审阅/删除 | 与上一行的 re-fetch 基底规则一致；"顺手清"规则保证删除来源时旧前缀条目被剥掉，正常路径无残留 |

## 改动范围（What）

### 不动的部分（明确排除）

- `packages/core/src/registry.ts`：`resolveModel` / `toClientFacingModel` / `resolveAlias` 原样。
- `packages/core/src/config/aliases.ts`：`validateModelAliases` 原样（别名名含 `/` 合法——它只禁 `:`，`/` 不在禁列；现有校验对新格式天然兼容）。
- `packages/core/src/config/removal-cleanup.ts`：上游删模型时清理 alias 条目的逻辑原样（按 composed target 清理，与 alias 名是否带前缀无关）。**注意**：removal-cleanup 只覆盖上游 provider 删模型，custom 来源的手改模型列表不在其范围——custom 来源删模型的 alias 清理由 UI `saveCustomProvider` 负责（见下）。
- 服务端 `/api/model-aliases` GET/POST 接口原样。
- 服务端 `/api/providers` 的 sources 整表替换语义原样（来源 id 不可改名，删旧建新由前端 alias 剥除流程吸收）。

### 改的部分

**1. UI：`packages/ui/app/components/ModelAliasesSection.tsx` 改造 + 搬家**

- 从 `SettingsView` 的 Models 标签（当前 `{tab === 'models' && <ModelAliasesSection />}`）移除。
- 新增 `SourceAliasesEditor`（或等价组件）嵌进 Custom 标签每个来源卡片：
  - 每行 = 一个别名，形如 `<来源id>/<别名名>`。
  - 别名名输入框只接受 `/` 之后的部分；`来源id/` 前缀只读展示（锁死前缀，防止手滑改到别的来源）。
  - 目标模型下拉只列**该来源的模型**（`custom:来源id:模型id` composed 形式）。
  - 校验：别名名非空、不含 `/`（防双前缀）、非 `auto`/`default`（预留字，现有校验已覆盖，UI 提前拦更友好）。
  - i18n：新增 `settings.sourceAliases.*` 一套 key（中英双份）；旧 `settings.aliases.*` key 保留但 Models 标签不再引用（迁移提示可复用 `settings.aliases.*` 中的 hint 文案）。
- 保存：与来源的增删改同一次 `saveCustomProvider` 流程里完成，一次一致性校验。

**2. UI：`SettingsView.saveCustomProvider` 扩展（alias 改写核心逻辑）**

**改写基底**：每次保存前 re-fetch 全局 `modelAliases`（`GET /api/model-aliases`）作为基底（last-write-wins 语义，与现有 `ModelAliasesSection.save` 一致）。编辑器 hydrate 时同样从全局表读取该来源前缀的条目回填——因此删除来源 id 后重建来源时，编辑器默认空列表，但服务端若残留 `来源id/*` 条目（外部变更路径：CLI、手改 config、removal-cleanup 未覆盖场景）会 hydrate 回编辑器供用户审阅/删除。

按以下规则改写后提交：

- **删除的来源**：剥掉所有 `来源id/*` 条目。
- **来源内删模型**：剥掉所有指向该来源已删模型 composed id 的 `来源id/*` 条目（如 `novaway/m2` 指向 `custom:novaway:m2`，而 `m2` 被删 → 剥 `novaway/m2`）。
- **来源内新增模型**：不动（新模型默认无别名）。
- **来源卡片内编辑的别名行**：直接写入（key = `来源id/别名名`，value = 该来源模型的 composed id）。
- **未涉及的前缀条目**（其他来源、历史裸名）：原样保留。
- 最终 map 走 `POST /api/model-aliases` 提交；与 sources 的 `POST /api/providers` 分两次提交。
  - 顺序：**先 aliases 后 sources**——删除来源时，先剥掉旧前缀条目（旧 alias 名不再悬空指向已删来源的 composed id），再提交 sources 删旧来源。中间态"该模型彻底查无"而非"短暂悬空后恢复"，可接受。
  - 失败处理：sources 成功而 aliases 失败 → toast 明确提示"别名未同步，请重试保存"；悬空态只表现为该别名查无模型，不会误路由（目录兜底 + 来源前缀解析都找不到就按现行为报错）。

**3. 迁移提示（做）**

- Custom 标签若检测到全局表里存在**无来源前缀**的别名（裸名历史遗留），显示一行提示："检测到旧格式别名（如 novaway2），建议在本标签重建为 来源id/别名 形式；旧名仍有效，不会自动迁移，删除需手改 config.json。"
- 纯 UI 文案 + 一次 GET 比对，不动数据。

### 测试

- `packages/ui/app/components/__tests__/model-aliases.test.tsx`（现有）：改为覆盖新组件 `SourceAliasesEditor`——锁定前缀展示、目标下拉只显示该来源模型、双 `/` 拦截、`auto`/`default` 拦截、保存 payload 形状（带前缀 key + composed target + 保留无关条目 + 删来源剥前缀 + 删模型剥悬空条目）、**保存前 re-fetch 基底**（改写基于最新服务端表而非编辑器初始值）、**hydrate 时回填服务端残留的该来源前缀条目**。
- 服务端回归：`/api/model-aliases` 对含 `/` 的别名名 round-trip（现有 `model-aliases.test.ts` 加 1-2 条：`{ 'novaway/glm': 'custom:novaway:glm-5.3' }` 存得进去、取得出来；`toClientFacingModel('custom:novaway:glm-5.3')` 回显 `novaway/glm`）。
- 不动 core：`registry.test.ts` 现有 alias 用例全绿即回归通过。

## 非目标

- 不重构别名存储 schema（仍是全局 map）。
- 不自动迁移历史裸名；裸名无独立管理入口（接受滞留，删除需手改 config）。
- 不支持来源 id 重命名（现状 UI 就不允许；alias 流程不覆盖 rename 场景）。
- 不改 `validateModelAliases` 的规则集（`/` 天然合法）。
- 不做 alias 前缀在 key allowlist（`modelAllowlist`）里的联动：allowlist 收的是 composed 模型 id，与 alias 名无关——`auto` 候选池的"白名单 ∩ 可用模型"逻辑（`ac221e3`）在 composed 层匹配，alias 名不参与。
- 不做服务端 sources 改名的原子性（sources 不可改名，问题不存在）。

## 实现顺序建议

1. 服务端回归测试先写（`/` 名 round-trip + 反查回显）→ 确认现有接口天然支持（预计全绿，无需改码）→ 提交。
2. UI 组件改造（`SourceAliasesEditor` + 搬家）+ `saveCustomProvider` 扩展（alias 改写核心逻辑）+ 迁移提示 → UI 测试 → 提交。
3. 全量 `pnpm test:coverage`、typecheck、lint、format。

## 风险与回滚

- 最大风险：`saveCustomProvider` 里 alias 改写与 sources 提交的两次请求非原子——中间失败会留下"来源已改、别名未改"的悬空态。缓解：失败 toast 明确提示"别名未同步，请重试保存"，且悬空态只表现为该别名查无模型（报 `model not found`），不会误路由（目录兜底 + 来源前缀解析都找不到就按现行为报错）。
- 裸名滞留：旧格式裸名无 UI 入口，可能长期滞留在全局表里。可接受——它们仍合法有效，不破坏新格式；用户重建后自然废弃。
- 回滚：改动集中在 UI 两个文件 + 测试 + i18n，revert 即可；全局 map 里已写入的带前缀条目在回滚后仍合法（裸名形式与带前缀形式并存互不干扰）。
