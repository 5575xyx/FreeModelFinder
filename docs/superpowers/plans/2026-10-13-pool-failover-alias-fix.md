# 候选池故障切换与限流修复（含衍生 Bug A/B）

- **Date:** 2026-10-13
- **Status:** 进行中（Bug A/B 代码已改，新测试未跑 GREEN）
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
- [ ] **跑 `registry.test.ts` + `auto-modality.test.ts`，确认 4 条新测试全绿**
- [ ] 跑完整 core + server 测试、typecheck、lint
- [ ] 提交 Bug A/B 修复
- [ ] 向用户提醒推送（等用户「推送」二字再推）

## 已完成（4ccc60d 已推）
- [x] Bug A：能力推断误判（`/vid/` 子串匹配把 `nvidia` 当 video）→ 整 token 匹配
- [x] Bug B：`/v1/models` 发布 id 静默 fall-through → `resolveModel` 目录精确查找兜底
- [x] 远端未验证（可选）

## 进行中：别名配置入口挪到来源级（最小侵入版）
- [ ] 设计讨论（进行中）
  - [x] 动机：客户端（调网关的 key）使用别名，入口挪到 Custom 标签
  - [x] 作用域：来源限定命名空间
  - [x] 落地范围：最小侵入版（不动 core 解析内核，别名存全局 map，UI 按来源分组编辑+自动加前缀）
  - [ ] 剩余问题：
    - 别名前缀格式（`来源id/别名名` 还是别的）
    - 来源删除/重命名时别名的清理策略
    - 客户端调用形式（`novaway/glm` 是否可被现有 resolveModel 原样命中）
    - 现有已配置的别名（如 novaway2）如何迁移

## 可选验证
- 远端 `119.29.157.227:11435` 上用 key `fmf-XQuXTJB1AcMTw98JeZV5KXoYJupwttNV` 回归验证 `nvidia/nemotron-3-super-120b-a12b` 原样可发、`auto` 不再落到 `openrouter/free`

## 关键文件
- `packages/core/src/registry.ts`：`resolveModel` 目录兜底（Bug B 修复位置）
- `packages/server/src/routes/openai.ts`：能力推断收窄（Bug A 修复位置）
- `packages/core/src/registry/__tests__/registry.test.ts`：Bug B 新测试 3 条
- `packages/server/src/routes/__tests__/auto-modality.test.ts`：Bug A 新测试 1 条
