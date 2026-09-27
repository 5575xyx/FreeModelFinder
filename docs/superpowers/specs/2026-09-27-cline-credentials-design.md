# Cline 凭据体系 + 网关内集成设计（产品级对标 CLIProxyAPI）

日期：2026-09-27
状态：已批准（设计经用户逐节确认，共 6 节；v2 修订合并独立审查意见——2 P0 / 6 P1 / 8 P2）

## 背景

用户报告网关「都不能用」，经诊断拆为两个现象：

1. 千帆全死 —— 根因是百度 2026-06 起退役全部免费模型（`a49ad97` 已修复，清空死清单保留动态骨架）；
2. cline-free 现以 sidecar（`127.0.0.1:8787`，`docs/CLINE_FREE.md`）方式接入，非网关本体能力。

本设计针对现象 2 并升级目标：不再做 cline-free 的临时挂载，而是把其能力
**作为产品级功能集成进 FreeModelFinder**，对标 CLIProxyAPI 的定位——聚合多个
OAuth/订阅制免费凭据平台为统一网关，Cline 是第一个平台。

## 需求决策（用户拍板）

| 决策点       | 结论                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 产品定位     | 产品级对标 CLIProxyAPI（统一凭据/配额/日志管理体系，多平台聚合）                                                       |
| 交付切分     | S1 骨架 + Cline 首发**合并先行**（骨架跟着首发落地，避免空设计）                                                       |
| 协议代码复用 | **协议移植 + 池重写**：逆向成果（token 刷新/上游格式/429 解析）移植保 MIT 版权，账号池/冷却/存储按我们架构重写并配测试 |
| 首发账号接入 | **首发含页面内登录**（WorkOS 设备授权进 Dashboard），不拆到 S2                                                         |
| 架构方案     | **方案一：core 凭据子系统 + provider 消费**（凭据骨架平台无关，Cline 为首个消费方）                                    |
| 统计边界     | 首发接入面板内 usage 摘要；独立统计/日志页、窗口化配额留 S2                                                            |

## 架构总览

```
packages/ui
  app/components/ClineAccountsPanel.tsx（新）+ SettingsView 嵌入
  app/lib/platforms.ts + app/i18n.tsx
      │ fetch + withUiHeaders（沿用现有模式）
packages/server
  POST /api/cline/login/start | /login/poll      设备授权（发起/轮询）
  GET  /api/cline/accounts                        账号列表（状态/冷却/用量）
  POST /api/cline/accounts/:id/cooldowns/clear | logout
  POST /api/providers (cline)                     沿用现有 provider 保存通道
      │ 复用 registry
packages/core
  credentials/            ← S1 骨架（平台无关，纯逻辑+测试）
    ├ credential-store    多凭据条目读写（加解密唯一边界，见存储 Schema 节）
    ├ account-pool        轮换策略 round_robin/fill/random + 切号状态机
    ├ cooling-map         「账号×模型」冷却（明确时刻 > 文本时长 > 兜底分钟）
    ├ device-auth         设备授权状态机（start/poll，平台无关形状）
    └ usage-aggregator    账号级用量聚合（持久化见下文；与既有 quota.ts 的
                            QuotaTracker 是不同组件，命名避让）
  providers/cline.ts      ← Cline 实现：移植协议层 + 消费骨架
  registry / auto-router  ← cline 进 PROVIDER_CTORS、hasCredentials 三处接线、failover 协同
```

### 一条 chat 请求的数据流

```
入站 /v1/chat/completions
  → registry.resolveModel → ClineProvider.chat
  → accountPool.next() 选可用账号（跳过 invalid/有活跃冷却）
  → token 刷新（单飞，防并发刷新风暴）
  → 移植协议的上游请求（流式/非流式，direct/planner 管道钉住）
  → 429？解析冷却粒度写入 cooling-map → 自动换号重试
  → 成功：回包 + usage-aggregator 记账 + lastUsedAt 更新
  → 池内全冷却：429 冒泡（文案契约见错误处理节）→ auto-router 模型冷却 → failover
```

### 边界原则

- **骨架不知道 Cline**：`credentials/` 全部 API 以 `platform` 字符串 + 通用类型工作；
  Cline 特有形状（refreshToken、WorkOS 端点）只出现在 `providers/cline.ts` 与登录适配器。
  S3 接 Codex/Claude 时骨架零改动为验收标准。
- **不新增明文敏感文件**：refreshToken 加密机制见存储 Schema 节（v2 修订，原稿未写清落点）。
- **冷却与 invalid 的持久化分治**：`invalid`（需重登）持久化；冷却态内存保存
  （重启丢失可接受，避免 429 高频写盘；cline-free 同为内存态）。

