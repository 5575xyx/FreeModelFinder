# 订阅账号 OAuth 交互登录 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Codex / Claude / Google 三家订阅账号加上 OAuth 浏览器交互登录，并把 UI 从「共用一个粘贴框」改成「每家各自独立弹窗（OAuth + 导入文件）」，路由与流程对齐参考项目 CLIProxyAPI v8。

**Architecture:** 在 core 新增与 provider 无关的 OAuth 层（state / PKCE / 会话存储 / loopback 回调监听器），三家适配器各实现 `buildAuthUrl` 与 `exchangeCode`；server 侧把既有 `accounts/import` 路由改名为参考项目形状的 `credentials/*`，并新增 `oauth/auth-url|status|session|callback`；UI 侧用「provider 磁贴 → 独立弹窗」替换现有面板。

**Tech Stack:** TypeScript, Node 22 (`node:test` + tsx), Fastify 5, Next.js 16, Vitest + RTL + msw, pnpm monorepo (tsup)。

**Spec:** `docs/superpowers/specs/2026-10-16-subscription-oauth-login-design.md`（本计划逐条实现它；协议常量细节见 `docs/superpowers/specs/2026-10-14-subscription-accounts-design.md` §5）

## Global Constraints

- Node.js >= 22.14.0；`pnpm install --frozen-lockfile`（CI/脚本里绝不裸 `pnpm install`）。
- TS 严格模式，`noUncheckedIndexedAccess: true`（索引访问要判空）。
- 代码注释用中文，与既有文件一致；prettier 行宽等由仓库配置决定（`pnpm format:check` 是 CI 闸门）。
- ESLint `@typescript-eslint/no-explicit-any` 已关闭；max warnings = 0。
- 门禁顺序固定，且**必须串行**：`format:check` → `lint` → `build:runtime` → `typecheck` → `test:coverage` → `build`。
  - **绝不可**与 `pnpm test:coverage` 并发再跑 `pnpm build:runtime`（`tsup.config.ts` 有 `clean: true`，会清空 `packages/core/dist` 导致 server 测试随机失败）。
- 覆盖率阈值：core 85% lines / 74% branches，server 80% / 75%，cli 80% lines，ui 70% lines。
- `/api/**` 一律受 `server.ts` 的 preHandler 闸门保护：需要 `x-fmf-client: ui` + 受信 Origin（`localhost` / `127.0.0.1` / `[::1]` / `tauri.localhost`）。新端点必须落在此前缀下。
- 令牌只经 `updateConfig()` → `saveConfig()`（加密落盘）持久化；账号增删只经 `getCredentialRuntime()`。
- provider 标识：内部 `'codex' | 'claude' | 'google'`；`oauth` 的 `provider` 查询参数额外接受 `antigravity` 作为 `google` 的别名。
- 固定 loopback 端口：Codex `1455`、Claude `54545`（官方 OAuth 应用已注册，**不得更改**）；Google 用 OS 分配端口。
- UI 文案中英双语必须同时补齐（`packages/ui/app/i18n.tsx` 的 `zh` 与 `en`）。
- **不得**擅自 `git push`；每个任务末尾只做本地 `git commit`。

## Review Focus

以下五类输入/失败模式是 spec 隐含但任何单测都不会自动覆盖的，最可能让真实用户踩坑；每条都在下方归属任务的测试里被钉住：

1. **固定端口已被占用**（用户同时开着官方 CLI）→ 应给出可读错误并指向占用者，而不是静默挂起或崩掉。归属：Task 2 / Task 7。
2. **用户点了「打开浏览器登录」但从未完成授权**（关掉标签页就走了）→ 会话必须超时收敛为 `error`，且**不得**留下悬挂的监听器占用 1455/54545 端口。归属：Task 1 / Task 2 / Task 7。
3. **重复点击「打开浏览器登录」**（同一家 provider 并发两个会话）→ 第二个请求必须被明确拒绝（409），不得出现两个监听器抢同一端口。归属：Task 7。
4. **回调到达时 state 不匹配或被篡改** → 必须拒绝并且**不落账号**；同时 `GET|POST /oauth/callback` 是未鉴权可达的浏览器目标，不得因此泄漏会话内容。归属：Task 7。
5. **取消后回调才到达**（用户先点取消，浏览器随后才跳回）→ 必须不落账号（对照参考项目 `CancelAuthSession` 的注释语义）。归属：Task 7。

---

### Task 1: OAuth 核心原语（state / PKCE / 会话存储）

