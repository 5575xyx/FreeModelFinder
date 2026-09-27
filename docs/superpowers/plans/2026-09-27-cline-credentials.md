# Cline 凭据体系 + 网关内集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 cline-free 的能力作为一等 provider 集成进网关：平台无关凭据骨架（多账号池/冷却/设备授权/用量）+ Cline 协议层 + 页面内登录 + auto/failover 协同。

**Architecture:** core 新增 `credentials/` 子系统（平台无关），`providers/cline.ts` 消费之；registry 三处 `hasCredentials` 接缝解锁无 apiKey 的 provider；server 新增 `/api/cline/*`，UI 新增账号面板。详见 spec：`docs/superpowers/specs/2026-09-27-cline-credentials-design.md`（引用其节名）。

**Tech Stack:** TypeScript、zod、fastify、Next.js 16、node:test、vitest+msw。

日期：2026-09-27
状态：draft

## 关键决策（摘要，详见 spec）

- provider id `cline`；对外规范模型 id = `cline:<上游原生id>`；`cline-free/*`、`cline/*` 裸形式启发式兼容
- credential-store 是加解密唯一边界：payload 敏感字段显式 `encryptString(plain, masterKey)`（否则退化 `v2:`）；需 export `decryptSecret`/`loadMasterKey`
- 换号上限 min(池,3)；403→invalid；400 不换号；流式断开不换号；池尽冒泡 message 须可被 `parseRateLimitError` 解析（`failed 429` 或 RATE_LIMIT_PATTERNS 关键词 + ISO/retry-after）
- providerBaseline 不改（Partial ?? 50 兜底）
- 协议层从 cline-free `worker.js`（MIT）移植，保留版权头；池/冷却/存储重写
- 不推送；完成后提醒用户

## 依赖与顺序

core（Task 1→2→3）→ server（Task 4）→ UI（Task 5）→ 全量验证（Task 6）。
**server 测试加载 core dist——每轮 server 测试前先 `pnpm --filter @freemodelfinder/core build`。**

---

## Task 1 — types 基础 + base 钩子 + store 接线

**Files:**

