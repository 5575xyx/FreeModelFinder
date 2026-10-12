# 上游模型移除自动清理方案

## 触发条件
watcher tick 成功识别某 provider 的某模型被该 provider 主动移除（即 `listModels` 成功且返回的列表里没有该模型）。

## 清理范围（4 类）

| 配置项 | 清理动作 |
|---|---|
| key `modelAllowlist` 条目 | 剔除被移除模型 id；若清单掏空则清空但不删 key |
| `autoRoute` 各池（visionModel / imageModel / videoModel / fallbackChain / textTiers / profiles） | 剔除死条目；若池全灭则置 undefined；profiles 按 `provider+id` 整条删除 |
| 顶层 `defaultModel` | 若指向被移除模型 → 同 provider 在线模型里按快照顺序找第一个替代（排除本轮被移除的）；provider 全灭则置空 |
| `modelAliases` 指向该模型的别名条目 | 删除该别名条目（仅删指向该模型的 target；保留其他 target） |

## 不删除
- gateway key 本身（allowlist 掏空时 key 保留）
- call log 历史
- custom 模型引用

## 日志与持久化
- 每次清理写 INFO 级日志：`[model-removal-cleanup] pruned config references to removed upstream models`
- 追加到 `removal-cleanup-log.json`（最多 100 条，`~/.freemodelfinder/removal-cleanup-log.json`）
- provider 全灭时 `fullyRemovedProviders` 字段记录，UI 高亮提示

## UI
- 位置：设置页 → 诊断（inspect）标签 → "模型巡检" section 展开后，ModelChangesBanner 下方
- 组件：`ModelCleanupLogPanel.tsx`
- 展示最近 24h 的清理记录，每条含：时间、provider 全灭提示、各类清理数量、被移除模型 id 列表
- 数据来源：`GET /api/model-cleanup-log`

## 已实现文件

| 文件 | 说明 |
|---|---|
| `packages/core/src/config/removal-cleanup.ts` | 纯函数 `buildRemovalCleanupPlan` + `applyRemovalCleanupPatch` + log 类型 |
| `packages/core/src/config/__tests__/removal-cleanup.test.ts` | core 单测（12 cases） |
| `packages/server/src/removal-cleanup-log.ts` | 日志持久化（load/save/record/clear） |
| `packages/server/src/watcher.ts` | `onModelsRemoved` 钩子 + tick 集成 |
| `packages/server/src/server.ts` | `handleModelsRemoved` + `GET /api/model-cleanup-log` |
| `packages/server/src/__tests__/model-removal-cleanup.test.ts` | server 集成测试（6 cases） |
| `packages/ui/app/components/ModelCleanupLogPanel.tsx` | UI 面板 |
| `packages/ui/app/components/__tests__/model-cleanup-panel.test.tsx` | UI 测试（4 cases） |
| `packages/ui/app/i18n.tsx` | 中英文 i18n 文案 |

## 413 修复说明（关联）
- `packages/server/src/server.ts`：`resolveContentLengthLimit()` 默认 16MB，`FREEMODELFINDER_MAX_BODY_MB` 可覆盖
- 已验证：5MB body → 200（正常通过），17MB body → 413（超过 16MB 限制）
- Fastify 5.10 的 option 名是 `bodyLimit`（不是 `contentLengthLimit`）
- 若用户实际 413 持续出现：prompt 可能超过 16MB，或中间有 Nginx/Cloudflare 代理（`client_max_body_size` 默认 1MB）需要同时调大