**Files:**

- Create: `packages/core/src/credentials/oauth/types.ts`
- Create: `packages/core/src/credentials/oauth/state.ts`
- Create: `packages/core/src/credentials/oauth/pkce.ts`
- Create: `packages/core/src/credentials/oauth/session.ts`
- Test: `packages/core/src/credentials/oauth/__tests__/session.test.ts`
- Modify: `packages/core/src/index.ts`（追加导出，参照现有第 25–29、46–56 行的导出块风格）

**Interfaces:**

- Consumes: 无（纯新增）
- Produces:

  ```ts
  // types.ts
  export type SubscriptionProviderId = 'codex' | 'claude' | 'google';
  export type OAuthSessionStatus = 'wait' | 'ok' | 'error';
  export interface OAuthSessionSnapshot {
    provider: SubscriptionProviderId;
    status: OAuthSessionStatus;
    error?: string;
    redirectUri: string;
    createdAt: number;
  }
  export interface OAuthSessionRecord extends OAuthSessionSnapshot {
    verifier?: string;
  }
  // state.ts
  export function generateState(): string; // base64url，43 字符
  export function isValidState(state: string): boolean; // 仅接受 generateState 的形状
  // pkce.ts
  export function generatePkce(): { verifier: string; challenge: string }; // S256
  // session.ts
  export const OAUTH_SESSION_TTL_MS = 10 * 60_000;
  export interface OAuthSessionStore {
    begin(provider: SubscriptionProviderId, redirectUri: string, verifier?: string): string; // 返回 state；同 provider 已有 pending 时抛 OAuthSessionBusyError
    get(state: string): OAuthSessionRecord | undefined;
    isPending(state: string): boolean;
    complete(state: string): void;
    fail(state: string, error: string): void;
    cancel(state: string): boolean;
    sweep(now?: number): void; // 清理过期会话；过期者置 error:'timeout'
  }
  export function createOAuthSessionStore(): OAuthSessionStore;
  export class OAuthSessionBusyError extends Error {}
  ```

- [ ] **Step 1: 写失败测试** `packages/core/src/credentials/oauth/__tests__/session.test.ts`

用 `node:test` + `assert/strict`（与 `packages/core/src/credentials/__tests__/` 现有风格一致）。断言：

```
'generateState returns a 43-char base64url string'        → /^[A-Za-z0-9_-]{43}$/
'generateState returns a different value each call'
'isValidState rejects empty / short / non-base64url input'
'generatePkce verifier is 43-128 chars and challenge is S256 of verifier'
'begin returns a state that is immediately pending (status wait)'
'begin throws OAuthSessionBusyError when the same provider already has a pending session'
'complete moves the session to ok'
'fail moves the session to error with the given message'
'cancel returns true and removes the session; a second cancel returns false'
'get returns undefined for an unknown state'
'sweep marks a session older than OAUTH_SESSION_TTL_MS as error timeout'
```

第 4 条的断言必须**真正验算**（不是形状检查）：用 node `crypto` 自己算
`base64url(sha256(verifier))` 并与 `challenge` 比对。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL（`Cannot find module '.../oauth/session.js'`）

- [ ] **Step 3: 实现** 四个文件

`verifier`：`base64url(randomBytes(32))`（43 字符）。`challenge`：`base64url(sha256(verifier))`，用 `node:crypto` 的 `createHash`。state 同 verifier 的生成方式。
会话存储用 `Map<string, OAuthSessionRecord>`；`begin` 先扫一遍同 provider 的 pending，命中即抛 `OAuthSessionBusyError`。
`sweep` 由调用方驱动（不在模块内起定时器，避免测试期悬挂句柄）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/credentials/oauth packages/core/src/index.ts
git commit -m "feat(core): add provider-agnostic OAuth state/PKCE/session primitives"
```

---

### Task 2: 本机 loopback 回调监听器

**Files:**

- Create: `packages/core/src/credentials/oauth/loopback.ts`
- Test: `packages/core/src/credentials/oauth/__tests__/loopback.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: Task 1 的 `isValidState`
- Produces:

  ```ts
  export interface LoopbackListenerOptions {
    /** 0 = 由 OS 分配端口 */
    port: number;
    /** 例如 '/auth/callback' */
    path: string;
    timeoutMs?: number; // 默认 OAUTH_SESSION_TTL_MS
  }
  export interface LoopbackCallback {
    redirectUri: string; // 'http://127.0.0.1:<port><path>'
    waitForCode(): Promise<{ code: string; state: string }>;
    close(): void;
  }
  export function startLoopbackListener(opts: LoopbackListenerOptions): Promise<LoopbackCallback>;
  export class LoopbackPortBusyError extends Error {} // message 里带端口号
  ```

