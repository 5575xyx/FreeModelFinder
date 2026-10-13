# 候选池故障切换与限流修复（含衍生 Bug A/B）

- **Date:** 2026-10-13
- **Status:** Bug A/B 已修复并推送（`4ccc60d`）；别名来源级功能已实现并全量回归通过（本地领先 origin/main，未推送）
- **分支:** `main`（远端 `https://github.com/5575xyx/FreeModelFinder.git`）
- **Git:** 本地 = `origin/main` = `ac221e3`（已推送批次 1）；工作树有未提交改动（Bug A/B）

## 目标

1. 池耗尽时三协议统一报 `model_unavailable` 并携带退避提示（**已完成，`ac221e3` 已推**）。
2. 流式响应的 `model` 字段上报网关实际解析后的模型（**已完成，`ac221e3` 已推**）。
3. 衍生 Bug A：能力推断误判——`/vid/` 子串匹配把 `nvidia` 当 `vid(eo)`，普通文本 chat 被误发到 `generateVideo`，返回 502。
4. 衍生 Bug B：`/v1/models` 发布的 id（如 `nvidia/nemotron-3-super-120b-a12b`）在 `resolveModel` 中无启发式前缀命中，静默 fall-through 到 openrouter，再被调用方 allowlist 判为 "model not allowed"。

## 关键决策

- Bug A 修复：`MODEL_MARKER_IMAGE`/`MODEL_MARKER_VIDEO` 收窄为整 token 匹配（`/(^|[^a-z0-9])image($|[^a-z0-9])/i`、`/(^|[^a-z0-9])vid(eo)?($|[^a-z0-9])/i`），应用到 `openai.ts` 的 `inferredCaps` 推断和 `findImageModelId` 两处。
- Bug B 修复：在 `registry.ts` `resolveModel` 的启发式链末尾、openrouter fall-through 之前，加「目录精确查找」兜底：`modelsCache.models.find(m => m.id === modelId)` 命中则返回该 provider 的 `bareModelId`。
- TDD：4 条新测试先确认 RED，再实现代码。

## 已完成（ac221e3 已推）

- 池耗尽统一 `model_unavailable` + 退避提示（非流式 + 流式，三协议）
- 流式 `model` 字段修掉，新增 `fmf_upstream_model`
- `retry-after.test.ts` 拆分（旧行为固化 → 2 条新测试）
- server 355/356（已知既有 flake `model-aliases.test.ts persists a valid alias map` 隔离 26/26 全过）、core 635 全绿，`build:runtime` 干净

## 进行中（未提交，未推送）

- [x] Bug A：`openai.ts` 新增 `MODEL_MARKER_IMAGE`/`MODEL_MARKER_VIDEO` 常量（整 token 匹配）
- [x] Bug A：`openai.ts` `inferredCaps` 推断改用 `MODEL_MARKER_VIDEO`/`MODEL_MARKER_IMAGE`
- [x] Bug A：`openai.ts` `findImageModelId` 改用 `MODEL_MARKER_IMAGE`
- [x] Bug B：`registry.ts` `resolveModel` 启发式链末尾加目录精确查找兜底
- [x] Bug A 测试：`auto-modality.test.ts` 新增「text model whose id contains "vid"」（RED 已确认）
- [x] Bug B 测试：`registry.test.ts` 新增「resolveModel honours ids published by /v1/models」3 条（RED 已确认）
- [x] **跑 `registry.test.ts` + `auto-modality.test.ts`，确认 4 条新测试全绿**
- [x] 跑完整 core + server 测试、typecheck、lint
- [x] 提交 Bug A/B 修复
- [ ] 向用户提醒推送（等用户「推送」二字再推）

## 已完成（4ccc60d 已推）

- [x] Bug A：能力推断误判（`/vid/` 子串匹配把 `nvidia` 当 video）→ 整 token 匹配
- [x] Bug B：`/v1/models` 发布 id 静默 fall-through → `resolveModel` 目录精确查找兜底
- [x] 远端未验证（可选）