| 文件                                  | 改动                                                                                                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`          | ① ProviderId union + `ProviderIdSchema`（:3）加 `'cline'`；② 新增 `CredentialPlatform`/`CredentialAccountEntry`（status 只有 `'active' \| 'invalid'`）/`CredentialPoolConfig`；③ `AppConfig`（:289）加 `credentials?: Partial<Record<CredentialPlatform, CredentialPoolConfig>>` |
| `packages/core/src/providers/base.ts` | ① `ProviderContext`（:15）加可选 `credentialRuntime?: CredentialRuntime`（**不能叫 credentials**——已有必填 `credentials: ProviderCredentials`）；② `BaseProvider` 加可选 `hasCredentials?(): boolean`                                                                            |
| `packages/core/src/config/store.ts`   | ① `DEFAULT_CONFIG.providers`（:64）加 `cline: { enabled: false }`；② `export` `decryptSecret`（:10）、`loadMasterKey`（:104）                                                                                                                                                    |
| `packages/core/src/registry.ts`       | `PROVIDER_CTORS`（:38）暂不加（等 Task 3 的 ClineProvider）                                                                                                                                                                                                                      |

**要点：** `CredentialRuntime` 类型先在 `credentials/runtime.ts` 定义为聚合接口（getPool/upsertAccount/removeAccount/pool/cooling/usage 的门面），Task 2 实现——本 task 只定类型，避免循环 import（types.ts 不 import runtime，接口放 runtime.ts，base.ts `import type`）。

**测试**（新建 `packages/core/src/credentials/__tests__/types.test.ts` 不需要——类型无运行时行为；本 task 测试并入 Task 2）。

- [ ] 实现上述改动
- [ ] 验证：`pnpm --filter @freemodelfinder/core build`（typecheck 由穷举 Record 保证：此时不加 PROVIDER_CTORS 会红——**若 typecheck 报 cline 缺 PROVIDER_CTORS，先加占位 `cline: undefined as any` 或把本 task 与 Task 3 的 ctor 注册合并执行**；推荐直接先建最小 `providers/cline.ts` 空壳（`class ClineProvider extends BaseProvider`、`id='cline'`、`listModels` 返回 `[]`、chat 抛 not implemented），Task 3 填充）
- [ ] Commit: `feat(core): cline provider id、凭据 schema 与 hasCredentials 钩子基础`

## Task 2 — credentials/ 骨架（5 组件 + 测试）

**Files:**

| 文件                                                | 职责（spec「存储 Schema」「架构总览」节）                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/credentials/credential-store.ts` | 池配置读写：payload 敏感字段（`refreshToken`）写前 `encryptString(v, masterKey)`、读时 `decryptSecret` 多层解密；api = `getPool/upsertAccount/removeAccount/saveSettings`（异步，走 config store 装配） |
| `packages/core/src/credentials/cooling-map.ts`      | 键 `accountId + model`，`'*'` = 账号级通配；`enter/clearAccount/clearAll/active/listForAccount`；重置优先级：显式时刻 > 文本时长解析 > 兜底分钟                                                         |
| `packages/core/src/credentials/account-pool.ts`     | `next(platform, model)`（跳过 invalid/有匹配活跃冷却，策略 round_robin/fill/random）、`reportRateLimit/reportInvalid/reportSuccess`                                                                     |
| `packages/core/src/credentials/usage-aggregator.ts` | 内存累加 + 节流写 `${CONFIG_DIR}/credentials-usage.json`、启动加载；`record/snapshot`                                                                                                                   |
| `packages/core/src/credentials/device-auth.ts`      | 平台无关状态机 `start/poll`：flowId→{状态, expiresAt}；pending→complete/expired/denied；Cline 适配器在 Task 3                                                                                           |
| `packages/core/src/credentials/runtime.ts`          | `CredentialRuntime` 门面 + `getCredentialRuntime()` 进程单例工厂 + `createTestRuntime()`（注入独立实例）                                                                                                |
| `packages/core/src/credentials/__tests__/*.test.ts` | 见下                                                                                                                                                                                                    |
| `packages/core/src/index.ts`                        | 导出 runtime 工厂与类型                                                                                                                                                                                 |

**测试要点**（node:test，每个组件一个文件）：

- credential-store：写入后 config.json 中 refreshToken 为 `v3:` 密文（**非原文、非 `v2:`**——必须显式传 masterKey）；多层解密兼容；invalid 持久化；用 `FREEMODELFINDER_HOME` 指向临时目录隔离
- cooling-map：时刻优先级（显式 > 文本 "try again in 45s" > 兜底分钟）；`'*'` 账号级（A 模型冷却不影响 B 模型条目）；过期惰性清理；clearAccount 手动解除
- account-pool：三策略轮换序；跳过 invalid/冷却账号；全冷却返回 null；lastUsedAt 更新时机（状态变化才落盘）
- usage-aggregator：累加、节流 flush、重启加载恢复、lastError 脱敏存储
- device-auth：start→poll pending→complete；过期；denied

- [ ] 逐组件 TDD（先写测试确认失败 → 实现 → 通过）
- [ ] 验证：`pnpm --filter @freemodelfinder/core build; if ($?) { pnpm --filter @freemodelfinder/core test }`
- [ ] Commit: `feat(core): 平台无关凭据骨架（store/pool/cooling/device-auth/usage）`

## Task 3 — ClineProvider 协议层 + registry 接缝

**Files:**

