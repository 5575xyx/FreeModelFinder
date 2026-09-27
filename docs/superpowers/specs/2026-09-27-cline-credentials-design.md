# Cline 凭据体系 + 网关内集成设计（产品级对标 CLIProxyAPI）

日期：2026-09-27
状态：已批准（设计经用户逐节确认，共 6 节）

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
  components/ClineAccountsPanel.tsx（新）+ SettingsView 嵌入 + platforms/i18n
      │ fetch + withUiHeaders（沿用现有模式）
packages/server
  POST /api/cline/login/start | /login/poll      设备授权（发起/轮询）
  GET  /api/cline/accounts                        账号列表（状态/冷却/用量）
  POST /api/cline/accounts/:id/cooldowns/clear | logout
  POST /api/providers (cline)                     沿用现有 provider 保存通道
      │ 复用 registry
packages/core
  credentials/            ← S1 骨架（平台无关，纯逻辑+测试）
    ├ credential-store    多凭据条目读写（挂 config v3 加密，不新增明文文件）
    ├ account-pool        轮换策略 round_robin/fill/random + 切号状态机
    ├ cooling-map         「账号×模型」冷却（明确时刻 > 文本时长 > 兜底分钟）
    ├ device-auth         设备授权状态机（start/poll，平台无关形状）
    └ quota-tracker       账号级用量记录接口（未来 Codex/Claude 复用）
  providers/cline.ts      ← Cline 实现：移植协议层 + 消费骨架
  registry / auto-router  ← cline 进 PROVIDER_CTORS、hasCredentials 钩子、failover 协同
```

### 一条 chat 请求的数据流

```
入站 /v1/chat/completions
  → registry.resolveModel → ClineProvider.chat
  → accountPool.next() 选可用账号（跳过 invalid/cooling）
  → token 刷新（单飞，防并发刷新风暴）
  → 移植协议的上游请求（流式/非流式，direct/planner 管道钉住）
  → 429？解析冷却粒度写入 cooling-map → 自动换号重试
  → 成功：回包 + quota-tracker 记账 + lastUsedAt 更新
  → 池内全冷却：429 明确告知「哪个模型、何时恢复」→ auto-router 模型冷却 → failover
```

### 边界原则

- **骨架不知道 Cline**：`credentials/` 全部 API 以 `platform` 字符串 + 通用类型工作；
  Cline 特有形状（refreshToken、WorkOS 端点）只出现在 `providers/cline.ts` 与登录适配器。
  S3 接 Codex/Claude 时骨架零改动为验收标准。
- **不新增明文敏感文件**：refreshToken 走现有 `master.key` 加密体系，文件权限 0600 沿用。
- **冷却与 invalid 的持久化分治**：`invalid`（需重登）持久化；冷却态内存保存
  （重启丢失可接受，避免 429 高频写盘；cline-free 同为内存态）。

## 存储 Schema（types.ts 扩展）

```ts
export type CredentialPlatform = 'cline';   // S3 时加 'codex' | 'claude' | ...

export interface CredentialAccountEntry {
  id: string;                    // uuid，冷却/日志的稳定引用
  label?: string;                // 展示名（邮箱等）
  status: 'active' | 'cooling' | 'invalid';   // invalid = refreshToken 失效需重登
  addedAt: number;
  lastUsedAt?: number;
  payload: Record<string, string>;   // 平台特有负载；敏感字段写盘逐字段加密
}                                        // cline: { refreshToken(密), email(明), baseUrl(明) }

export interface CredentialPoolConfig {
  accounts: CredentialAccountEntry[];
  strategy?: 'round_robin' | 'fill' | 'random';    // 默认 round_robin
  cooldownFallbackMinutes?: number;                // 上游未给重置时间时兜底
}

// AppConfig 新增：
credentials?: Partial<Record<CredentialPlatform, CredentialPoolConfig>>;
```

## 模型 id 路由设计（核心冲突与解法）

实测 `resolveModel`（registry.ts:285-403）：

| 输入形态                                    | 现有行为                             | 处理                                                         |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `cline:deepseek/deepseek-v4-flash`          | 冒号分支 → PROVIDER_CTORS            | 注册 ctor 后天然可行（硬路由，provider 未配置直接报错）      |
| `cline-free/deepseek-v4-flash`（原生粘贴）  | 无匹配 → 兜底 openrouter             | 启发式新增：剥 `cline-free/`、`cline/` 前缀 → cline provider |
| `deepseek/deepseek-v4-flash`（剥前缀裸 id） | `startsWith('deepseek')` → sensenova | 不裸露：对外规范 id 恒为 `cline:<上游原生id>`                |

- **对外规范 id = `cline:<上游原生id>`**；Provider 内部只认剥净前缀的上游原生 id；
- 启发式条目沿用 try/catch fallthrough 惯例（cline 未配置时回落默认行为）；
- 兼容意图：从 cline-free 迁移的用户粘贴原生模型名可直接命中。

## Token 生命周期与协议层

```
账号取号（池） → access token（内存缓存，过期前刷新）
  ├─ 刷新单飞：并发请求共享同一 Promise，防 refresh 风暴
  ├─ 上游 401 → 强制失效缓存 → 刷新一次 → 仍失败 → status='invalid' + UI 重登提示
  └─ refreshToken 只在 credential-store 解密后进内存，不进日志/错误消息
