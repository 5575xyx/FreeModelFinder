# 订阅账号集成实施计划（第一波：Codex / Claude / Google）

> **状态：已完成（第一波，2026-10-16）。本文档是历史实施记录，不反映当前路由。**
> 第二波（`plans/2026-10-16-subscription-oauth-login.md`）已把 `/api/subscription/accounts` 改名为 `/api/subscription/credentials`、把 `POST /api/subscription/import` 改名为 `POST /api/subscription/credentials?provider=`，并新增 OAuth 交互登录端点。下文出现的旧路由一律以
> `specs/2026-10-14-subscription-accounts-design.md` §4.4 与 `specs/2026-10-16-subscription-oauth-login-design.md` §13.1 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户把 ChatGPT(Codex)/Claude/Google 订阅账号的官方 CLI 凭证文件导入 FreeModelFinder，把订阅额度变成本地统一 API 算力（含自动刷新、多账号池、429 冷却、auto 兜底路由）。

**Architecture:** 在 core 的 credentials 层新增"订阅凭证适配器"框架（每家一个 ≤200 行适配器：解析导入/刷新/身份描述），provider 层新增三个继承 `BaseProvider` 的实现（照抄 `ClineProvider` 的账号池切换 + 刷新链模式），把各家订阅协议翻译到内部 `ChatRequest`/`StreamChunk`。server 层新增 `/api/subscription/*` 端点，Next.js 设置页新增账号面板。路由层保证订阅模型在 auto 链中恒排免费模型之后（兜底模式）。

**Tech Stack:** TypeScript（strict + noUncheckedIndexedAccess）、Node ≥ 22.14、Fastify（server）、Next.js（ui）、node --test + tsx（core/server 测试）、Vitest（ui 测试）。

**Spec:** `docs/superpowers/specs/2026-10-14-subscription-accounts-design.md`（本计划所有取值均论证自该 spec，执行者需一并阅读）。

**参考移植源（只读）:** `C:\Users\13428\AppData\Local\Temp\opencode\CLIProxyAPI`（浅克隆，Go）。协议常量与请求形状以 spec §5 已核实行 + 该源码为准，计划内不再重复贴出。

## Global Constraints

- 仓库规范见根 `AGENTS.md`；Node ≥ 22.14，pnpm 11，`noUncheckedIndexedAccess: true`
- core 测试 glob 固定：`src/__tests__/*.test.ts src/config/__tests__/*.test.ts src/credentials/__tests__/*.test.ts src/router/__tests__/*.test.ts src/providers/__tests__/*.test.ts src/registry/__tests__/*.test.ts`——新测试文件必须放进这些目录，否则跑不到；如确需新目录，同步改 `packages/core/package.json` 的 test 脚本
- server 测试目录：`src/__tests__/`、`src/routes/__tests__/`；ui 测试为 Vitest（`app/**/__tests__/`）
- CI 顺序（本地验收同序）：`pnpm format:check → pnpm lint → pnpm build:runtime → pnpm typecheck → pnpm test:coverage → pnpm build → pnpm test:pack`
- lint 范围仅 `packages/**/*.{ts,tsx}`，`--max-warnings=0`；`@typescript-eslint/no-explicit-any` 已关闭
- 所有抛出的错误消息必须经 `redact()`（`packages/core/src/credentials/redact.ts`）脱敏；新错误类构造函数里调用
- payload 落盘加密由 `credential-store.ts` 的 `SENSITIVE_PAYLOAD_FIELDS` 白名单驱动——**payload 键名必须用** `accessToken`/`refreshToken`/`idToken`/`clientSecret`（连字符/下划线会被归一化，但保持驼峰与现有一致）
- UI 文案用中文；新 UI 文案不引入 i18n 框架（ui 包现状无 i18n，照抄现有硬编码中文风格）
- 不推送 GitHub；每个 Task 完成后提醒用户可推送，由用户决定
- 每个 provider Task 的最终验收需要用户真实账号（spec §6）：执行到"真实验收"步骤时，向用户索取配合，不得伪造通过

## Review Focus

（spec 隐含但最容易出错的五类问题；每个都有对应任务的测试锚定。）

1. **refresh token 轮换互踩**：同一账号并发触发两次刷新（并发请求同时 401），若各自拿旧 refresh token 去刷，第二次必失败且可能作废凭证。→ Task 2 的 flight cache 测试 + Task 3 codex adapter `isFatalRefreshError('refresh_token_reused')` 测试。
2. **Claude refresh token 单次性 + 网络错误不确定性**：刷新请求网络失败时，Anthropic 可能已消费掉单次性 refresh token，原地用同一 token 重试会把瞬时网络故障放大成永久失效（参考源码 `isClaudeRefreshRetryable` 注释即此意）。→ Task 6 测试：网络错误分类为非致命但不可原地重试，Task 7 provider 行为=换账号而非原地重刷。
3. **订阅模型挤占免费路由**：auto 链或裸名解析把订阅模型排到免费模型前面，用户订阅额度被无意消耗（违反 spec 反目标）。→ Task 10 registry 测试断言排序。
4. **加密落盘字段名错位**：payload 键名若不命中 `SENSITIVE_PAYLOAD_FIELDS`，token 会明文落盘。→ Task 3/6/8 的 adapter 测试断言产出 payload 键名集合 ⊆ 加密白名单命中集（用 `encryptPayload` 行为验证：测试里对入库 payload 跑一次真实 store upsert + 读 config.json 原文断言无明文 token）。
5. **token 泄漏到错误消息/日志**：上游 401 响应体常回显 token，直接拼进错误消息会泄漏。→ 各 provider 测试用"响应体含假 token"的 mock 断言抛出的错误消息中不含该 token。