| 文件                                      | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/providers/cline.ts`    | 主体实现（Task 1 空壳填充）                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/core/src/registry.ts`           | ① `PROVIDER_CTORS` 加 `cline: ClineProvider`；② `resolveModel` 启发式区加 `cline-free/`、`cline/` 前缀剥离（try/catch fallthrough，仿 `glm-` 模式 :348）；③ **接缝 1/2**：`getProvider`（:139-145）与 `listEnabledProviders`（:165-180）先问 `hasCredentials` 钩子（无钩子走 apiKey 老逻辑）；实例获取复用 `instances` 缓存防循环（spec「三个既有接缝」）；④ `getProvider` 构造 ctx 处（:151-160）填 `credentialRuntime: getCredentialRuntime()` |
| `packages/core/src/providers/index.ts`    | 导出                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/core/src/router/auto-router.ts` | **不改**（providerBaseline Partial ?? 50）                                                                                                                                                                                                                                                                                                                                                                                                       |

**移植步骤（spec「移植清单」节）：**

- [ ] 步骤 0：获取源码 `https://github.com/Patrick-mufeng/cline-free`（`worker.js` 单文件，MIT）；提取：token 刷新端点/字段、chat 请求格式与 direct/planner 管道映射、SSE 转换、429/401/403 错误体形状、内置推荐模型清单（首发 ≥ README 推荐集）；文件头保留 MIT 版权归属注释
- [ ] 步骤 1：token 层——refreshToken→access 内存缓存、**刷新单飞**（并发共享 Promise）、过期前刷新；401 强刷一次 → 失败 `reportInvalid`；刷新端点网络/5xx **不判 invalid**
- [ ] 步骤 2：chat/stream——`hasCredentials()` = 池内有 active 账号；`next()` 取号 → 上游请求（管道按移植映射）→ SSE/非流式转换为 `StreamChunk`/`ChatResponse`
- [ ] 步骤 3：错误矩阵——429（Retry-After 头 > 明确字段 > 文本 > 兜底）→ `reportRateLimit` 冷却 → 换号（上限 min(池,3)，已试去重）；池尽冒泡 message 合成 `failed 429 ... <ISO|retry-after N>`（契约测试）；403→invalid+换号；400 不换号；网络/5xx 换号；流式中途断开不换号、透传、记 lastError
- [ ] 步骤 4：`listModels()` 返回内置清单（id = `cline:<上游原生id>`）；`enabled` 判定 = config enabled && 池有 active 账号

**测试**（`providers/__tests__/cline.test.ts` + registry 测试扩展，mock fetch/credentialRuntime 注入 `createTestRuntime()`）：

- 刷新单飞：并发 2 请求只发 1 次上游刷新；刷新失败并发传播
- 401→刷新→重试成功；refresh 失效→invalid；网络错→不 invalid
- 429→冷却 enter（断言键=账号×模型、resetAt）→换号成功；Retry-After 头解析
- 403→invalid+换号；400 不换号（fetch 只调 1 次）；换号上限=min(池,3)
- 池尽：message 断言可被 `parseRateLimitError` 解析（auto-router.ts:57-99）
- 流式中途断开不换号
- registry：`cline:x` 硬路由、`cline-free/x`、`cline/x` 启发式、cline 未配置时回落；有/无账号 × enabled 三态（getProvider + **listEnabledProviders 进聚合池**）
- failover 闭环两态：`autoRoute.enabled=true` 池尽→模型冷却→换 provider；`false` 时池尽只冒泡不跨 provider（spec 测试矩阵「autoRoute.enabled 开/关两态」；池内换号两态下都生效）
- resolveModel 既有测试全绿（不回归）

- [ ] 逐组 TDD
- [ ] 验证：`pnpm --filter @freemodelfinder/core build; if ($?) { pnpm --filter @freemodelfinder/core test }`
- [ ] Commit: `feat(core): Cline provider 协议层、模型路由与 hasCredentials 三接缝`

## Task 4 — server API + hasKey 接缝

**Files:**

| 文件                                              | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server.ts`                   | ① 新增 `/api/cline/login/start`、`/api/cline/login/poll`（UI 轮询，flow 内存 Map，完成即 credential-store 加密入库、返回脱敏摘要）；② `GET /api/cline/accounts`（cooling-map + usage-aggregator 聚合，**不回显 payload**）；③ `POST /api/cline/accounts/:id/cooldowns/clear`、`/logout`；④ **接缝 3**：`/api/config` GET 的 `hasKey`（:540 `!!s?.credentials?.apiKey`）对 `cline` 改为「池内有 active 账号」（其余 provider 不变）；⑤ 错误出口过 `redact()`（`Bearer *`/`refresh_token=*`/长 base64 掩码） |
| `packages/server/src/onboarding.ts`               | `ONBOARDING_ENVIRONMENT_KEYS` **不加** cline（无 env key 语义）                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/server/src/__tests__/cline-api.test.ts` | 新建                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**要点：** 路由注册在 `surface !== 'gateway'` 块内（与现有 `/api/*` 同享 `isTrustedUiRequest` 门禁）；Cline 设备授权适配器（真实 WorkOS 端点、字段映射）在 core `credentials/adapters/cline.ts`，server 只调 device-auth 状态机 + 适配器。