- [ ] **Step 1: 写失败测试** `__tests__/loopback.test.ts`

```
'port 0 yields an OS-assigned redirect uri of the given path'
'a GET to the callback path resolves waitForCode with code and state'
'a GET to another path returns 404 and does not resolve the promise'
'a callback missing code or state returns 400 and does not resolve'
'close() before any callback makes waitForCode reject'
'timeout makes waitForCode reject and releases the port'
'binding an already-used fixed port rejects with LoopbackPortBusyError'
```

第 7 条：先 `startLoopbackListener({port: 0, ...})` 拿到实际端口，再用**同一端口**调一次，期望 reject。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

用 `node:http` 的 `createServer`；`listen(port, '127.0.0.1')`；`listen` 的 `error` 事件里 `EADDRINUSE` → reject `LoopbackPortBusyError`。
回调响应用一段极简内联 HTML（“授权完成，可以关闭此页”），并 `res.end()`；随后 `close()` 服务器。
`waitForCode` 只兑现一次；`close()` / 超时 / 进程退出后未兑现的 promise 改为 reject（`cancel()` 语义）。
必须 `unref()` 或保证 `close()` 被调用，避免测试进程悬挂。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/credentials/oauth
git commit -m "feat(core): add loopback OAuth callback listener"
```

---

### Task 3: 适配器 OAuth（一）—— 接口扩展、回调描述表、Codex

**Files:**

- Modify: `packages/core/src/credentials/adapters/subscription/types.ts`
- Create: `packages/core/src/credentials/adapters/subscription/oauth-config.ts`
- Modify: `packages/core/src/credentials/adapters/subscription/codex.ts`
- Modify: `packages/core/src/credentials/adapters/subscription/index.ts`
- Test: `packages/core/src/credentials/adapters/subscription/__tests__/oauth-codex.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `SubscriptionProviderId`
- Produces:

  ```ts
  // types.ts —— SubscriptionAdapter 新增两个成员
  export interface SubscriptionAdapter {
    readonly platform: 'codex' | 'claude' | 'google';
    parseImport(raw: string): ParsedSubscription;
    refresh(opts: {
      fetchImpl?: typeof fetch;
      refreshToken: string;
      payload: Record<string, string>;
    }): Promise<RefreshResult>;
    isFatalRefreshError(error: unknown): boolean;
    accountIdOf(profile: SubscriptionAccountProfile, payload: Record<string, string>): string;
    /** 生成授权 URL；usesPkce 为 true 的 provider 必须传 verifier */
    buildAuthUrl(opts: { state: string; redirectUri: string; verifier?: string }): string;
    /** 用授权码换令牌；返回值形状与 parseImport 一致 */
    exchangeCode(opts: {
      code: string;
      redirectUri: string;
      verifier?: string;
      fetchImpl?: typeof fetch;
    }): Promise<ParsedSubscription>;
  }

  // oauth-config.ts
  export interface SubscriptionOAuthConfig {
    callbackPort: number; // 0 = OS 分配
    callbackPath: string;
    usesPkce: boolean;
  }
  export const SUBSCRIPTION_OAUTH: Record<SubscriptionProviderId, SubscriptionOAuthConfig>;
  export function normalizeSubscriptionProvider(value: string): SubscriptionProviderId | null;
  // normalizeSubscriptionProvider('antigravity') === 'google'
  ```

- [ ] **Step 1: 写失败测试** `__tests__/oauth-codex.test.ts`