---

### Task 1: 类型与配置骨架

**Files:**

- Modify: `packages/core/src/types.ts:4-24`（ProviderIdSchema）、`:401`（CredentialPlatform）、`:193-209`（ModelInfo）
- Modify: `packages/core/src/config/store.ts:83` 附近（DEFAULT_CONFIG）
- Test: `packages/core/src/credentials/__tests__/subscription-scaffold.test.ts`

**Interfaces:**

- Produces: `ProviderId` 增三项 `'codex' | 'claude' | 'google'`；`CredentialPlatform = 'cline' | 'codex' | 'claude' | 'google'`；`ModelInfo.subscription?: boolean`；DEFAULT_CONFIG 含 `codex/claude/google: { enabled: false }`
- 后续所有任务依赖这三个枚举值与 `subscription` 字段

- [ ] **Step 1: 写失败测试** `subscription-scaffold.test.ts`
  - 断言 `ProviderIdSchema.safeParse('codex'|'claude'|'google').success === true`
  - 断言 `loadConfig()`（隔离 HOME）后 `config.providers.codex.enabled === false`（claude/google 同）
  - 编译期断言：`const p: CredentialPlatform = 'google'` 可通过 typecheck
- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @freemodelfinder/core test`，期望 scaffold 测试 FAIL（schema 拒绝新值）
- [ ] **Step 3: 实现** — `ProviderIdSchema` 枚举追加 `'codex','claude','google'`；`CredentialPlatform` 联合类型追加三项；`ModelInfo` 加 `subscription?: boolean`（带一行注释：订阅额度模型，auto 路由中恒排免费之后）；DEFAULT_CONFIG 追加三个 `{ enabled: false }` 项
- [ ] **Step 4: 跑测试确认通过 + typecheck** — `pnpm --filter @freemodelfinder/core test` PASS；`pnpm build:runtime && pnpm typecheck` 无错（全仓因新枚举项暴露的穷举 switch 需在此步修完——若 `PROVIDER_CTORS` 报缺项，临时用 Task 4/7/9 的占位类不可行，改为把 `PROVIDER_CTORS` 的 Record 类型在此步改为 `Partial` 并在 `getProvider` 处抛错？**否**——保持严格：在 PROVIDER_CTORS 中暂缺的三家由 Task 4/7/9 补齐前，将该 Record 的 Exclude 泛型临时扩为允许缺项，并在 Task 9 收尾恢复严格。此调整只动 `registry.ts:49-52` 一处类型签名）
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): add codex/claude/google provider ids and subscription model flag"`

### Task 2: 订阅适配器框架

**Files:**

- Create: `packages/core/src/credentials/adapters/subscription/types.ts`
- Create: `packages/core/src/credentials/adapters/subscription/helpers.ts`
- Create: `packages/core/src/credentials/adapters/subscription/index.ts`
- Test: `packages/core/src/credentials/__tests__/subscription-adapter.test.ts`

**Interfaces:**

- Produces（Task 3/6/8 逐字使用）:

```ts
export interface SubscriptionAdapter {
  readonly platform: 'codex' | 'claude' | 'google';
  parseImport(raw: string): ParsedSubscription; // 失败抛 SubscriptionImportError
  refresh(opts: {
    fetchImpl?: typeof fetch;
    refreshToken: string;
    payload: Record<string, string>;
  }): Promise<RefreshResult>; // 失败抛 SubscriptionRefreshError
  isFatalRefreshError(error: unknown): boolean; // true = 账号永久失效（invalid_grant 等）
  accountIdOf(profile: SubscriptionAccountProfile, payload: Record<string, string>): string;
}
export interface ParsedSubscription {
  payload: Record<string, string>;
  profile: SubscriptionAccountProfile;
}
export interface RefreshResult {
  payload: Record<string, string>;
  profile?: SubscriptionAccountProfile;
}
export interface SubscriptionAccountProfile {
  id: string;
  email?: string;
  plan?: string;
  organization?: string;
}
export class SubscriptionImportError extends Error {} // 构造时 redact()
export class SubscriptionRefreshError extends Error {
  // 构造时 redact()
  readonly kind: 'fatal' | 'rate_limit' | 'network';
  readonly status?: number;
  readonly resetAt?: number;
}
export const REFRESH_SKEW_MS = 60_000;
// helpers.ts
export function createFlightCache<T>(): { run(key: string, fn: () => Promise<T>): Promise<T> };
export function parseExpiryMs(raw: string | undefined, now?: number): number; // 空/非法 → now（视同过期，触发刷新）
export function decodeJwtPayload(token: string): Record<string, unknown> | null; // 仅 base64url 解中段，不验签（身份展示用）
export const SUBSCRIPTION_ADAPTERS: Record<'codex' | 'claude' | 'google', SubscriptionAdapter>; // index.ts，Task 3/6/8 各自往里注册
```

