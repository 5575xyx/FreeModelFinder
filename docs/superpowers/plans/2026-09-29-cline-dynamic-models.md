# Cline 动态模型清单实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cline 模型清单从编译期常量升级为上游 `free` 组动态同步（惰性 + 30min TTL），与内置 4 个并集，附可关闭开关。

**Architecture:** 新增独立模块 `providers/cline-catalog.ts` 承载全部网络/缓存逻辑，`ClineProvider.listModels()` 仅委托并集；开关走 `ProviderSettings.dynamicModels → ProviderContext → registry 注入` 管道，server 保存/回显，UI 卡片勾选框。详见 spec：`docs/superpowers/specs/2026-09-29-cline-dynamic-models-design.md`（引用其节名）。

**Tech Stack:** TypeScript、zod、fastify、Next.js 16、node:test、vitest+msw。

日期：2026-09-29
状态：draft

## 关键决策（摘要，详见 spec）

- 只取上游 `recommended-models` 的 **`free` 组**，其余三组（recommended/clinePass/clineCloud）丢弃；**并集** `BUILTIN_MODELS` 4 个且内置恒在
- 惰性拉取 + 30min TTL 内存缓存 + inflight 合并；失败退旧缓存 → 冷启动失败返回 `null` → 调用方回退纯内置；`listModels()` 永不因网络抛错
- 端点免鉴权：`GET https://api.cline.bot/api/v1/ai/cline/recommended-models`，头仅 `Accept: application/json` + `User-Agent: Mozilla/5.0 (cline2api)`，15s 超时
- 元数据只带 `id/name/description/context_length`（→ ModelInfo `contextWindow`）；不带 `pricing`/`tags`；`free` 恒 true、`capabilities` 恒 `['text']`
- 开关 `ProviderSettings.dynamicModels?: boolean`，**缺省 = 开**（undefined 当 true 处理，零迁移）
- 响应结构异常（无 `free` 键/空数组）按上游失败处理（走回退链）
- 不推送；完成后提醒用户

## 依赖与顺序

core（Task 1→2）→ server+UI（Task 3）→ 全量验证+文档（Task 4）。
**server 测试加载 core dist——每轮 server 测试前先 `pnpm --filter @freemodelfinder/core build`。**

---

## Task 1 — `cline-catalog.ts` 模块（纯新文件 + 测试）

**Files:**