```
'SUBSCRIPTION_OAUTH pins the official callback ports and paths'
  → codex {1455,'/auth/callback',true}; claude {54545,'/callback',true}; google {0,'/oauth-callback',false}
'normalizeSubscriptionProvider accepts antigravity as google'
'normalizeSubscriptionProvider rejects unknown values'
'codex buildAuthUrl targets auth.openai.com and carries PKCE S256 + required params'
  → 解析 URL，断言：
    origin+path === 'https://auth.openai.com/oauth/authorize'
    searchParams.client_id === 'app_EMoamEEZ73f0CkXaXp7hrann'
    scope === 'openid email profile offline_access'  ← 注意：交互登录用 offline_access（见 spec §5.1）
    redirect_uri === 'http://127.0.0.1:1455/auth/callback'
    state === 传入值，response_type === 'code'
    code_challenge_method === 'S256' 且 code_challenge 非空
'codex exchangeCode posts form-urlencoded to the token endpoint and maps the response'
  → 注入 fetchImpl 假实现，断言：method POST、content-type 含 application/x-www-form-urlencoded、
    body 含 code/redirect_uri/code_verifier/client_id/grant_type=authorization_code；
    返回 payload 含 accessToken/refreshToken/idToken，profile.email 取自 id_token 的 email 声明
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL（`adapter.buildAuthUrl is not a function`）

- [ ] **Step 3: 实现**

`oauth-config.ts` 只放常量与归一化函数（纯数据，无 IO）。
Codex 的 `buildAuthUrl` 用 `new URL('https://auth.openai.com/oauth/authorize')` 拼参数；
`exchangeCode` 复用文件内已有的 form-urlencoded 风格与 `decodeJwtPayload`（`helpers.ts`）解析 id_token 取 email/plan。
**不要**在 `exchangeCode` 里改动既有 `refresh`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS（既有 codex 测试同时保持绿）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/credentials/adapters/subscription
git commit -m "feat(core): add OAuth auth-url/exchange for Codex adapter"
```

---

### Task 4: 适配器 OAuth（二）—— Claude

**Files:**

- Modify: `packages/core/src/credentials/adapters/subscription/claude.ts`
- Test: `packages/core/src/credentials/adapters/subscription/__tests__/oauth-claude.test.ts`

**Interfaces:**

- Consumes: Task 3 的 `SubscriptionAdapter` 扩展形状
- Produces: `claudeAdapter.buildAuthUrl` / `claudeAdapter.exchangeCode`（签名同 Task 3）

- [ ] **Step 1: 写失败测试** `__tests__/oauth-claude.test.ts`

```
'claude buildAuthUrl targets claude.ai with PKCE and the full scope set'
  → 'https://claude.ai/oauth/authorize'
    client_id === '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
    scope === 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
    redirect_uri === 'http://127.0.0.1:54545/callback'
    code_challenge_method === 'S256'
'claude exchangeCode posts a JSON body with the axios-style User-Agent'
  → content-type 含 application/json；headers['user-agent'] === 'axios/1.15.2'；
    body.code === code 且 body.code_verifier === verifier；body.grant_type === 'authorization_code'
'claude exchangeCode strips a trailing "#state" from the returned code before exchange'
  → 传入 code 'abc#xyz'，断言发给上游的 body.code === 'abc'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL

- [ ] **Step 3: 实现**

复用文件内已有的 `AXIOS_UA` / `ACCEPT` / JSON-body 写法。
`exchangeCode` 入口先做 `code.split('#')[0]` 截断（参考项目 `auth_files_provider_oauth.go:142-143`）。
可选补取 profile：若 token 响应未带 email，则 `GET PROFILE_URL`（Bearer），失败仅告警、不抛。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/credentials/adapters/subscription
git commit -m "feat(core): add OAuth auth-url/exchange for Claude adapter"
```

---

### Task 5: 适配器 OAuth（三）—— Google（无 PKCE + userinfo）

**Files:**

- Modify: `packages/core/src/credentials/adapters/subscription/google.ts`
- Test: `packages/core/src/credentials/adapters/subscription/__tests__/oauth-google.test.ts`

**Interfaces:**

- Consumes: Task 3 的 `SubscriptionAdapter` 扩展形状
- Produces: `googleAdapter.buildAuthUrl` / `googleAdapter.exchangeCode`

- [ ] **Step 1: 写失败测试** `__tests__/oauth-google.test.ts`

```
'google buildAuthUrl targets accounts.google.com and carries NO PKCE parameters'
  → 'https://accounts.google.com/o/oauth2/v2/auth'
    含 client_id / redirect_uri / response_type=code / scope / access_type=offline / prompt=consent
    断言 searchParams.has('code_challenge') === false 且 has('code_challenge_method') === false
'google buildAuthUrl uses the caller-supplied redirect uri verbatim'
  → 传入 'http://127.0.0.1:53123/oauth-callback' 时 searchParams.redirect_uri 完全等于它
'google exchangeCode posts form-urlencoded and derives the profile'
  → 断言 body 含 code/redirect_uri/client_id/client_secret/grant_type；
    返回 payload 含 accessToken/refreshToken/expiresAt
'google exchangeCode fetches the userinfo email and sets profile.email'
  → 断言额外请求 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json'，且 profile.email 为返回值
'google exchangeCode still succeeds when userinfo fails (email stays undefined)'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL

- [ ] **Step 3: 实现**

`buildAuthUrl` 用内置 client_id（spec §5.3 记录的 Antigravity 专用 client_id），`client_secret` 不参与 authorize。
`exchangeCode` 的 `client_secret` 来源：OAuth 交互登录场景取内置值（与 `parseImport` 的“文件内 secret”路径互不影响）。
`project_id` 的拉取**不在本任务**（属 AI 通道初始化，本期不改）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/credentials/adapters/subscription
git commit -m "feat(core): add OAuth auth-url/exchange for Google adapter"
```