- Consumes: `redact()`、Task 1 的 `CredentialPlatform`

- [ ] **Step 1: 写失败测试** `subscription-adapter.test.ts`
  - `createFlightCache`：并发同一 key 只执行 fn 一次（计数器断言 1），不同 key 并行各执行
  - `parseExpiryMs`：`undefined` → now；`'1755000000000'`（>1e12）→ 原值；`'1755000000'`（秒）→ ×1000；ISO 字符串 → Date.parse
  - `decodeJwtPayload`：构造 `x.eyJhIjoxfQ.y` 断言返回 `{a:1}`；畸形 token → null
  - `SubscriptionRefreshError` 构造时消息被 redact（消息里混入 `refresh_token=SECRETVAL`，断言 `error.message` 不含 `SECRETVAL`）
- [ ] **Step 2: 跑测试确认失败** — 期望 FAIL（模块不存在）
- [ ] **Step 3: 实现 types.ts / helpers.ts / index.ts**（签名如上；`SUBSCRIPTION_ADAPTERS` 初始为三个占位：`parseImport`/`refresh` 均抛 `SubscriptionImportError('not implemented')`，Task 3/6/8 逐个替换）
- [ ] **Step 4: 跑测试确认通过** — PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(core): subscription adapter framework with flight cache and jwt helpers"`

### Task 3: Codex 适配器

**Files:**

- Create: `packages/core/src/credentials/adapters/subscription/codex.ts`
- Modify: `packages/core/src/credentials/adapters/subscription/index.ts`（注册）
- Test: `packages/core/src/credentials/__tests__/subscription-codex.test.ts`
- Fixture: 测试内联构造（不建 fixture 文件），auth.json 形状见 spec §5.1

**Interfaces:**

- Consumes: Task 2 全部接口
- Produces: `SUBSCRIPTION_ADAPTERS.codex` 可用；payload 键名固定集合：`{ accessToken, refreshToken, idToken, accountId, email, plan, expiresAt }`（全部命中加密白名单；expiresAt 导入时置空串=未知，首次使用强制刷新）

- [ ] **Step 1: 写失败测试** `subscription-codex.test.ts`
  - parseImport 正常：喂 `{"auth_mode":"chatgpt","tokens":{"id_token":"<构造JWT>","access_token":"AT","refresh_token":"RT","account_id":"acc_1"},"last_refresh":"..."}` → payload.accountId==='acc_1'、payload.refreshToken==='RT'、payload.expiresAt===''、profile.email 来自 JWT claims
  - parseImport 非 JSON / 缺 tokens.refresh_token → 抛 SubscriptionImportError（消息含"codex"）
  - refresh 成功：mock fetch 断言 POST https://auth.openai.com/oauth/token、Content-Type 为 form-urlencoded、body 含 grant_type=refresh_token/client_id=app_EMoamEEZ73f0CkXaXp7hrann/scope=openid profile email；响应 `{access_token,refresh_token,id_token,expires_in:3600}` → 返回 payload.accessToken 更新、expiresAt=now+3600000、refreshToken 轮换
  - refresh 响应 400 且 body 含 `refresh_token_reused` → SubscriptionRefreshError kind='fatal'；`isFatalRefreshError` → true
  - refresh 网络异常 → kind='network'，非 fatal
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 codex.ts** — 常量取 spec §5.1；`accountIdOf` 优先 profile.id，缺省 payload.accountId 切前 32 位；注册进 SUBSCRIPTION_ADAPTERS
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `git commit -m "feat(core): codex subscription adapter (auth.json import + refresh)"`

### Task 4: Codex Provider（Responses 协议翻译）

**Files:**

- Create: `packages/core/src/providers/codex.ts`
- Create: `packages/core/src/providers/codex-catalog.ts`
- Modify: `packages/core/src/providers/index.ts`（导出 CodexProvider）
- Modify: `packages/core/src/registry.ts:49-70`（PROVIDER_CTORS 加 `codex: CodexProvider`）
- Test: `packages/core/src/providers/__tests__/codex.test.ts`

**Interfaces:**

- Consumes: Task 2/3（SUBSCRIPTION_ADAPTERS.codex、REFRESH_SKEW_MS、SubscriptionRefreshError）；`CredentialRuntime`（`providers/cline.ts` 同款用法）；`BaseProvider`/`ProviderContext`
- Produces: `CodexProvider`（`id='codex'`，`hasCredentials()` = `runtime.hasActiveAccounts('codex')`）；catalog 模型列表 `CODEX_CATALOG_MODELS`（条目 `{id, displayName?, contextWindow?}`，初版收录 gpt-5.1-codex-max / gpt-5-codex 等官方 Codex 可用模型，实现时对照参考源码 `internal/runtime/executor/` 出现过的模型名核实）