| 文件                                                          | 改动                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/providers/cline-catalog.ts`                | **新建**：`listClineCatalogModels(opts): Promise<ClineCatalogModel[] \| null>`——内部：`ClineCatalogModel = { id, name?, description?, contextWindow? }`（裸 id）；模块级缓存 `{ models, at, inflight }`；`opts = { dynamicModels?: boolean; fetchImpl?: typeof fetch; now?: () => number; ttlMs?; timeoutMs? }`（now/ttl/timeout 可注入供测试）；逻辑按 spec 第 1/2 节 |
| `packages/core/src/providers/__tests__/cline-catalog.test.ts` | **新建**（node:test，mock `fetchImpl`，**不打真上游**）                                                                                                                                                                                                                                                                                                                |
| `packages/core/src/providers/index.ts`                        | 视需要导出（仅当外部需直接引用；`cline.ts` 可相对路径 import，优先不加公共导出）                                                                                                                                                                                                                                                                                       |

**实现要点（spec 第 1/2 节为准）：**

1. `dynamicModels === false` → 立即 `return null`（零网络、不查缓存）
2. 缓存新鲜（`now() - at < ttlMs`，默认 30min）→ 返回缓存
3. 过期 → 发请求（`inflight` 复用；15s 超时用 `AbortSignal.timeout` 或等价）；成功替换缓存并返回；**失败退旧缓存**（有数据返回旧的，无数据返回 `null`）
4. 解析：`raw.free` 数组缺失/为空/元素无 `id` → 抛错走失败回退；其余三组丢弃；normalize `name/description/context_length>0 → contextWindow`
5. fetch 头：`{ Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (cline2api)' }`；HTTP 非 2xx、JSON 解析失败、超长响应（>4MiB 参照 cline-free）均抛错
6. 全程 try/catch 收敛为 `null`/旧缓存——**函数本身不向调用方抛网络错误**

**测试要点**（先写测试确认失败 → 实现 → 通过）：

- 只认 `free` 组：mock 返回 `{ free: [{id:'a',context_length:4096}], recommended: [{id:'paid'}], clinePass:[…], clineCloud:[…] }` → 只出 `a` 且 `contextWindow===4096`；`paid` 不出现
- TTL 命中：连续两次调用只发 1 次 fetch（用计数 mock）
- 过期刷新：注入 `now` 跳过 31min → 第二次调用再发 fetch 且返回新数据
- 失败退旧缓存：第一次成功 → `now` 跳过 + 第二次 fetch 抛错 → 仍返回第一次数据
- 冷启动失败：无缓存 + fetch 抛错 → `null`
- inflight 合并：缓存过期时并发两次调用 → 恰 1 次 fetch、两次结果相同
- 开关短路：`dynamicModels: false` → `null` 且 fetch 计数 0（**即使有新鲜缓存**）
- 空 `free` 数组 / 无 `free` 键 → 按失败处理（冷启动返回 `null`，非 `[]`）
- 字段回退：无 `name` → displayName 回退逻辑在 Task 2 的 toModelInfo 测，本模块只断 raw normalize（缺省字段不填）

- [ ] 逐用例 TDD
- [ ] 验证：`npx prettier --write <改动文件>; if ($?) { npx eslint <改动文件> --max-warnings=0 }; if ($?) { pnpm --filter @freemodelfinder/core build }; if ($?) { pnpm --filter @freemodelfinder/core test }`
- [ ] Commit: `feat(core): cline 上游免费模型目录模块（free 组解析 + TTL 缓存 + 回退链）`

## Task 2 — 开关管道 + `listModels` 委托并集

**Files:**

| 文件                                                    | 改动                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/types.ts`                            | `ProviderSettings`（:236-240）加 `dynamicModels?: boolean`                                                                                                                                                                                                   |
| `packages/core/src/providers/base.ts`                   | `ProviderContext`（:16-28）加可选 `dynamicModels?: boolean`                                                                                                                                                                                                  |
| `packages/core/src/registry.ts`                         | `getProvider` 构造 ctx 处（既有 `credentialRuntime` 注入点附近）注入 `dynamicModels: this.config.providers.cline?.dynamicModels`（仅 cline 分支或通用透传均可，取通用透传：`this.config.providers[id]?.dynamicModels`——**注意缺省 undefined = 开，原样传**） |
| `packages/core/src/providers/cline.ts`                  | ① `listModels()`（:216-224）改为委托并集（spec 第 1 节代码为准）；② `BUILTIN_MODELS`（:19-24）**不动**（不加注释，仓库规则）；③ 模块内 `dedupeById`（裸 id 去重，动态优先——动态条目带元数据，内置裸条目仅兜底）                                              |
| `packages/core/src/providers/__tests__/cline.test.ts`   | 扩展 listModels 用例（见下）                                                                                                                                                                                                                                 |
| `packages/core/src/registry/__tests__/registry.test.ts` | 扩展 ctx 注入断言（若已有 getProvider 上下文用例则就近加）                                                                                                                                                                                                   |

**实现要点：**

1. `listModels()`：调 `listClineCatalogModels({ dynamicModels: this.ctx.dynamicModels, fetchImpl: this.ctx.fetchImpl })` → 合并 `BUILTIN_MODELS`（映射为 `{id}`）→ `dedupeById`（**动态条目在前优先**，内置仅补缺）→ `toModelInfo`（`id: composeModelId('cline', bare)` 或既有 `cline:` 前缀写法保持一致、`displayName: name ?? bare`、`description`、`contextWindow`、`free: true`、`capabilities: ['text']`、`provider: 'cline'`）
2. **既有行为零回归**：`registry.test.ts` 已有的 cline 模型解析（`cline-free/…`、双前缀、启发式）测试必须继续绿——并集后模型变多不影响按 id 解析
3. 测试注入：`ClineProvider` 构造 ctx 已有 `fetchImpl`（base.ts:19），测试直接注入 mock fetch 即可驱动 catalog（**不打真上游**）
4. 开关关：ctx `dynamicModels: false` → 纯内置 4 个

**测试要点**（扩展 `cline.test.ts`，mock fetch）：

- 并集：mock free 组 2 个（其中 1 个与内置重叠）→ 返回数量 = 去重后数量；重叠条目保留动态元数据
- 内置恒在：mock free 组不含 `cline-free/deepseek-v4.1-flash` → 内置 4 个仍全在
- 开关关：`dynamicModels: false` → 恰内置 4 个、fetch 计数 0
- 网络失败：fetch 抛错 → 返回内置 4 个（永不抛）
- 元数据映射：mock 带 `name/context_length/description` → ModelInfo 对应字段正确；`context_length: 0` → `contextWindow` 不填
- registry 注入：`config.providers.cline.dynamicModels = false` → `getProvider('cline')` 后 `listModels()` 纯内置（若单测注入成本高，此条放 server Task 3 的集成断言，报告注明）

- [ ] 逐用例 TDD
- [ ] 验证：`pnpm --filter @freemodelfinder/core build; if ($?) { pnpm --filter @freemodelfinder/core test }`（**core 全量，确认既有 cline/registry 测试零回归**）
- [ ] Commit: `feat(core): cline 模型清单动态并集与 dynamicModels 开关管道`

## Task 3 — server 保存/回显 + UI 勾选框

**Files:**

| 文件                                                        | 改动                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server.ts`                             | ① `POST /api/providers`（:787）body 类型（:770-786 一带）加 `dynamicModels?: boolean`；解构（:788-801）；写入与 `enabled` 同处的 provider settings 更新（`typeof dynamicModels === 'boolean'` 才写，避免 undefined 覆盖）；② `GET /api/config` 白名单（:639-650）providers 每项加 `dynamicModels: s?.dynamicModels ?? true`               |
| `packages/server/src/__tests__/cline-api.test.ts`           | POST 保存 `dynamicModels: false` → GET config 回显 `false`；缺省回显 `true`；保存 `enabled` 等其他字段时不重置 `dynamicModels`（partial 语义）                                                                                                                                                                                            |
| `packages/ui/app/components/ClineAccountsPanel.tsx`         | 卡片头部（启用开关旁或描述下方）加勾选框「动态同步上游免费模型」：读 `cfg.providers.cline.dynamicModels !== false`，变更 POST `/api/providers { provider:'cline', dynamicModels }`，成功后 `onChanged()` 走既有 refreshConfig；**注意不与 enabled 开关的保存流互相覆盖**（dynamicModels POST 不带 enabled 字段，服务端 partial 写入保证） |
| `packages/ui/app/i18n.tsx`                                  | zh/en 各 1-2 键（标签 + 可选提示文案）                                                                                                                                                                                                                                                                                                    |
| `packages/ui/app/components/__tests__/cline-panel.test.tsx` | 勾选框渲染默认勾上、切换触发 POST 载荷含 `dynamicModels`、回显（msw 记录请求）                                                                                                                                                                                                                                                            |

**要点：**

- server 侧「仅 boolean 才写」防止 `POST {provider,enabled}`（不带 dynamicModels）把已有值覆盖成 undefined——这是 Task 3 的核心回归风险，**必须有测试**
- UI 不新增页面；不改保存通道（仍 `/api/providers`）
- 勾选变更即时生效：server 收到后 `updateConfig` + registry 配置更新（与 enabled 同链），`onChanged` 刷新后下次 `listModels` 即按新开关

- [ ] server 测试 TDD → 实现 → 通过（先 `pnpm --filter @freemodelfinder/core build`）
- [ ] UI 测试 TDD → 实现 → 通过
- [ ] 验证：`npx prettier --write <改动文件>; if ($?) { npx eslint <改动文件> --max-warnings=0 }; if ($?) { pnpm --filter @freemodelfinder/server test }; if ($?) { pnpm --filter @freemodelfinder/ui exec vitest run }; if ($?) { pnpm --filter @freemodelfinder/server typecheck }; if ($?) { pnpm --filter @freemodelfinder/ui typecheck }`
- [ ] Commit: `feat(server,ui): cline dynamicModels 开关保存回显与设置勾选框`

## Task 4 — 全量验证 + 文档 + 审查

**Files:**

| 文件                 | 改动                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `docs/CLINE_FREE.md` | 增补「模型清单动态同步」小节：默认动态、开关位置、回退语义（断网=内置 4 个）、free 组来源端点说明 |
| （可能的修复）       | 验证链暴露的问题                                                                                  |

**验证链（AGENTS.md CI 顺序，已知例外照旧）：**

```
逐文件 prettier（本特性改动文件）     # 仓级 format:check 因 CRLF 基线跳过
pnpm lint
pnpm build:runtime
pnpm typecheck
pnpm test:coverage                   # 门槛 core 85/74、server 80/75、cli 80、ui 70
pnpm build
# 跳过：format:check、test:pack、audit:prod、verify:release（沿用既定决定）
```

- [ ] 全链跑通（失败→修→重跑；范围外存量失败列出根因不扩大修复面）
- [ ] 文档增补 + prettier + commit
- [ ] 报告：Status、每步结果、覆盖率、遗留清单；**提醒用户推送（不自行 push）**

## 执行后流程

按 subagent-driven-development：每 Task 实现者 → spec 合规审 → 质量审 → 修复回炉 → 复审 Approved 才进下一 Task；全部完成后 final review。