---

### Task 6: server 路由改名到参考项目形状（`credentials/*`）

**Files:**

- Modify: `packages/server/src/routes/subscription.ts`
- Modify: `packages/server/src/routes/__tests__/subscription.test.ts`（改路径 + 断言）
- Modify: `packages/ui/test/server.ts`（`/api/subscription/accounts` 的默认 handler）

**Interfaces:**

- Consumes: 既有 `resolveImportPath`、`registerSubscriptionRoutes(app, getRegistry)`
- Produces（旧路径全部移除）:

  ```
  GET    /api/subscription/import-hints                （不变）
  GET    /api/subscription/credentials                 → { accounts: [...] }   ← 原 /accounts
  POST   /api/subscription/credentials?provider=       → { ok, account }        ← 原 /import，body {raw} | {path}
  DELETE /api/subscription/credentials?provider=&id=   → { ok }                 ← 原 /accounts/:p/:id
  POST   /api/subscription/credentials/refresh         → { ok, account }        ← 原 /accounts/:p/:id/refresh
                                                         body { provider, id } | { all: true }
  ```

  未带 `provider` 时，`POST /credentials` 依次尝试三家 `parseImport`，第一个成功者即所用 provider；全失败 → 400。

- [ ] **Step 1: 改测试为失败状态** `subscription.test.ts`

把 `listAccounts` 的 URL 改为 `/api/subscription/credentials`；删除/改写的用例：

- `'deletes an account'` → `DELETE /api/subscription/credentials?provider=codex&id=<id>`
- `'404s a delete of an unknown account'` → 同上
- `'refreshes an account ...'` → `POST /api/subscription/credentials/refresh` + `payload: { provider, id }`
- `'collapses concurrent refreshes ...'` / fatal / 502 / 404 同上改法
  新增：

```
'imports without a provider by sniffing the credential shape'
'lists every account under /credentials'
'refreshes every account with {all:true}'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: FAIL（404 on `/api/subscription/credentials`）

- [ ] **Step 3: 实现改名 + 内容嗅探**

保留全部既有业务逻辑（启用 provider → `updateConfig` → `getRegistry().updateConfig(next)` → `upsertAccount`）**逐字不动**，只换路由与参数来源。
增加一个私有 `detectProvider(raw: string): SubscriptionProviderId | null`：按 `codex → claude → google` 顺序 `try { adapter.parseImport(raw) } catch { continue }`。
`DELETE` 的 `id` 从 `req.query` 取（Fastify 查询参数是字符串，注意 `noUncheckedIndexedAccess`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: PASS（16 条改后用例全绿）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/subscription.ts packages/server/src/routes/__tests__/subscription.test.ts packages/ui/test/server.ts
git commit -m "refactor(server): rename subscription account routes to reference-shaped credentials API"
```

---

### Task 7: server OAuth 端点（auth-url / status / session / callback）

**Files:**