- [ ] **Step 1: 写失败测试** `codex.test.ts`（结构照抄 `providers/__tests__/cline.test.ts` 的账号池 + mock fetch 模式）
  - listModels：返回 id 均以 `codex:` 前缀、`free===true`、`subscription===true`
  - chat 请求形状：mock fetch 捕获 `https://chatgpt.com/backend-api/codex/responses` 的请求，断言 header `Authorization: Bearer AT`、`chatgpt-account-id: acc_1`，body 顶层 `model`、`stream===true`、`input` 数组首项 role/content 形状、system 消息进 `instructions`
  - chat 非流式聚合：mock SSE 事件序列（`response.created` → `response.output_item.done`（含 output_text）→ `response.completed`（含 usage））→ ChatResponse.content 正确、usage 映射
  - stream 逐块：断言产出 StreamChunk 的 delta 逐段拼接等于全文、最后一块 finish_reason='stop'
  - 401 换 token：首次请求 401 → 断言调用了 adapter.refresh（mock）并原地重试成功
  - refresh_token_reused：mock 刷新返回该错误 → 抛出的错误消息含"失效"且 runtime.reportInvalid 被调用（spy）
  - 429：响应 Retry-After: 30 → 错误 kind='rate_limit' 且 resetAt≈now+30s
  - **token 泄漏防护（Review Focus #5）**：mock 401 响应体含 `token=FAKESECRET123`，断言抛出错误消息不含 `sk-FAKE`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 codex-catalog.ts 与 codex.ts**
  - 账号切换骨架逐字复用 `ClineProvider` 的 `withSwitches` 模式（`providers/cline.ts:333-370`）：`nextAccount('codex', model)` → 失败 `reportRateLimit/reportInvalid` → 最多 3 次切换 → 池耗尽聚合错误
  - 刷新链复用 `getAccessToken` 模式（`cline.ts:419-438`）：flight map 按 account.id 去重，过期判定 `parseExpiryMs(payload.expiresAt) - REFRESH_SKEW_MS`，刷新走 `SUBSCRIPTION_ADAPTERS.codex.refresh`，写回 `runtime.upsertAccount('codex', {...account, payload})`
  - SSE 解析：对照参考 `codex_executor_stream.go` 的事件类型（output_text_delta / response.completed）实现；解析辅助可复用 `openai-like.ts` 的 mapFinishReason
  - ChatRequest→Responses 请求翻译：messages 顺序折叠，system→instructions，contentParts 的 image→input_image 块，tools→Responses function 格式（对照参考 `codex_executor_execute.go` 核实字段名）
- [ ] **Step 4: 跑测试确认通过** + `pnpm --filter @freemodelfinder/core test` 全绿（PROVIDER_CTORS 补齐后恢复 Task 1 的严格类型）
- [ ] **Step 5: 真实验收（用户配合，spec §6）** — 请用户本机执行 `npm i -g @openai/codex && codex login` 生成 `~/.codex/auth.json`，然后启动 `pnpm dev:server`，经后续 Task 5 的 API 导入（本 Task 尚无 UI 时可用 curl POST /api/subscription/import；若 Task 5 未完成，本步与 Task 5 合并验收）。验收命令：`curl -X POST http://127.0.0.1:11435/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"codex:<catalog首个模型>\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"stream\":false}"` → 200 且 content 非空；`"stream":true` → SSE 逐块输出。用户确认通过后勾选本步
- [ ] **Step 6: Commit** — `git commit -m "feat(core): codex subscription provider with responses protocol"`

### Task 5: 订阅账号 Server API + 最小 UI 导入面板

**Files:**

- Create: `packages/server/src/routes/subscription.ts`
- Modify: `packages/server/src/server.ts:2278-2283` 附近（注册路由，模式照抄 cline 端点 server.ts:1193-1284）
- Test: `packages/server/src/routes/__tests__/subscription.test.ts`
- Create: `packages/ui/app/components/SubscriptionAccountsPanel.tsx`
- Modify: `packages/ui/app/components/SettingsView.tsx:2581` 附近（挂载面板，紧邻 ClineAccountsPanel）
- Test: `packages/ui/app/components/__tests__/subscription-panel.test.tsx`

**Interfaces:**

> ⚠️ **本文档是第一波的实施计划历史记录**，其中的路由在**第二波（2026-10-16）已改名**：`/api/subscription/accounts` → `/api/subscription/credentials`（删除/刷新改为查询参数形态）、`POST /api/subscription/import` → `POST /api/subscription/credentials?provider=`。当前实际路由以 `specs/2026-10-14-subscription-accounts-design.md` §4.4 与 `specs/2026-10-16-subscription-oauth-login-design.md` §13.1 为准。

- Consumes: Task 2 `SUBSCRIPTION_ADAPTERS`；`getCredentialRuntime()`；Task 1 的 CredentialPlatform
- Produces（UI 与后续任务逐字使用）:

```
GET  /api/subscription/accounts
  → { accounts: Array<{ provider, id, label, email?, plan?, status, addedAt, expiresAt?, cooldowns: Array<{model,resetAt}>, usage: {requests,promptTokens,completionTokens,lastError?} }> }
POST /api/subscription/import   Body: { provider, raw?: string, path?: string }  // raw 与 path 二选一；path 仅允许以 ~/.codex、~/.claude、~/.gemini 开头（防任意文件读）
  → 200 { ok: true, account: { provider, id, email?, plan? } } | 400 { error }
DELETE /api/subscription/accounts/:provider/:id → { ok: true }
POST /api/subscription/accounts/:provider/:id/refresh → { ok: true, account: {...} } | 4xx { error }
```

- [ ] **Step 1: 写失败测试（server）** `subscription.test.ts`（用 server 包现有测试的 app 构造方式，注入 mock fetch）
  - import via raw：POST codex auth.json 内容 → GET accounts 可见一条 status='active'，且 config.json 原文中该 payload 无明文 `RT_`（Review Focus #4 加密落盘断言，测试用隔离 HOME）
  - import 非法 JSON → 400 且 error 含 provider 名
  - path 白名单：`{path:'C:\\Windows\\win.ini'}` → 400
  - delete → accounts 为空
  - refresh 端点：mock adapter.refresh 成功 → 200；fatal → 4xx 且账号 status 变 invalid
- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @freemodelfinder/server test`
- [ ] **Step 3: 实现 routes/subscription.ts + server.ts 注册** — import 流程：`adapter.parseImport` → `accountIdOf` → `runtime.upsertAccount(platform, {id, status:'active', addedAt:Date.now(), label: email ?? id, payload})`；path 模式先 `readFile` 再走同链路；所有错误经 `redactMessage`（server 现有工具）
- [ ] **Step 4: 跑 server 测试确认通过**
- [ ] **Step 5: 写失败测试（ui）** `subscription-panel.test.tsx`（模式照抄 `cline-panel.test.tsx`：mock fetch + RTL render）
  - 渲染三个 provider 磁贴 + 路径输入 + 粘贴文本框 + 导入按钮
  - 填入路径点导入 → POST /api/subscription/import body 含 provider 与 path
  - 导入成功 → 显示接管提示文案（含"由 FMF 接管"）与 ToS 风险提示（含"风险"）
  - 列表渲染 status 徽标（active/invalid）
- [ ] **Step 6: 跑 ui 测试确认失败→实现→通过** — `pnpm --filter @freemodelfinder/ui test`；面板挂载于 SettingsView 订阅账号分区；路径输入预填该 provider 默认路径（`~/.codex/auth.json` 等）
- [ ] **Step 7: 真实验收（与 Task 4 Step 5 合并执行，用户确认后勾选两处）**
- [ ] **Step 8: Commit** — `git commit -m "feat: subscription account import API and settings panel"`

### Task 6: Claude 适配器

**Files:**

- Create: `packages/core/src/credentials/adapters/subscription/claude.ts`
- Modify: `packages/core/src/credentials/adapters/subscription/index.ts`（注册）
- Test: `packages/core/src/credentials/__tests__/subscription-claude.test.ts`

**Interfaces:**

- Consumes: Task 2 框架
- Produces: `SUBSCRIPTION_ADAPTERS.claude`；payload 键名集合：`{ accessToken, refreshToken, expiresAt, scopes, subscriptionType, email, accountUuid, orgUuid, orgName, blockedUntil }`（全部命中加密白名单）

- [ ] **Step 1: 写失败测试** `subscription-claude.test.ts`
  - parseImport：`{"claudeAiOauth":{"accessToken":"AT","refreshToken":"RT","expiresAt":1755000000000,"scopes":["user:inference"],"subscriptionType":"max"}}` → payload 各字段直取，expiresAt 为毫秒字符串，profile.id='RT 前 8 位派生或 accountUuid 缺省规则'（实现时定：`accountIdOf` = payload.accountUuid ?? `claude-`+refreshToken 前 8 位）
  - parseImport 顶层无 claudeAiOauth → SubscriptionImportError
  - refresh 成功：mock fetch 断言 POST https://platform.claude.com/v1/oauth/token、Content-Type application/json、**body 为 JSON**（client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e、grant_type=refresh_token、scope=user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload）、headers 含 `User-Agent: axios/1.15.2`
  - refresh 响应缺 refresh_token 字段 → 沿用旧 RT（spec §5.2）
  - refresh 429 + header `Retry-After: 12` → kind='rate_limit' 且 payload.blockedUntil=now+12s；**再次 refresh 在 blockedUntil 前直接抛错且不发请求**（fetch 计数断言）
  - refresh 401 → kind='fatal'（isFatalRefreshError=true）
  - refresh 网络异常 → kind='network' 且 isFatalRefreshError=false（Review Focus #2 前半：不可原地重试的分类基础）
  - profile：mock GET https://api.anthropic.com/api/oauth/profile → email/account uuid/org 进 profile
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 claude.ts** — 常量取 spec §5.2；block 冷却用模块内 Map（key=refreshToken 前 8 位哈希，避免长期持有完整 token）；Retry-After-Ms 也要解析；clamp 5s–5min
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `git commit -m "feat(core): claude subscription adapter with refresh block cooldown"`

### Task 7: Claude Provider（Messages 协议）

**Files:**

- Create: `packages/core/src/providers/claude.ts`
- Create: `packages/core/src/providers/claude-catalog.ts`
- Modify: `packages/core/src/providers/index.ts`、`packages/core/src/registry.ts`（PROVIDER_CTORS 加 `claude: ClaudeProvider`）
- Test: `packages/core/src/providers/__tests__/claude.test.ts`

**Interfaces:**

- Consumes: Task 2/6；`providers/openai-messages.ts` 反向可参考（入站翻译已有，出站自写 `toAnthropicMessages`）
- Produces: `ClaudeProvider`（`id='claude'`）；`CLAUDE_CATALOG_MODELS`（sonnet/opus 线，实现时对照参考 `claude` executor 出现的模型名核实）

- [ ] **Step 1: 写失败测试** `claude.test.ts`
  - listModels：`claude:` 前缀、free+subscription 标记
  - chat 请求形状：POST https://api.anthropic.com/v1/messages，header `Authorization: Bearer AT`、`anthropic-version: 2023-06-01`、`anthropic-beta: oauth-2025-04-20`；body：system 消息 → 顶层 `system` 字符串、contentParts image → `image` 块、tools → anthropic 格式（大写 type 差异对照参考核实）、`max_tokens` 必填（req.max_tokens 缺省时用 catalog 默认 8192）
  - 非流式：mock 响应 `content:[{type:'text',text:'pong'}]`、`stop_reason:'end_turn'` → ChatResponse content='pong'、finish_reason='stop'
  - 流式：mock SSE `message_start`(usage) → `content_block_delta`(text_delta) ×2 → `message_delta`(stop_reason+usage) → chunk delta 拼接与 usage 正确、finish_reason 映射
  - 401 一次重试：与 Task 4 同款断言（forceRefresh 后成功）
  - **Review Focus #2 后半**：mock 刷新 fetch 抛 TypeError('fetch failed') → 断言 provider **不**用同一 refreshToken 原地重试第二次刷新（刷新 fetch 计数=1），而是切换账号/抛网络错误
  - token 泄漏防护：同 Task 4 断言
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 claude.ts / claude-catalog.ts** — 骨架同 Task 4（withSwitches + getAccessToken 模式）；差异点：刷新错误为 network 时**跳过原地重试**（调用链把 network 刷新错误直接当作该账号本次失败，交给账号切换）；429 解析 Retry-After；SSE 事件形状对照参考 `claude` executor stream 实现
- [ ] **Step 4: 跑测试确认通过** + 全 core 测试绿
- [ ] **Step 5: 真实验收（用户配合）** — 请用户本机登录 Claude Code（生成 `~/.claude/.credentials.json`，macOS 用户提示凭证在钥匙串、一期需手动导出 JSON 或暂用其他两家），经 /api/subscription/import 导入，curl 双模式验收（命令同 Task 4 Step 5，model 换 `claude:<catalog模型>`）。**注意 R1**：若刷新或 chat 被 Cloudflare 403，记录状态码与响应头，按 spec 降级路径①（补浏览器风格 UA/Accept 头）重试一次，仍失败则本步以"R1 降级评估中"标注收尾，不阻塞后续任务，并向用户报告
- [ ] **Step 6: Commit** — `git commit -m "feat(core): claude subscription provider with messages protocol"`

### Task 8: Google 适配器

**Files:**

- Create: `packages/core/src/credentials/adapters/subscription/google.ts`
- Modify: `packages/core/src/credentials/adapters/subscription/index.ts`（注册）
- Test: `packages/core/src/credentials/__tests__/subscription-google.test.ts`

**Interfaces:**

- Consumes: Task 2 框架
- Produces: `SUBSCRIPTION_ADAPTERS.google`；payload 键名：`{ accessToken, refreshToken, clientId, clientSecret, expiryDate, scope, idToken }`（clientSecret 命中加密白名单）

- [ ] **Step 1: 写失败测试** `subscription-google.test.ts`
  - parseImport 正常：`{"access_token":"AT","refresh_token":"RT","client_id":"CID","client_secret":"CS","expiry_date":1755000000000,"scope":"...","id_token":"..."}` → payload 映射（驼峰化），expiresAt=expiry_date 字符串
  - parseImport 缺 refresh_token → SubscriptionImportError；**缺 client_secret → SubscriptionImportError 且消息含"client_secret"**（spec §5.3 决策：缺失即报错，不猜内置 secret）
  - refresh 成功：mock fetch 断言 POST https://oauth2.googleapis.com/token、form body 含 client_id/client_secret/refresh_token/grant_type=refresh_token；响应 access_token/expires_in → payload 更新
  - refresh 400 + body 含 invalid_grant → kind='fatal'
  - profile 无独立端点：`refresh` 返回值不带 profile 更新（google 的 describe 用 payload 里的信息即可），accountIdOf = payload.refreshToken 前 8 位派生（稳定）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 google.ts** — 常量取 spec §5.3（仅 token 端点与 Google 标准；**不内置** Antigravity client_id/secret）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `git commit -m "feat(core): google subscription adapter (oauth_creds.json)"`

### Task 9: Google Provider（cloudcode-pa v1internal）

**Files:**

- Create: `packages/core/src/providers/google.ts`
- Create: `packages/core/src/providers/google-catalog.ts`
- Modify: `packages/core/src/providers/index.ts`、`packages/core/src/registry.ts`（PROVIDER_CTORS 加 `google: GoogleProvider`）
- Modify: `packages/core/src/registry.ts:49-52`（**恢复 Task 1 放宽的严格 Record 类型**）
- Test: `packages/core/src/providers/__tests__/google.test.ts`

**Interfaces:**

- Consumes: Task 2/8
- Produces: `GoogleProvider`（`id='google'`）；`GOOGLE_CATALOG_MODELS`（gemini-2.5-pro/flash、gemini-3-pro 等；实现时对照参考 antigravity executor 的 loadCodeAssist 返回的模型清单字段核实命名）

- [ ] **Step 1: 写失败测试** `google.test.ts`
  - listModels：`google:` 前缀、free+subscription
  - 会话初始化：首次 chat 前调用 `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`（header Bearer AT），其响应中的 staleness/项目字段进后续请求（对照参考 `antigravity_executor.go` 的初始化时序；测试断言初始化只发生一次并被缓存）
  - chat 请求形状：`POST https://cloudcode-pa.googleapis.com/v1internal/projects/-/locations/global/reasoningEngines/<project>/models/<model>:streamGenerateContent?alt=sse`（**精确路径以参考 antigravity_executor_buildrequest_test.go 与实现源码为准，实现时核实并同步修正本测试**）；body 为 generateContent 变体（contents/role user|model）
  - 流式：mock Gemini SSE（`data: {...candidates:[{content:{parts:[{text}]}}]}`）→ StreamChunk delta 正确；usageMetadata → usage 映射
  - 401 → forceRefresh 重试一次；invalid_grant 刷新错误 → reportInvalid
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 google.ts / google-catalog.ts** — 骨架同 Task 4；请求构造与模型清单对照参考源码 `internal/runtime/executor/antigravity_executor*.go` 移植
- [ ] **Step 4: 跑测试确认通过** + 恢复严格 PROVIDER_CTORS 类型 + `pnpm build:runtime && pnpm typecheck` 全绿
- [ ] **Step 5: 真实验收（用户配合）** — 请用户本机登录 Gemini CLI（生成 `~/.gemini/oauth_creds.json`）→ 导入 → curl 双模式验收（`google:<模型>`）。无文件或缺 client_secret 时按 Task 8 的报错路径展示给用户，验收跳过并记录
- [ ] **Step 6: Commit** — `git commit -m "feat(core): google subscription provider via cloudcode-pa"`