```

### 移植清单（worker.js → providers/cline.ts，保留 MIT 版权头）

| 移植项                                                | 说明                                                    |
| ----------------------------------------------------- | ------------------------------------------------------- |
| refreshToken→access 端点/字段/过期语义                | 逆向细节，逐函数对照源码                                |
| 上游 chat 请求格式 + 双管道（direct/planner）渠道钉住 | 模型→管道映射照搬                                       |
| 流式 SSE 解析与转换                                   | 已有逆向成果                                            |
| 429/401 错误体解析 → 冷却时长/账号失效判定            | 输出喂给 cooling-map                                    |
| 模型清单（三段式 enabled 集）                         | 首发内置精选清单（README 推荐 4 个起步），在线刷新留 S2 |
| 重试放大语义                                          | 归 quota-tracker 计数，UI 展示留 S2                     |

**重写不移植**：Worker 特化 IO、控制台 HTML、其进程内存储——全部走我们的
credential-store / account-pool / cooling-map。

### BaseProvider 适配与 ProviderId 改动面

ClineProvider 实现现有 `BaseProvider`（listModels + chat/stream）；入站
Anthropic/Gemini 协议转换由现有 `protocols/` 层完成，零新增协议代码。

`'cline'` 加入 ProviderId 的连锁（typecheck 兜底穷举）：
`types.ts` union + `ProviderIdSchema` → `store.ts` DEFAULT_CONFIG →
`registry.ts` PROVIDER_CTORS → auto-router failover 池 → UI platforms/i18n（zh/en）。

## Server API 与登录时序

```
POST /api/cline/login/start        → { flowId, code, userUrl, expiresAt }
POST /api/cline/login/poll         ← { flowId }
       → { status:'pending' } | { status:'complete', account:{id,label} } | 'expired' | 'denied'
GET  /api/cline/accounts           → { accounts:[{ id,label,status,addedAt,lastUsedAt,
                                       cooldowns:[{model,resetAt}], usage:{requests,tokens,lastError} }] }
POST /api/cline/accounts/:id/cooldowns/clear  → { cleared:number }
POST /api/cline/accounts/:id/logout           → { ok }   // 抹除 refreshToken 条目
POST /api/providers  (cline)       → 沿用现有 provider 保存通道
```

- flow 状态存 server 内存 Map（flowId→上游会话），过期即弃；**UI 轮询**
  （页面关=流程作废，符合设备授权短时语义，无后台任务管理负担）；
- **完成时刻 server 直接入库**：上游换到的 refreshToken → credential-store
  加密落盘 → 返回已脱敏 account 摘要；
- 运行时对象（AccountPool/CoolingMap/DeviceAuth/quota-tracker）：core 导出
  **进程级单例工厂**，server 路由与 ClineProvider 注入同一份引用；测试注入独立实例。

### 登录交互

```
UI 点「登录 Cline 账号」 → POST login/start → 展示 user_code + 「打开授权页」+ 倒计时
UI 每 2.5s POST login/poll → pending 继续 | complete → 刷新账号列表 + 成功提示
                          → expired/denied → 展示重试