- Create: `packages/server/src/routes/subscription-oauth.ts`
- Modify: `packages/server/src/routes/subscription.ts`（`registerSubscriptionRoutes` 内调用新注册函数）
- Test: `packages/server/src/routes/__tests__/subscription-oauth.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `createOAuthSessionStore` / `generatePkce` / `isValidState`；Task 2 的 `startLoopbackListener`；Task 3 的 `SUBSCRIPTION_OAUTH` / `normalizeSubscriptionProvider`；Task 6 的 provider 解析；既有 `getCredentialRuntime()` / `updateConfig` / `getRegistry()` / `SUBSCRIPTION_ADAPTERS`
- Produces:

  ```ts
  export function registerSubscriptionOAuthRoutes(
    app: FastifyInstance,
    getRegistry: () => ProviderRegistry,
  ): void;
  ```

  路由与响应（严格照 spec §3.1/§3.2）：

  ```
  GET    /api/subscription/oauth/auth-url?provider=    → 200 {status:'ok', url, state}
                                                         400 {status:'error', error:'provider is required'}
                                                         400 {status:'error', error:'provider_not_found'}
                                                         409 {status:'error', error:'session already pending'}
                                                         500 {status:'error', error:'<端口占用等>'}
  GET    /api/subscription/oauth/status?state=         → 200 {status:'ok'} | {status:'wait'}
                                                         200 {status:'error', error}
                                                         400 {status:'error', error:'invalid state'}
  DELETE /api/subscription/oauth/session?state=        → 200 {status:'ok', cancelled:<bool>}
                                                         400 {status:'error', error:'missing state'} | 'invalid state'
  GET|POST /api/subscription/oauth/callback?code=&state= → 200 一段 HTML
  POST   /api/subscription/oauth/import?provider=      → 与 POST /credentials 同处理器（参考项目也有此路由，spec §3.1）
  ```

- [ ] **Step 1: 写失败测试** `subscription-oauth.test.ts`

沿用 Task 6 的脚手架（`createServer({registry, watchIntervalMs})` + `localUiHeaders` + `app.inject`）。**不得**真的打开浏览器或连上游：`SUBSCRIPTION_ADAPTERS.<p>.exchangeCode` 用替换法 stub（参照既有 `originalCodexRefresh` 模式），并在 `afterEach` 还原。

```
'auth-url returns a url and state and marks the session waiting'
'auth-url accepts antigravity as an alias for google'
'auth-url rejects an unknown provider with provider_not_found'
'auth-url rejects a second concurrent session for the same provider with 409'
'status returns wait while pending'
'status returns invalid state for a malformed state'
'status returns unknown or expired state for an unseen state'
'status returns ok once the loopback callback carried a matching state'
  → 从 auth-url 取 state；按 provider 的实际端口（google 用返回 url 里的端口）
    发一个真实的 GET http://127.0.0.1:<port><path>?code=X&state=<state>
    然后轮询 status 直到 ok；断言账号已落库（getCredentialRuntime().getPool 里出现该 id）
'status returns error when exchangeCode rejects'
'status returns error when the callback carries a mismatched state, and saves nothing'
'cancel returns cancelled:true and a later callback saves nothing'
'cancel without state returns 400'
'auth-url surfaces a readable error when the fixed port is already taken'
  → 先占住 1455（Task 2 的监听器），再请求 codex 的 auth-url，断言 500 且 error 文本含 '1455'
'oauth/import behaves exactly like credentials import'
  → 同一份 body 打两个端点，断言落库结果一致
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: FAIL（404 on `/api/subscription/oauth/auth-url`）

- [ ] **Step 3: 实现**

单例会话存储 + 每会话一个 `LoopbackCallback`。流程：

1. `provider = normalizeSubscriptionProvider(req.query.provider)`；空 → 400，未知 → 400 `provider_not_found`
2. `cfg = SUBSCRIPTION_OAUTH[provider]`；`listener = await startLoopbackListener({port: cfg.callbackPort, path: cfg.callbackPath})`（`EADDRINUSE` → 关闭已建资源后 500，error 文案含端口号）
3. `verifier = cfg.usesPkce ? generatePkce().verifier : undefined`
4. `state = store.begin(provider, listener.redirectUri, verifier)`（`OAuthSessionBusyError` → 关闭 listener 并 409）
5. `url = adapter.buildAuthUrl({state, redirectUri, verifier})`
6. 后台 `void listener.waitForCode().then(...)` 完成换 token → `upsertAccount` → `store.complete`；reject → `store.fail`（若会话已非 pending 则**不落账号**）
7. 返回 `{status:'ok', url, state}`

落账号必须与 Task 6 的导入走同一条路径（同样要 `updateConfig` 启用 provider + `getRegistry().updateConfig(next)`）。