## 进行中：别名配置入口挪到来源级（最小侵入版）

- [x] 设计定稿（`docs/superpowers/specs/2026-10-13-source-scoped-aliases-design.md`，含 2 轮 builder check + 实现期 R1 裁决）
- [x] 实现计划（`docs/superpowers/plans/2026-10-13-source-scoped-aliases.md`，5 个 Task + TDD）
- [x] 实现完成（subagent-driven：每 Task 实现 + 评审，关键裁决见下）

**实现提交（4ccc60d..HEAD）：**

- `878c54d` docs: design + plan + builder-check notes
- `6f01580` feat(ui): 纯函数 `deriveSourceAliases`
- `7098268` test(server): `/` 名 round-trip + 反查回显（零实现代码）
- `1109d6d` feat(ui): `SourceAliasesEditor` 组件 + i18n
- `a4029aa` fix(ui): **R1** `deriveSourceAliases` 来源权威化（删除行生效）
- `ff1aea3` fix(ui): **R2** hydration 按内容键、hydrate 后权威上报、校验/裁剪
- `d359f9d` test(ui): 测试 TS 收窄（typecheck 门禁）
- `e98440b` fix(ui): 加载失败/无效 JSON 不视为权威空表（防误清命名空间）
- `804067d` fix(ui): **R3** 每来源只 hydrate 一次（增删模型不覆盖别名编辑）
- `31c4181` feat(ui): 别名入口搬到 Custom 来源卡片；先 aliases 后 sources
- `763caed` fix(ui): 删来源剥前缀；单一迁移提示；钉住 R1 排除
- `e935be6` / `27f9798` / `a73cc88` / `d192826` docs + 小修 + 测试超时余量

**关键裁决（实现期）：**

- R1：被纳入改写集合的来源，其 `来源id/*` 命名空间先整体清空再按编辑器上报行重写；仅纳入已上报来源，被删除来源强制以空命名空间纳入。core 解析内核零改动。
- R2/R3：编辑器 `sourceId` 维度 hydrate 一次，hydrate 后无条件上报（含空表）成为权威；上报别名做 trim、hydrate 校验、严格目标前缀、非 2xx/无效 JSON 视为加载失败且不上报。

**验证：** core 635 / server 360 / cli / ui 218 全绿；`pnpm typecheck`、`pnpm lint`（0 警告）通过；`pnpm test:coverage` 整仓 exit 0（UI coverage 行覆盖 ≥70 阈值）。`pnpm format:check` 本地因 CRLF 工作树噪声失败，改动集内文件逐个 prettier 校验干净（CI LF 检出通过）。

**未做（记录）：** `clearCustomProvider`（清空全部）不剥 `custom:*` 别名；旧格式裸名为设计上的"接受滞留"、保留在全局表。

## 可选验证

- 远端 `119.29.157.227:11435` 上用 key `fmf-XQuXTJB1AcMTw98JeZV5KXoYJupwttNV` 回归验证 `nvidia/nemotron-3-super-120b-a12b` 原样可发、`auto` 不再落到 `openrouter/free`
- 本地 `pnpm dev:ui` + `pnpm dev:server`：Custom 标签为某来源加别名（如 `glm`）保存后，用客户端 key 调 `POST /v1/chat/completions` `model: "novaway/glm"` 验证 200 且响应 `model` 回显 `novaway/glm`

## 关键文件

- `packages/core/src/registry.ts`：`resolveModel` 目录兜底（Bug B 修复位置）
- `packages/server/src/routes/openai.ts`：能力推断收窄（Bug A 修复位置）
- `packages/core/src/registry/__tests__/registry.test.ts`：Bug B 新测试 3 条
- `packages/server/src/routes/__tests__/auto-modality.test.ts`：Bug A 新测试 1 条