多账号 = 重复该流程
```

### UI 结构（首发最小）

- `components/ClineAccountsPanel.tsx`（新）：账号列表（active/cooling/invalid 徽章、
  最后活跃、冷却倒计时）、登录向导、单账号冷却解除/登出；
- `SettingsView.tsx`：Cline 来源卡片嵌入该面板 + enabled 开关；
- `platforms.ts` + `i18n.tsx`：cline 平台卡片、zh/en 文案；
- 独立统计/日志页 → S2。

### 两个既有接缝

1. **`getProvider` 的 api-key 检查会误杀**（registry.ts:140-144）——`BaseProvider`
   增加可选 `hasCredentials(): boolean` 钩子；registry 改为「先问钩子，无钩子走
   apiKey 老逻辑」；ClineProvider 报「池内有 active 账号」。
2. **auto/failover 纳入自动**：cline listModels 进聚合池即成为候选；enabled 判定 =
   `config.providers.cline.enabled && 池内有 active 账号`；池尽 429 → 冒泡为
   auto-router 模型冷却 → failover（复用现有机制，零改动）。

## 错误处理矩阵

| 上游结果       | 判定                               | 动作                                                                                                   |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 429            | 解析重置时刻（明确 > 文本 > 兜底） | cooling-map.enter(账号×模型) → 换号重试；池尽 → 429（附最早恢复时刻）→ auto-router 模型冷却 → failover |
| 401 on access  | 单次强制刷新                       | 成功→继续；refresh 失效→invalid→换号；全失效 → 401「N 个账号凭据失效，请重新登录」                     |
| 网络错误 / 5xx | 与账号无关                         | 换号尝试（同请求内），仍失败 → 现有重试/错误透传                                                       |
| 400 模型未知等 | 账号无关                           | **不换号**直接报错（防模型名错误放大成账号雪崩）                                                       |

- **单请求换号上限 = min(池大小, 3)**：已尝试账号去重，最后错误原样上抛；
- 池内「账号×模型」冷却与 auto-router「模型级/共享配额 provider 级」冷却**两层协同**：
  账号级在池内消化，池尽才冒泡升级；`providerCooldowns` 不动（cline 池内自愈，
  非 shared-quota 语义）。

## 安全设计

- refreshToken 全生命周期：master.key 加密落盘 → 仅进内存 → API 永不回显
  （GET accounts 只回 label/status/usage）→ 不写日志/错误消息；
- **日志脱敏层**：provider 错误上抛点统一过 `redact()`（`Bearer *`、
  `refresh_token=*`、长 base64 掩码），防移植代码的上游错误体泄密；
- 管理鉴权自动继承：`/api/cline/*` 与现有 `/api/*` 同一中间件链（requireAuth），
  不新增鉴权体系；
- 设备授权：user_code 非敏感；flow 内存态过期即弃；授权链接只出上游固定域
  `verification_uri`；
- 网关监听维持 `127.0.0.1` 默认；生产暴露走现有 requireAuth。

## 可观测性

错误上抛携带结构化上下文 `{ platform:'cline', accountId(脱敏8位), model, resetAt? }`
→ 现有 toast / 账号面板冷却倒计时展示「谁、在哪个模型、何时恢复」；重试放大计数进
quota-tracker（聚合展示留 S2）。

## 测试策略

| 层                   | 测试内容                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 骨架单元             | store：加密 roundtrip/多层解密兼容/invalid 持久化；pool：三策略轮换+跳过 cooling/invalid+空池；cooling：时刻优先级/`*` 账号级/过期清理/手动解除；device-auth：状态机+过期；quota：累加/flush 恢复 |
| ClineProvider        | 刷新单飞（并发只发一次）、401→刷新→重试、refresh 失效→invalid、429→冷却→换号、池尽→429 冒泡、**400 不换号**、换号上限=min(池,3)、流式/非流式 fixture、listModels                                  |
| registry/router 集成 | 三路径 id 路由、hasCredentials 钩子（有/无账号、未启用）、池尽→模型冷却→failover 闭环                                                                                                             |
| server API           | login start/poll 生命周期、**accounts 响应断言不含 refreshToken**、requireAuth 继承、cooldown clear/logout                                                                                        |
| UI                   | 面板三状态渲染、登录向导轮询状态机、zh/en 文案                                                                                                                                                    |

覆盖率 core 85%/74% 门槛不降；验证链：逐文件 prettier → eslint（0 警告）→
分包测试 → `pnpm build:runtime; if ($?) { pnpm typecheck }`。

## 非目标（明确排除）

- S2：凭据中心独立页（多平台聚合视图）、统计/日志页完整迁移、窗口化配额
  （5h/7d）、模型清单在线刷新；
- S3：Codex/Claude/Gemini/Antigravity 等后续平台（骨架零改动为验收标准）；
- cline-free sidecar 的继续维护（集成完成后 `docs/CLINE_FREE.md` 重写为迁移说明）；
- 对 worker.js 整体 vendor 或进程内托管（已否决：架构脏、测试难）。

## 风险与对策

| 风险                                    | 对策                                                        |
| --------------------------------------- | ----------------------------------------------------------- |
| 逆向协议细节（双管道/429 体）与源码不符 | 移植时逐函数对照 worker.js，fixture 固化上游响应            |
| 模型 id 启发式与既有 provider 前缀冲突  | 规范 id 恒带 `cline:` 冒号；启发式条目 try/catch 且排他前缀 |
| 设备授权流程 WorkOS 细节与假设偏差      | device-auth 状态机与平台适配器分离，适配器内可单独修正      |
| 冷却内存态重启丢失导致重启即 429        | 接受（与 cline-free 同）；如需可后续把冷却快照进 config     |