`/oauth/callback` 端点：只把 `code`+`state` 交给当前 pending 会话（本质与 loopback 收到回调等价），响应一段提示 HTML；不做任何鉴权之外的额外信息回显。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/subscription-oauth.ts packages/server/src/routes/subscription.ts packages/server/src/routes/__tests__/subscription-oauth.test.ts
git commit -m "feat(server): add OAuth auth-url/status/session/callback endpoints"
```

---

### Task 8: `switch-project` 全局开关（config + 端点）

**Files:**

- Modify: `packages/core/src/types.ts`（`AppConfig` 增加字段，第 423–440 行）
- Modify: `packages/server/src/routes/subscription.ts`（新增两个路由）
- Test: `packages/core/src/config/__tests__/store.test.ts`（若已有 AppConfig 字面量则补字段）+ `packages/server/src/routes/__tests__/subscription.test.ts`

**Interfaces:**

- Consumes: 既有 `loadConfig()` / `updateConfig()`
- Produces:

  ```ts
  // types.ts
  export interface QuotaExceededSettings {
    /** 额度超限时自动切换 GCP 项目（对齐参考项目 quota-exceeded/switch-project）。 */
    switchProject?: boolean;
  }
  // AppConfig 新增
  quotaExceeded?: QuotaExceededSettings;
  ```

  ```
  GET /api/subscription/quota-exceeded/switch-project → 200 { "switch-project": boolean }
  PUT /api/subscription/quota-exceeded/switch-project → body {"switch-project": boolean} → 200 { "switch-project": boolean }
  ```

- [ ] **Step 1: 写失败测试**

`subscription.test.ts` 新增：

```
'reads switch-project as false by default'
'persists switch-project through PUT and reads it back'
'rejects a non-boolean switch-project with 400'
```

`store.test.ts`：若已有 `AppConfig` 字面量断言，确认新增可选字段不破坏它们（默认 `undefined` 即视为 `false`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

`PUT` 用 `updateConfig((cfg) => ({ ...cfg, quotaExceeded: { ...cfg.quotaExceeded, switchProject: value } }))`。
handler 里 `value` 必须 `typeof === 'boolean'` 否则 400。
**不写任何切换行为**（spec §7：参考项目本快照无消费点）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/server test` 且 `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types.ts packages/server/src/routes/subscription.ts packages/server/src/routes/__tests__/subscription.test.ts
git commit -m "feat: add global quota-exceeded switch-project setting"
```

---

### Task 9: UI —— provider 磁贴 + 每家独立弹窗（OAuth + 导入文件）

**Files:**

- Modify: `packages/ui/app/components/SubscriptionAccountsPanel.tsx`（重写交互部分）
- Create: `packages/ui/app/components/SubscriptionProviderDialog.tsx`
- Test: `packages/ui/app/components/__tests__/subscription-panel.test.tsx`（改写）
- Modify: `packages/ui/test/server.ts`（默认 handler 路径同步为 `/api/subscription/credentials`）

**Interfaces:**

- Consumes: `GATEWAY` / `withUiHeaders` / `classNames` / `formatNumber` from `../lib/utils`；`useI18n`；`Badge` / `Dot`；Task 6/7 的路由
- Produces: `SubscriptionProviderDialog({ provider, onClose, onChanged })`，内部状态机 `idle | starting | waiting | error`

- [ ] **Step 1: 写失败测试**

改写 `subscription-panel.test.tsx`（msw handler 路径改为 `/api/subscription/credentials`、`.../oauth/auth-url`、`.../oauth/status`、`.../oauth/session`）：

```
'renders one tile per provider with an add button (no shared paste box)'
'opens the Codex dialog and shows the Codex-specific callback port and fields'
'opens the Claude dialog and shows the organization field'
'opens the Google dialog and shows the GCP project field and no PKCE badge'
'clicking 打开浏览器登录 requests auth-url then polls status until ok'
'polling stops and the list refreshes once status returns ok'
'clicking 取消 calls DELETE oauth/session'
'an error status renders the provider-scoped error message'
'importing a file posts the file content to /credentials with the provider'
'the dialog for one provider never issues another provider's requests'
```

最后一条用于钉住「三家不串味」：断言 msw 收到的 `provider` 查询参数/tile 名一致。

`window.open` 用 `vi.stubGlobal` 打桩，断言被调用的 URL 等于 auth-url 返回的 url。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: FAIL

- [ ] **Step 3: 实现**