**测试：** login start→poll pending→complete 生命周期；expired/denied；accounts 响应 `assert(!JSON.stringify(res).includes('refreshToken'))`；cooldown clear/logout 生效；hasKey 三态（有/无账号、enabled）；redact 用例。

- [ ] TDD 实现
- [ ] 验证：`pnpm --filter @freemodelfinder/core build; if ($?) { pnpm --filter @freemodelfinder/server test }`
- [ ] Commit: `feat(server): cline 账号管理 API 与 hasKey 接缝`

## Task 5 — UI：平台卡片 + 账号面板

**Files:**

| 文件                                                        | 改动                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/ui/app/lib/platforms.ts`                          | `SETTINGS_PROVIDERS` 加 cline 条目（label/hint/link——**无 apiKey 输入**，hint 指向「登录 Cline 账号」）；`providerLabelKey` 加映射   |
| `packages/ui/app/i18n.tsx`                                  | zh/en × label/hint + 面板文案（登录向导、状态徽章、冷却倒计时、登出确认）                                                            |
| `packages/ui/app/components/ClineAccountsPanel.tsx`         | 新建：账号列表（active/冷却派生/invalid 展示态）、登录向导（start→倒计时→2.5s 轮询→complete/expired）、冷却解除/登出按钮、usage 摘要 |
| `packages/ui/app/components/SettingsView.tsx`               | Cline 卡片嵌入面板 + enabled 开关（沿用现有卡片模式；enabled 显示依赖 hasKey 新语义）                                                |
| `packages/ui/app/components/__tests__/cline-panel.test.tsx` | 新建（msw mock `/api/cline/*`）                                                                                                      |

**测试：** 面板三展示态渲染；登录向导轮询状态机（pending→complete / expired 重试）；enabled/hasKey 链下卡片状态；zh/en 文案存在性（既有 i18n 键等价测试模式）。

- [ ] TDD 实现
- [ ] 验证：`pnpm --filter @freemodelfinder/ui exec vitest run`
- [ ] Commit: `feat(ui): Cline 平台卡片与账号管理面板`

## Task 6 — 全量验证 + 两阶段审查

每个 Task 完成后：spec compliance review → code quality review（修复循环直到通过）。全部完成后全量验证链（PowerShell `; if ($?) { }` 串联，**禁 `&&`**）：

```
逐文件 npx prettier --write（仅改动文件）
npx eslint <改动文件> --max-warnings=0
pnpm --filter @freemodelfinder/core build
pnpm --filter @freemodelfinder/core test
pnpm --filter @freemodelfinder/server test
pnpm --filter freemodelfinder test        （既有 CLI dual-listener 13/14 范围外失败不修）
pnpm --filter @freemodelfinder/ui exec vitest run
pnpm build:runtime; if ($?) { pnpm typecheck }
```

- [ ] 覆盖率确认：core ≥85% lines / ≥74% branches（`pnpm --filter @freemodelfinder/core test --coverage`）
- [ ] 派 final reviewer 审整体实现（对照 spec 六节 + 本计划）
- [ ] 更新 `docs/CLINE_FREE.md` 为迁移说明（sidecar 下线指引）
- [ ] Commit + 提醒用户（不推送）

## 风险与既知事项

1. **worker.js 移植细节**：双管道映射/429 体形状以源码为准，fixture 固化；若端点与 README 描述不符，以源码为准并在 provider 注释标注差异
2. **设备授权 WorkOS 细节偏差**：适配器隔离（`credentials/adapters/cline.ts`），状态机不动即可修
3. 冷却内存态重启丢失——接受（spec 风险表）
4. 既有范围外失败：CLI dual-listener 测试；仓库级 `pnpm format:check` CRLF 噪音——只逐文件 prettier
5. 不跑 `pnpm build`/`pnpm test:pack`；不推送
6. 池尽冒泡契约失配 = failover 静默失效——契约测试为硬门禁