### Task 10: 路由与 auto 兜底集成

**Files:**

- Modify: `packages/core/src/registry.ts:709-722`（catalog 命中分支）、`:728-780`（buildFallbackChain 排序）
- Modify: `packages/server/src/routes/openai.ts`（/v1/models 响应透出 subscription 标记；找到 models 响应项构造处，加 `subscription: m.subscription === true`）
- Modify: `scripts/audit-free-models.mjs`（订阅 provider 排除）
- Test: `packages/core/src/registry/__tests__/registry.test.ts`（追加用例）

**Interfaces:**

- Consumes: Task 1 `ModelInfo.subscription`；Task 4/7/9 注册的三个 provider
- Produces: 兜底行为契约——auto 链中 subscription 模型恒在非订阅模型之后；裸名/目录命中优先非订阅 provider；`/v1/models` 项含 `subscription` 布尔

- [ ] **Step 1: 写失败测试**（追加到 registry.test.ts，沿用其现有 configWithProviders/mock 模式）
  - `auto 兜底排序`：构造目录含免费模型 A（score 高）与订阅模型 B（score 更高），`buildFallbackChain` 结果中 B 位于 A 之后（订阅分段恒排尾）
  - `全免费冷却时订阅兜底`：A 冷却（mock autoRouter.isRateLimited），B 可用 → 链含 B（兜底生效，不被过滤掉）
  - `目录命中偏好免费 provider`：同一裸名同时命中免费 catalog 与订阅 catalog → 解析到免费 provider
  - `显式前缀不受限`：`codex:<model>` 直连订阅 provider（现有前缀逻辑回归断言）
  - `/v1/models` 透出：server 测试（routes/**tests**/openai 相关文件）断言订阅模型项 `subscription===true`、免费项无该字段
  - audit 脚本：`node --test scripts` 不适用——改为对 `scripts/audit-free-models.mjs` 导出的 provider 过滤函数做单测，或以 dry-run 方式断言输出 providers 不含 codex/claude/google（实现时选可行者；scripts 无测试基建则以手工运行 `pnpm audit:daily` 观察报告无三家为准，标注在步骤里）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
  - buildFallbackChain：在 scored sort 后按 `m.subscription === true` 做稳定分区（免费在前、订阅在后）；分区内保持原打分排序
  - catalog 命中分支：`catalog.find` 改为先取全部命中再 `find(m => !m.subscription) ?? find(...)`（免费优先）
  - /v1/models 响应项加 subscription 透出
  - audit 脚本：provider 过滤处排除 `'codex','claude','google'`（常量 `SUBSCRIPTION_PROVIDERS`，注释说明订阅额度非免费 key，不进审计）