面板：三张磁贴（provider 名 + 账号类型 + 连接状态 + 「添加账号」）→ 打开对应弹窗；账号列表与既有徽标/用量渲染**保持不动**。
弹窗：`role="dialog"`，标题为 provider 名；两段——「用浏览器登录」（按钮 + 等待行，含该家的 `localhost:<port>`）与「或导入凭据文件」（`<input type="file" accept=".json,application/json">` 读内容 → `POST /credentials?provider=`）。轮询用 `setInterval(2000)`，组件卸载/关闭时必须 `clearInterval` 且 `aliveRef` 守卫（既有风格）。
端口常量放 UI 侧一份（`codex: 1455`, `claude: 54545`, `google: 动态`），来源与服务端 `SUBSCRIPTION_OAUTH` 对齐。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/ui/app/components packages/ui/test/server.ts
git commit -m "feat(ui): per-provider subscription dialogs with OAuth and file import"
```

---

### Task 10: UI 文案（zh/en）与设置页 switch-project 开关

**Files:**

- Modify: `packages/ui/app/i18n.tsx`（zh 第 631–663 行附近、en 第 1351–1385 行附近）
- Modify: `packages/ui/app/components/SettingsView.tsx`（订阅 section，第 2835–2846 行附近）
- Test: `packages/ui/app/components/__tests__/subscription-panel.test.tsx`

**Interfaces:**

- Consumes: Task 8 的 `GET|PUT /api/subscription/quota-exceeded/switch-project`
- Produces: 新增 i18n key（zh/en 同名同参）

- [ ] **Step 1: 写失败测试**

```
'dialogs and the settings toggle render in both zh and en without missing keys'
  → 用 createI18n/zh 与 en 两个语言各渲染一次，断言弹窗与开关文本存在且不含 "settings." 原始 key
'toggling switch-project PUTs the new value'
```

第二处补一个断言：`zh` 与 `en` 的 key 集合差集为空（缺翻译即失败）——参照 `subscription-panel.test.tsx:255` 附近既有的 'settings.section.subscription' 用法。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: FAIL

- [ ] **Step 3: 实现**

新增 key（两种语言都写）至少包含：
`settings.subscription.addAccount`、`.dialog.oauthTitle`、`.dialog.oauthHint`、`.dialog.openBrowser`、`.dialog.waiting`（含 `{port}` 变量）、`.dialog.reads`（含 `{fields}`）、`.dialog.cancel`、`.dialog.importTitle`、`.dialog.chooseFile`、`.dialog.timeout`、`.dialog.portBusy`（含 `{port}`）、`.dialog.stateInvalid`、`.dialog.denied`、`.pkce`、`.noPkce`、`.quotaExceeded.switchProject`。
设置页在订阅 section 内加一个开关（`role="switch"`），`onChange` 调 PUT。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/ui test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/ui/app/i18n.tsx packages/ui/app/components/SettingsView.tsx packages/ui/app/components/__tests__/subscription-panel.test.tsx
git commit -m "feat(ui): subscription OAuth copy and switch-project setting toggle"
```

---

### Task 11: 文档收尾

**Files:**

- Modify: `docs/superpowers/specs/2026-10-16-subscription-oauth-login-design.md`（状态 → 已实现，补偏差记录）
- Modify: `docs/superpowers/specs/2026-10-14-subscription-accounts-design.md`（§4.4 路由表更新；§5.1/§5.3 的「二期」标注改为「第二波已实现」；§10 追加第二波交付状态）

**Interfaces:**

- Consumes: 前 10 个任务的实际产物
- Produces: 无

- [ ] **Step 1: 更新文档**

记录：实际路由、实际端口、`antigravity` 别名、`switch-project` 仅配置无行为、以及任何实现期偏离。

- [ ] **Step 2: 校验引用一致**

Run: `git grep -n "api/subscription/accounts" -- packages docs ':!packages/ui/test'`
Expected: 无输出（旧路径已绝迹；`test/server.ts` 已在 Task 6 改）

- [ ] **Step 3: 提交**

```bash
git add docs
git commit -m "docs: record second-wave OAuth login delivery status"
```

---

## 最终验收（不属于任何单任务）

1. 串行跑完整门禁：`pnpm format:check` → `pnpm lint` → `pnpm build:runtime` → `pnpm typecheck` → `pnpm test:coverage`。
2. 起 `pnpm dev:server` + `pnpm dev:ui`，人工点一次三家的弹窗（OAuth 按钮能拉起浏览器、取消能收敛、文件导入可用）。
3. **R1 探测**（spec §11）：真实跑一次三家的换 token。若 Claude / ChatGPT 控制面拒绝普通 Node fetch，则该家以「降级结论」收尾（浏览器风格头 → 必要时 optionalDependencies 引入 curl-impersonate），**不阻塞**其它家，并把结论写进 spec 偏差记录。
4. 真实账号终验（流式 + 非流式）：需用户在浏览器完成授权；未完成的家记为「未执行—前置条件未满足」。
5. 提醒用户推送（**不得自行推送**）。