## 存储 Schema（types.ts 扩展）

```ts
export type CredentialPlatform = 'cline';   // S3 时加 'codex' | 'claude' | ...

export interface CredentialAccountEntry {
  id: string;                    // uuid，冷却/日志的稳定引用
  label?: string;                // 展示名（邮箱等）
  status: 'active' | 'invalid';  // invalid = refreshToken 失效需重登
                                 // （v2：删去 'cooling'——冷却是「账号×模型」粒度，
                                 //  由 cooling-map/cooldowns[] 表达，UI 徽章由
                                 //  「存在活跃冷却条目」推导，避免状态粒度矛盾）
  addedAt: number;
  lastUsedAt?: number;
  payload: Record<string, string>;   // 平台特有负载；敏感字段写盘前加密
}                                        // cline: { refreshToken(密), email(明), baseUrl(明) }

export interface CredentialPoolConfig {
  accounts: CredentialAccountEntry[];
  strategy?: 'round_robin' | 'fill' | 'random';    // 默认 round_robin
  cooldownFallbackMinutes?: number;                // 上游未给重置时间时兜底
}

// AppConfig 新增：
credentials?: Partial<Record<CredentialPlatform, CredentialPoolConfig>>;
```

### 加密落点（v2 修订，对应审查 P0-2）

原稿只说「挂 config v3 加密」，但 `saveConfig/loadConfig` 的
`encryptProviders/decryptProviders`（store.ts:206-357）只覆盖 `providers.*` 与
`gateway`——`credentials` 是新顶层字段，不扩展即**明文落盘**。决策：

- **credential-store 是加解密唯一边界**：写盘前对 payload 敏感字段逐个
  `encryptString`（密文原样随 config.json 保存），读盘时走既有 `decryptSecret`
  多层解密兼容（store.ts:10-19）；
- **`encryptProviders/decryptProviders` 保持不感知 credentials**（避免双重加密）；
  `normalizeConfig`（store.ts:359-374）`...input` 保留未知顶层键已验证可行；
- `/api/config` GET（server.ts:489-557）不序列化 credentials 字段——天然不回显；
- **测试断言**：写入后 `config.json` 中 refreshToken 为 `v3:` 密文（不是原文）。

## 模型 id 路由设计（核心冲突与解法）

实测 `resolveModel`（registry.ts:285-403，审查复核属实）：

| 输入形态                                    | 现有行为                                                      | 处理                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `cline:deepseek/deepseek-v4-flash`          | 冒号分支 310-317 → PROVIDER_CTORS 硬路由                      | 注册 ctor 后天然可行（未配置直接报错，不兜底）                                             |
| `cline-free/deepseek-v4-flash`（原生粘贴）  | 无冒号、启发式不命中 → 兜底 openrouter（402）                 | 启发式新增：剥 `cline-free/`、`cline/` 前缀 → cline provider（try/catch fallthrough 惯例） |
| `deepseek/deepseek-v4-flash`（剥前缀裸 id） | `startsWith('deepseek')` → sensenova→modelscope 链（369-378） | 不裸露：对外规范 id 恒为 `cline:<上游原生id>`                                              |

- **对外规范 id = `cline:<上游原生id>`**；Provider 内部只认剥净前缀的上游原生 id；
- 兼容意图：从 cline-free 迁移的用户粘贴原生模型名可直接命中。

## Token 生命周期与协议层

```
账号取号（池） → access token（内存缓存，过期前刷新）
  ├─ 刷新单飞：并发请求共享同一 Promise，防 refresh 风暴
  ├─ 上游 401 → 强制失效缓存 → 刷新一次 → 仍失败 → status='invalid' + UI 重登提示
  ├─ 刷新端点网络错误/5xx → 不判 invalid（防误杀），本次按网络错误处理
  └─ refreshToken 只在 credential-store 解密后进内存，不进日志/错误消息
```

### 移植清单（worker.js → providers/cline.ts，保留 MIT 版权头）

| 移植项                                                | 说明                                                    |
| ----------------------------------------------------- | ------------------------------------------------------- |
| refreshToken→access 端点/字段/过期语义                | 逆向细节，逐函数对照源码                                |
| 上游 chat 请求格式 + 双管道（direct/planner）渠道钉住 | 模型→管道映射照搬                                       |
| 流式 SSE 解析与转换                                   | 已有逆向成果                                            |
| 429/401/403 错误体解析 → 冷却时长/账号失效判定        | 输出喂给 cooling-map                                    |
| 模型清单（三段式 enabled 集）                         | 首发内置精选清单（README 推荐 4 个起步），在线刷新留 S2 |
| 重试放大语义                                          | 归 usage-aggregator 计数，UI 展示留 S2                  |