- [ ] **Step 4: 跑测试确认通过** — `pnpm --filter @freemodelfinder/core test` + `pnpm --filter @freemodelfinder/server test`
- [ ] **Step 5: Commit** — `git commit -m "feat: subscription models rank last in auto route as fallback"`

### Task 11: UI 完整化

**Files:**

- Modify: `packages/ui/app/components/SubscriptionAccountsPanel.tsx`（Task 5 创建）
- Test: `packages/ui/app/components/__tests__/subscription-panel.test.tsx`（追加）

**Interfaces:**

- Consumes: Task 5 的 API 形状
- Produces: 完整面板——账号卡列表（email/plan/状态徽标 active·invalid·cooldown/过期时间/用量 requests+tokens）、移除按钮（确认弹窗，照抄 ClineAccountsPanel 模式）、手动刷新按钮（调 refresh 端点，成功后更新卡片）、冷却清除（复用 cline 的 cooldowns/clear 模式可后补，非本期必须）

- [ ] **Step 1: 写失败测试**（追加）
  - GET accounts 返回 invalid 账号 → 渲染"失效"徽标与"重新导入"提示
  - 移除按钮 → confirm 后 DELETE 请求发出且列表刷新
  - 手动刷新 → POST refresh，成功 toast；失败渲染错误消息（断言不含 token 明文）
  - 用量渲染：requests/promptTokens 数字正确
- [ ] **Step 2: 跑测试确认失败→实现→通过** — `pnpm --filter @freemodelfinder/ui test`；移动端布局照抄 ClineAccountsPanel 响应式类名
- [ ] **Step 3: Commit** — `git commit -m "feat(ui): subscription account management panel complete"`

### Task 12: 文档与全量 CI 验证

**Files:**

- Modify: `README.md`（或 `FREE_MODELS.md` 头部说明区，二选一放订阅账号章节）
- Modify: `docs/superpowers/specs/2026-10-14-subscription-accounts-design.md`（状态改为已交付，记录偏差）
- Test: 无新代码；全量 CI 命令验收

- [ ] **Step 1: 写文档** — README 新增"订阅账号接入"小节：支持的三家、导入方式（CLI 登录 → 设置页导入）、接管提示与 token 轮换警告、ToS 灰色地带风险提示一句、模型 ID 形式（`codex:`/`claude:`/`google:`）与 auto 兜底行为一句话
- [ ] **Step 2: 全量 CI 按序执行并全绿**
  - `pnpm format:check`（不过则 `pnpm format` 后重查）
  - `pnpm lint`
  - `pnpm build:runtime`
  - `pnpm typecheck`
  - `pnpm test:coverage`（确认 core 覆盖率仍达标：85% lines / 74% branches——新增 provider 大文件需有足够测试；不达标则补测试，禁止改阈值）
  - `pnpm build`
  - `pnpm test:pack`
- [ ] **Step 3: 三家真实账号终验汇总** — 汇总 Task 4/7/9 的真实验收结果写入 spec 状态段（通过/降级/R1 评估中），若有降级项列出触发条件与用户可见影响
- [ ] **Step 4: Commit + 提醒推送** — `git commit -m "docs: subscription account integration guide"`；完成后提醒用户可推送 GitHub，**经用户同意后**方可 push

---

## 计划自查记录（writing-plans self-review）

- **Spec 覆盖**：spec §4.1 命名→Task 1/4/7/9；§4.2 框架→Task 2/3/6/8；§4.3 协议翻译→Task 4/7/9；§4.4 server+UI→Task 5/11；§4.5 路由→Task 1/10；§6 切片与真实验收→各 provider Task 的验收步骤；§7 风险 R1→Task 7 验收步骤的降级判定、R2→Task 5 UI 接管提示、R4→Task 5/11 ToS 提示、R5→catalog 静态清单+现有 modelAliases 兜底（文档已述）。无遗漏。
- **类型一致性**：SubscriptionAdapter/RefreshResult/payload 键名在 Task 2 定义、3/6/8 引用一致；`hasActiveAccounts/getPool/upsertAccount` 等 runtime 方法名与 `credentials/runtime.ts:12-48` 逐一核对；`REFRESH_SKEW_MS` 名称与 cline.ts 现有常量无冲突（不同模块）。
- **比例**：计划以接口签名、测试名与断言为主，仅对"协议事件→内部结构"这类不可推导的映射给出参照源码路径，未贴实现体。
- **开放点（留给实现者，已在任务内标注）**：cloudcode-pa 精确路径（Task 9 Step 1 注明以参考测试文件核实）、catalog 具体模型条目（对照参考执行器核实）、audit 脚本测试方式（无基建时降级为手工验证）。