**重写不移植**：Worker 特化 IO、控制台 HTML、其进程内存储——全部走我们的
credential-store / account-pool / cooling-map。

### BaseProvider 适配与 ProviderId 改动面

ClineProvider 实现现有 `BaseProvider`（listModels / chat / stream，base.ts:87-89）；
入站 Anthropic/Gemini 协议转换由现有 `protocols/` 层完成，零新增协议代码。
ClineProvider 不调用 base 的 `nextKey`/`requireKey`（无 apiKey 语义）。

`'cline'` 加入 ProviderId 的连锁，**按检查时机区分**（v2 修订，对应审查 P2-15）：

| 改动点                              | 类型           | 不改的后果                                                                                  |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `types.ts` ProviderId union         | 编译期         | typecheck 报错                                                                              |
| `ProviderIdSchema`（zod enum）      | **运行时必改** | loadConfig 静默丢弃未知 provider（store.ts:362-363）、`/api/providers` 400（server.ts:602） |
| `store.ts` DEFAULT_CONFIG.providers | 运行时惯例     | 非穷举（先例：缺 `agnes-intl`），建议补                                                     |
| `registry.ts` PROVIDER_CTORS        | **运行时必改** | 冒号路由/实例化失败                                                                         |
| auto-router failover 池             | 运行时         | 候选缺失                                                                                    |
| UI platforms/i18n（zh/en）          | 展示           | 卡片/文案缺失                                                                               |

## Server API 与登录时序

```
POST /api/cline/login/start        → { flowId, code, userUrl, expiresAt }
POST /api/cline/login/poll         ← { flowId }
       → { status:'pending' } | { status:'complete', account:{id,label} } | 'expired' | 'denied'
GET  /api/cline/accounts           → { accounts:[{ id,label,status,addedAt,lastUsedAt,
                                       cooldowns:[{model,resetAt}],   // 由 cooling-map 提供
                                       usage:{requests,tokens,lastError} }] }  // 由 usage-aggregator 提供
POST /api/cline/accounts/:id/cooldowns/clear  → { cleared:number }
POST /api/cline/accounts/:id/logout           → { ok }   // 抹除 refreshToken 条目
POST /api/providers  (cline)       → 沿用现有 provider 保存通道
```

- flow 状态存 server 内存 Map（flowId→上游会话），过期即弃；**UI 轮询**
  （页面关=流程作废，符合设备授权短时语义，无后台任务管理负担）；
- **完成时刻 server 直接入库**：上游换到的 refreshToken → credential-store
  加密落盘 → 返回已脱敏 account 摘要；
- **运行时对象注入机制**（v2 修订，对应审查 P2-12）：`ProviderContext` 增加可选
  `credentials?: CredentialRuntime` 字段；`ProviderRegistry.load()` 构造 ctx 时注入
  core 导出的**进程级单例工厂**；测试构造 ctx 时传入独立实例——不改
  `PROVIDER_CTORS` 固定 `new Ctor(ctx)` 的结构。
- **usage 持久化**（v2 修订，对应审查 P1-7）：usage-aggregator 内存聚合 +
  节流写 `~/.freemodelfinder/credentials-usage.json`，启动时加载恢复，
  重启不清零；`lastError` 存最近一次错误（脱敏后）。

### 登录交互

```
UI 点「登录 Cline 账号」 → POST login/start → 展示 user_code + 「打开授权页」+ 倒计时
UI 每 2.5s POST login/poll → pending 继续 | complete → 刷新账号列表 + 成功提示
                          → expired/denied → 展示重试
多账号 = 重复该流程
```

### UI 结构（首发最小）

- `app/components/ClineAccountsPanel.tsx`（新）：账号列表（active/invalid 徽章、
  冷却倒计时（活跃冷却条目推导）、最后活跃、用量摘要）、登录向导、
  单账号冷却解除/登出；
- `app/components/SettingsView.tsx`：Cline 来源卡片嵌入该面板 + enabled 开关；
- `app/lib/platforms.ts` + `app/i18n.tsx`：cline 平台卡片、zh/en 文案；
- 独立统计/日志页 → S2。

### 三个既有接缝（v2 修订：原稿漏了第 1 条，审查 P0-1）

1. **`listEnabledProviders` 的 apiKey 硬门槛**（registry.ts:165-180，178 行）：
   与 getProvider 同样对非 custom 要求 `!!apiKey`。聚合池、`auto` 候选、failover 池、
   onboardingRequired（server.ts:457）**全走它**——只改 getProvider 则 cline 永不进
   modelsCache，设计目标落空。**listEnabledProviders 同步改为先问 `hasCredentials` 钩子**。
2. **`getProvider` 的 api-key 检查**（registry.ts:139-145）：`BaseProvider` 增加可选
   `hasCredentials(): boolean` 钩子；registry 改为「先问钩子，无钩子走 apiKey 老逻辑」；
   ClineProvider 报「池内有 active 账号」。
3. **`/api/config` GET 的 `hasKey` 耦合**（server.ts:540 → UI SettingsView:1806
   `enabled && state.hasKey`、enabledCount:1024）：`hasKey := !!credentials.apiKey` 会让
   cline 卡片永远显示未启用。**服务端 hasKey 判定接 hasCredentials/池状态**（UI 约定不变）。

### auto/failover 纳入

cline listModels（内置清单）进聚合池即成为候选（依赖接缝 1 修通）；enabled 判定 =
`config.providers.cline.enabled && 池内有 active 账号`；
**池尽 429 → 冒泡为 auto-router 模型冷却 → failover**（复用现有机制）。

> **开关依赖**（v2 修订，对应审查 P2-13）：跨 provider failover 仅在
> `autoRoute.enabled` 时生效（openai.ts:251、auto-router.ts:460，现状如此）；
> **池内换号不依赖该开关**（ClineProvider 内部行为，始终生效）。
> 显式 `cline:` 请求在 autoRoute 关闭时仅池内换号、不做跨 provider 兜底。

## 错误处理矩阵

| 上游结果                  | 判定                                                                                                                                                                                       | 动作                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 429                       | 解析重置时刻：**Retry-After 头 > 明确字段 > 文本时长 > 兜底分钟**（v2：补头解析——`parseRateLimitError` 只读 message 读不到头，provider 内解析后同时喂 cooling-map **并写进冒泡 message**） | cooling-map.enter(账号×模型) → 换号重试；池尽 → 429 冒泡 → auto-router 模型冷却 → failover    |
| 401 on access             | 单次强制刷新                                                                                                                                                                               | 成功→继续；refresh 失效→`status='invalid'`→换号；全失效 → 401「N 个账号凭据失效，请重新登录」 |
| **403**（v2 补）          | OAuth 平台语义：授权撤销/账号封禁                                                                                                                                                          | `status='invalid'` + 换号（区别于 400——是账号问题不是模型问题）                               |
| 400 模型未知等            | 账号无关                                                                                                                                                                                   | **不换号**直接报错（防模型名错误放大成账号雪崩）                                              |
| 网络错误 / 5xx            | 与账号无关                                                                                                                                                                                 | 换号尝试（同请求内），仍失败 → 现有重试/错误透传；刷新端点同类错误**不判 invalid**            |
| **流式中途断开**（v2 补） | 已发出部分响应                                                                                                                                                                             | **不换号**（不可重放），错误透传；记 usage-aggregator lastError；不标 invalid                 |

- **单请求换号上限 = min(池大小, 3)**：已尝试账号去重，最后错误原样上抛；
- 池内「账号×模型」冷却与 auto-router「模型级/共享配额 provider 级」冷却**两层协同**：
  账号级在池内消化，池尽才冒泡升级；`providerCooldowns` 不动（cline 不在
  `PROVIDER_SHARED_QUOTA`，203-213，池内自愈非 shared-quota 语义）。

### 池尽冒泡的错误文案契约（v2 修订，对应审查 P1-4）

池尽上抛的 429 错误 **message 必须含可被 `parseRateLimitError`
（auto-router.ts:57-99）解析的要素**：状态码 `429` 字样 + 最早 resetAt 的
ISO 时间或 `retry-after N` 文本。否则 failover 闭环（池尽→模型冷却→换 provider）
静默失效。此契约为 ClineProvider 测试断言项。

### 冒泡冷却的键语义（v2 修订，对应审查 P1-6）

auto-router 模型冷却沿用**既有 bare model id 全局键语义**（同名跨 provider
共命运）——该语义为 2026-09-25《Auto 全量候选 Failover 设计》已批准决策，本次
不改结构。cline 上游原生 id 多带命名空间前缀（`deepseek/`、`qwen/` 斜杠形式），
与既有 bare id（无斜杠）碰撞面有限；接受为既定全局语义的延续。

## 安全设计

- refreshToken 全生命周期：credential-store 加密落盘（v3 密文，测试断言）→
  仅进内存 → API 永不回显（GET accounts 只回 label/status/usage；
  `/api/config` 不序列化 credentials）→ 不写日志/错误消息；
- **日志脱敏层**：provider 错误上抛点统一过 `redact()`（`Bearer *`、
  `refresh_token=*`、长 base64 掩码），防移植代码的上游错误体泄密；
- **管理 API 鉴权（v2 修正表述，对应审查 P1-8）**：`/api/cline/*` 注册在
  `surface !== 'gateway'` 块内即与现有 `/api/*` 同享 `isTrustedUiRequest`
  本地 UI origin 门禁（server.ts:363-370）。注意：`gateway.requireAuth` 只覆盖
  `/v1/`、`/v1beta/` 前缀（PROTECTED_PREFIXES，server.ts:81/372-387），
  **并不保护 `/api/`**——远程暴露管理 API 的暴露面与既有全部 `/api/*` 等同
  （本功能不扩大、也不缩小），如需收紧属独立议题；
- 设备授权：user_code 非敏感；flow 内存态过期即弃；授权链接只出上游固定域
  `verification_uri`；
- 网关监听维持 `127.0.0.1` 默认。

## 可观测性

错误上抛携带结构化上下文 `{ platform:'cline', accountId(脱敏8位), model, resetAt? }`
→ 现有 toast / 账号面板冷却倒计时展示「谁、在哪个模型、何时恢复」；重试放大计数进
usage-aggregator（聚合展示留 S2）。

## 测试策略

| 层                   | 测试内容                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 骨架单元             | store：**config.json 中 refreshToken 为 `v3:` 密文**（非原文）、多层解密兼容、invalid 持久化、`/api/config` 不回显 payload；pool：三策略轮换+跳过有冷却/invalid+空池；cooling：时刻优先级（含 Retry-After 头）/**`*` 账号级通配语义**/过期清理/手动解除；device-auth：状态机+过期；usage-aggregator：累加/flush/重启恢复 |
| ClineProvider        | 刷新单飞（并发只发一次、失败并发传播）、401→刷新→重试、refresh 失效→invalid、429→冷却→换号、**403→invalid+换号**、池尽→429 冒泡（**断言文案契约可被 parseRateLimitError 解析**）、**400 不换号**、**流式中途断开不换号**、换号上限=min(池,3)、流式/非流式 fixture、listModels                                            |
| registry/router 集成 | 三路径 id 路由（含 `cline-free/` 在 cline 未配置时回落）、**hasCredentials 三处接线**（getProvider/listEnabledProviders/hasKey：有账号、无账号、未启用）、池尽→模型冷却→failover 闭环（autoRoute.enabled 开/关两态）                                                                                                     |
| server API           | login start/poll 生命周期、accounts 响应断言不含 refreshToken、cooldown clear/logout、**redact() 脱敏用例**                                                                                                                                                                                                              |
| UI                   | 面板三状态渲染、登录向导轮询状态机、**enabled/hasKey 链下 cline 卡片状态**、zh/en 文案                                                                                                                                                                                                                                   |

覆盖率 core 85%/74% 门槛不降；验证链：逐文件 prettier → eslint（0 警告）→
分包测试 → `pnpm build:runtime; if ($?) { pnpm typecheck }`。

## 非目标（明确排除）

- S2：凭据中心独立页（多平台聚合视图）、统计/日志页完整迁移（CallLogEntry 届时
  扩 `accountId` 字段，P2-10）、窗口化配额（5h/7d）、模型清单在线刷新；
- S3：Codex/Claude/Gemini/Antigravity 等后续平台（骨架零改动为验收标准）；
- cline-free sidecar 的继续维护（集成完成后 `docs/CLINE_FREE.md` 重写为迁移说明）；
- 对 worker.js 整体 vendor 或进程内托管（已否决：架构脏、测试难）。

## 风险与对策

| 风险                                    | 对策                                                        |
| --------------------------------------- | ----------------------------------------------------------- |
| 逆向协议细节（双管道/429 体）与源码不符 | 移植时逐函数对照 worker.js，fixture 固化上游响应            |
| 模型 id 启发式与既有 provider 前缀冲突  | 规范 id 恒带 `cline:` 冒号；启发式条目 try/catch 且前缀排他 |
| 设备授权流程 WorkOS 细节与假设偏差      | device-auth 状态机与平台适配器分离，适配器内可单独修正      |
| 冷却内存态重启丢失导致重启即 429        | 接受（与 cline-free 同）；如需可后续把冷却快照进 config     |
| 加密边界实现偏差导致明文落盘            | P0-2 已定机制；测试断言 `v3:` 密文为硬门禁                  |
| 池尽冒泡文案与 parseRateLimitError 失配 | 文案契约写入测试断言（见错误处理节）                        |
