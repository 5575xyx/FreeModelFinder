# 订阅账号集成设计（第一波：Codex / Claude / Google 账号）

日期：2026-10-14
状态：**已交付（第一波 12/12 任务完成，2026-10-16）**；真实账号本机终验因前置条件未满足待执行，见 §10。

## 1. 背景与意图

FreeModelFinder 目前聚合的几乎全是"免费 API key"渠道（OpenRouter、Gemini API key、智谱、SiliconFlow 等），只有 Cline 一家使用 OAuth 账号。用户想要的能力是：**把自己已付费的订阅账号（ChatGPT Plus/Pro、Claude Pro/Max、Google/Gemini 订阅）登录进 FreeModelFinder，把订阅额度变成本地可用的统一 API 算力**。

参考项目 CLIProxyAPI（本地浅克隆：`C:\Users\13428\AppData\Local\Temp\opencode\CLIProxyAPI`，Go）已实现同类能力，其 OAuth 常量、协议端点、刷新策略已从源码核实并收录在本文档（§5），实现时移植为 TypeScript，不引入 Go 运行时。

远期目标是把 CLIProxyAPI 支持的账号型 provider 全部接入（Kimi、xAI/Grok、Antigravity、Vertex、AIStudio、Meta、Devin），分三波推进：

- **第一波（本期范围）**：凭证适配器框架 + Codex、Claude、Google 账号三家
- 第二波：Kimi、xAI、Vertex（服务账号 JSON）、AIStudio（纯 API key）
- 第三波：Meta AI、Devin

第二、三波不在本文档范围，但本期的适配器接口必须让"新增一家 = 一个 ≤200 行的适配器 + 一个 provider 类"。

## 2. 目标 / 非目标 / 反目标

### 目标

1. 通用**订阅凭证适配器框架**：统一的"解析导入 / 刷新 / 失效判定"接口，三家各一个实现。
2. **文件导入为主路径**：读取官方 CLI 已保存的凭证文件（`~/.codex/auth.json`、`~/.claude/.credentials.json`、`~/.gemini/oauth_creds.json`），解析入库。用户若用过这些 CLI，OAuth 登录那一步已经完成。
3. 三家 provider 实现：订阅账号 → 内部 `ChatRequest`/`StreamChunk` 的协议翻译，流式 + 非流式。
4. Token 生命周期：提前刷新（复用 Cline `refreshChain` 模式）、并发刷新去重、401/403 判定账号失效、refresh token 轮换回写、导入后由 FMF 接管刷新。
5. 路由集成：订阅模型进入 `registry`/`auto-router`，复用现有 429 冷却与 failover 链。
6. UI：设置页新增"连接订阅账号"入口——文件路径导入/文件内容粘贴上传、账号列表（邮箱/套餐/过期时间/健康状态）、移除、风险提示文案。
7. OAuth 交互登录（浏览器回调/PKCE）为**二期**，本期不实现，但适配器接口预留 `startOAuth()/completeOAuth()` 位置。

### 非目标（本期不做）

- OAuth 网页/设备码交互登录（二期）
- 第二、三波 provider
- 桌面端（Tauri macOS）UI 改造——本期仅 core + server + Next.js 设置页
- 多用户/远程共享订阅账号；配额转卖类功能
- 视觉/图像/视频等非 chat 模态（订阅通道本期仅 chat completions，含流式、tools、vision 按协议能力自然支持）

### 反目标（明确不要）

- 不把任何订阅 token 上传到 FMF 之外的服务；全部本地加密存储
- 不在用户无感知的情况下消耗订阅额度：订阅模型在 auto 路由中**仅作兜底**（排在免费模型之后，免费渠道全部不可用时才消耗订阅额度），裸模型名（无 `codex:`/`claude:`/`google:` 前缀）解析也保持免费渠道优先；显式 `provider:model` 前缀调用不受限（用户拍板结论，2026-10-14）
- 不静默与原 CLI 抢占 token：导入成功后 UI 明示"已由 FMF 接管刷新"，并提示 token 轮换风险
- 不复刻参考项目的 uTLS 浏览器指纹伪装作为一期硬依赖（见 §7 风险 R1，有降级路径）

## 3. 约束

- monorepo 规范见根 `AGENTS.md`：Node ≥ 22.14、pnpm 11、`noUncheckedIndexedAccess: true`
- core 测试用 `node --test` + tsx，覆盖率为 core 85% lines / 74% branches 硬门槛
- CI 顺序：`format:check → lint → build:runtime → typecheck → test:coverage → build → audit:prod → verify:release → test:pack`
- 凭证加密复用 `packages/core/src/config/store.ts` 的 `master.key` 机制；日志脱敏复用 `credentials/redact.ts`
- 现有 `gemini` provider（API key 模式）保持不动；新 provider id 见 §4.1
- 不推送 GitHub，改动完成后由用户决定是否推送

## 4. 总体设计

### 4.1 Provider 命名与注册

| 新 ProviderId | 含义                       | 上游协议                                                    |
| ------------- | -------------------------- | ----------------------------------------------------------- |
| `codex`       | ChatGPT Plus/Pro 订阅账号  | `chatgpt.com/backend-api/codex`（Responses 协议）           |
| `claude`      | Claude Pro/Max 订阅账号    | `api.anthropic.com/v1/messages`（OAuth Bearer）             |
| `google`      | Google 账号（Gemini 订阅） | `cloudcode-pa.googleapis.com/v1internal`（Gemini CLI 同族） |

- `gemini`（API key）与 `google`（账号 OAuth）并存，模型 ID 前缀区分：`codex:gpt-5.1-codex-max`、`claude:claude-sonnet-4-5`、`google:gemini-3-pro`。
- 注册方式照抄现有模式：`types.ts` 加枚举、`providers/index.ts` 导出、`registry.ts` `PROVIDER_CTORS` 注册、`resolveModelWithAlias` 启发式补充（`claude-*` → claude 订阅账号或现有渠道按可用性、`gpt-5*codex*` → codex）。

### 4.2 凭证适配器框架（核心新代码）

位置：`packages/core/src/credentials/adapters/subscription/`

```ts
interface SubscriptionAdapter {
  readonly provider: ProviderId;
  /** 解析官方 CLI 凭证文件内容；返回规范化凭证或明确的解析错误 */
  parseImport(raw: string, source: ImportSource): ParsedSubscription;
  /** 刷新 access token；必须处理 refresh token 轮换并返回新凭证 */
  refresh(ctx, cred: SubscriptionCredential): Promise<SubscriptionCredential>;
  /** 判定凭证是否已永久失效（如 invalid_grant） */
  isFatalRefreshError(err: unknown): boolean;
  /** 账号可读身份（邮箱/套餐），用于 UI 展示 */
  describe(cred): Promise<AccountProfile>;
}
```

- `SubscriptionCredential` = `{ provider, accessToken, refreshToken, expiresAt, profile, raw }`，落入现有 `credential-store`（`config.credentials.<provider>`，加密），多账号池复用 `account-pool.ts`（round_robin/fill/random）。
- 刷新并发去重参考 Cline `refreshChain`（`providers/cline.ts:440`）：单飞（singleflight 语义）、提前量 `REFRESH_SKEW_MS`、失败链去重。
- Claude 特有：刷新接口有瞬时冷却语义（参考实现按 refresh_token 维度记 block 到期时间，Retry-After 驱动）；移植为内存 Map 即可。
- Codex 特有：`refresh_token_reused` 为不可重试致命错误（token 被其他实例刷新过），直接判账号失效。
- Google 特有：`oauth_creds.json` 内嵌 `client_id`/`client_secret`，刷新即标准 Google OAuth token 端点。

### 4.3 Provider 实现（协议翻译）

三个新 provider 类继承 `BaseProvider`（`providers/base.ts`），实现 `listModels/chat/stream`：

- **codex**：请求体从 OpenAI ChatRequest 翻译到 Responses 协议（`{"model", "instructions?", "input": [...], "stream": true}`），SSE chunk 翻回 `StreamChunk`。鉴权 `Authorization: Bearer <access_token>` + `chatgpt-account-id: <account_id>` 头。模型目录：静态清单（gpt-5-codex、gpt-5.1-codex-max 等）+ 尝试上游 models 端点刷新。
- **claude**：内部 ChatRequest 本就与 Anthropic messages 高度同构（现有 `routes/anthropic.ts` 是入站方向），出站翻译量小。鉴权 `Authorization: Bearer <oauth access token>` + `anthropic-beta: oauth-2025-04-20` 头。模型目录静态清单（sonnet/opus 线）。
- **google**：走 cloudcode-pa `v1internal` 通道（`loadCodeAssist` 初始化 → `streamGenerateContent`），请求/响应形状是 Gemini generateContent 的变体，翻译直白。access token 直接用 Google OAuth Bearer。

流式统一：`AsyncIterable<StreamChunk>`；错误统一抛 `UpstreamError`（保留状态码与 Retry-After），让 auto-router 的 `parseRateLimitError`/冷却表直接生效。

### 4.4 服务端 API 与 UI

Server 新增（照抄 `/api/cline/*` 模式，`packages/server/src/server.ts`）：

- `GET /api/subscription/accounts` — 聚合三家账号列表（脱敏，仅 profile + 健康状态）
- `POST /api/subscription/import` — `{provider, raw}`（文件内容由 UI 读出后 POST，服务端也可读默认路径一键导入）
- `DELETE /api/subscription/accounts/:provider/:id`
- `POST /api/subscription/accounts/:provider/:id/refresh` — 手动触发刷新

UI（Next.js 设置页）：

- "连接订阅账号"卡片：三个 provider 磁贴 → 选择"从 CLI 导入（自动检测默认路径）"或"粘贴文件内容"
- 导入成功弹窗：展示账号身份 + **接管提示**（"此后 token 刷新由 FMF 管理；若原 CLI 再次运行可能导致凭证失效，可重新导入恢复"）+ ToS 灰色地带风险提示一句
- 账号列表：邮箱/套餐/过期时间/状态徽标（正常/冷却/失效）/移除按钮

### 4.5 模型注册表与路由集成

- `listAllModels()` fan-out 自动包含新 provider（它们实现 `hasCredentials()` 自证可用性）。
- 订阅模型在模型元数据上打 `subscription: true` 标签（新增字段）。
- **auto 路由 = 兜底模式**：`buildFallbackChain`/`rankCandidates` 中订阅模型排在所有免费模型之后，只在免费渠道全部冷却/不可用时进入服务位；`resolveModelWithAlias` 裸名启发式同样免费渠道优先（现有启发式不动，订阅渠道仅在无免费命中且用户开启订阅兜底时作为末位候选）。
- 冷却/failover 完全复用：`markRateLimited`、`advanceFailover`、`fmf_route_notice` 切换提示无需改动。
- `FREE_MODELS.md` 审计脚本不纳入订阅模型（它们不是"免费 key"，避免文档语义混乱）。

## 5. 已核实的协议常量（移植来源：CLIProxyAPI v8 源码）

### 5.1 Codex（`internal/auth/codex/openai_auth.go`）

- 授权 URL：`https://auth.openai.com/oauth/authorize`，PKCE S256，`scope=openid email profile offline_access`，`redirect_uri=http://localhost:1455/auth/callback`（二期用）
- Token/刷新：`POST https://auth.openai.com/oauth/token`，form-urlencoded；刷新 `scope=openid profile email`；`client_id=app_EMoamEEZ73f0CkXaXp7hrann`
- 响应：`access_token/refresh_token/id_token/expires_in`；id_token JWT claims 提取 `account_id/email/plan`
- 致命刷新错误：`refresh_token_reused`
- 上游 API：`https://chatgpt.com/backend-api/codex`（`codex_executor_execute.go:36`）
- `~/.codex/auth.json` 格式：`{OPENAI_API_KEY: null, auth_mode: "chatgpt", tokens: {id_token, access_token, refresh_token, account_id}, last_refresh}`

### 5.2 Claude（`internal/auth/claude/anthropic_auth.go`）

- 授权 URL：`https://claude.ai/oauth/authorize`，PKCE S256，`redirect_uri=http://localhost:54545/callback`
- `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- `scope=user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Token/刷新：`POST https://platform.claude.com/v1/oauth/token`，**JSON body**（非 form），axios 风格头（`User-Agent: axios/1.15.2`）
- Profile：`GET https://api.anthropic.com/api/oauth/profile`（Bearer），取 email/account uuid/org
- 刷新限流：按 refresh_token 记 block 时间（Retry-After / Retry-After-Ms 驱动，5s–5min clamp）；响应体缺 `refresh_token` 时沿用旧值
- 上游 API：`api.anthropic.com/v1/messages` + OAuth Bearer；参考实现带 `anthropic-beta: oauth-2025-04-20`
- `~/.claude/.credentials.json` 格式：`{claudeAiOauth: {accessToken, refreshToken, expiresAt(ms), scopes[], subscriptionType}}`；macOS 存钥匙串（一期可只支持文件路径，钥匙串二期）
- 参考实现对 Anthropic 域名使用 uTLS Firefox 指纹绕 Cloudflare → 风险 R1

### 5.3 Google 账号 / Gemini CLI 凭证（`internal/auth/antigravity/constants.go`）

- Google OAuth：`https://accounts.google.com/o/oauth2/v2/auth` → `https://oauth2.googleapis.com/token`，userinfo `https://www.googleapis.com/oauth2/v2/userinfo?alt=json`
- 参考项目的 client_id：`1071006060591-...apps.googleusercontent.com`（Antigravity 专用）；**导入 Gemini CLI 的 `oauth_creds.json` 时用文件内嵌的 client_id/client_secret**，无需内置 secret
- API 通道：`https://cloudcode-pa.googleapis.com/v1internal`（`loadCodeAssist` → generateContent 变体；Gemini CLI 同族协议）
- `~/.gemini/oauth_creds.json` 格式：`{access_token, refresh_token, scope, token_type, id_token, expiry_date(ms), client_id, client_secret?}`
- 实测（2026-10-14，用户授权检查）：本机（Windows）当前不存在该文件，无法核实 client_secret 是否明文。适配器策略：**文件内含可用 client_secret → 直接用它刷新；缺失/为空 → 导入时报错并提示原因**。DPAPI/钥匙串解密属二期增强，仅当后续实测发现落盘为加密格式时再加。
- 参考实现对 chatgpt.com 使用 uTLS Chrome 指纹 → 同 R1

## 6. 交付切片（实现顺序）

1. 框架：`SubscriptionAdapter` 接口 + credential-store 集成 + 单飞刷新工具 + 测试
2. Codex 打样：adapter（import/refresh/describe）+ provider（responses 翻译，流式）+ server API + 最小 UI 导入 + 契约测试
3. Claude：同上（JSON body 刷新、block 冷却、messages 翻译）
4. Google：同上（cloudcode-pa 通道）
5. 路由集成：`subscription` 标签、auto 兜底排序（§4.5）、`/v1/models` 展示
6. UI 完整化：账号列表/状态/移除/提示文案
7. 文档：README/FREE_MODELS 说明区、`pnpm audit:daily` 兼容性检查（订阅 provider 不参与免费审计）

每片独立可测试、可回滚；2-4 片内部按 Codex → Claude → Google 顺序（先易后难，Codex 文件结构最简单）。

**验收标准（用户拍板）**：每个 provider 切片 = mock 契约测试通过 **且** 用户真实订阅账号在本机跑通一轮 chat（流式 + 非流式）才算完成。验证前置条件：用户需先在本机登录对应官方 CLI 生成凭证文件（当前机器上 `~/.codex/auth.json`、`~/.claude/.credentials.json`、`~/.gemini/oauth_creds.json` 均不存在；Codex CLI/Claude Code/Gemini CLI 一次登录即可生成）。若某切片真实探测触发 R1 降级评估，则该切片以降级结论收尾再进入下一家，不阻塞后续切片。

## 7. 风险与缓解

- **R1 Cloudflare/反自动化**：Claude 与 ChatGPT 的控制面可能拒绝普通 Node fetch。降级路径：① 先用浏览器风格头（UA/Accept）实测；② 失败则引入 `curl-impersonate` 绑定；③ 最坏情况下该 provider 标记"当前网络环境不可用"，不影响其他 provider。实现时先对刷新端点做真实探测再定方案。**接受标准（用户拍板）**：curl-impersonate 以真正可选依赖（optionalDependencies）接入——装得上则启用对应 provider，装不上/平台不支持则该 provider 自动降为不可用，绝不影响主包安装与核心功能，CI `test:pack` 不依赖它。
- **R2 refresh token 轮换互踩**：用户导入后原 CLI 再运行会作废凭证。缓解：接管提示文案 + 导入可重复执行（重新导入即恢复）。
- **R3 订阅模型挤占免费路由**：已由兜底模式设计化解（§4.5）：订阅模型在 auto 链中恒排免费模型之后，仅兜底，裸名解析免费优先。
- **R4 ToS 灰色地带**：UI 一句风险提示；产品定位为"用户管理自己的已购额度"，不做配额转卖。
- **R5 上游模型清单漂移**：Codex/claude 模型名随订阅计划变化。缓解：静态清单 + `/v1/models` 支持手动别名（现有 `modelAliases` 机制兜底）。

## 8. 已拍板的决策（2026-10-14 用户确认）

- **Q1 auto 路由策略** → **兜底模式**：订阅模型参与 auto 但恒排免费模型之后，免费渠道全部不可用时才消耗订阅额度；裸模型名解析保持免费渠道优先；显式 `provider:model` 前缀不受限。
- **Q2 验收标准** → **真实账号本地验收**：每个 provider 切片 = mock 契约测试通过 + 用户真实订阅账号本机跑通 chat（流式+非流式）。前置：用户先登录对应官方 CLI 生成凭证文件（当前机器三份文件均不存在）。
- **Q3 curl-impersonate** → **接受，做成真正可选依赖**（optionalDependencies，装不上自动降级为 provider 不可用，主包不受影响）。
- **Q4 Google client_secret** → 本机实测无 `oauth_creds.json` 文件；适配器按"文件含 secret 则用、缺失则报错提示"处理，DPAPI 解密留二期。

## 9. 留给实现者的决定

- provider 类内部文件组织与翻译函数拆分
- 单飞刷新工具的具体实现（可泛化 Cline refreshChain 或新写）
- 测试夹具组织（fixture JSON 用脱敏样本）
- 静态模型清单的具体条目（以各服务官方文档为准，实现时核实）
- 云代码（cloudcode-pa）`loadCodeAssist` 的初始化时序细节（参考 antigravity executor 源码）

## 10. 交付状态与偏差记录（2026-10-16）

第一波 12 个任务全部完成，分支 `feature/subscription-accounts`，提交链 `816d77d`（T1）→ `5c6204d`（T11）→ 本次文档提交。完整台账见 `.superpowers/sdd/2026-10-14-subscription-accounts/progress.md`。

**已交付**

| 切片   | 内容                                                                        | 验证                      |
| ------ | --------------------------------------------------------------------------- | ------------------------- |
| 框架   | `SubscriptionAdapter` 接口、credential-store 集成、单飞刷新                 | core 契约测试             |
| Codex  | adapter + provider（responses 翻译，流式）                                  | 契约测试 33/33            |
| Claude | adapter（block 冷却）+ provider（messages 翻译）                            | 契约测试                  |
| Google | adapter（`oauth_creds.json`）+ provider（cloudcode-pa 通道）                | 契约测试 14 用例          |
| 路由   | auto 兜底分区、裸名免费优先、`/v1/models` 透出 `subscription`               | registry + server 测试    |
| UI     | 导入 / 账号卡（plan、到期、用量、状态）/ 移除两段确认 / 手动刷新            | ui 276/276                |
| 审计   | `scripts/lib/audit-filter.mjs` 订阅 provider 与 `subscription` 模型双重排除 | 6/6 + 无密钥 dry-run 实证 |

全量测试：core 783/783、server 389/389、cli 14/14、ui 276/276、scripts 6/6；typecheck 五包全绿。`pnpm test:coverage` EXIT=0（core 85%/74%、server 80%/75% 阈值均通过）。

> **覆盖率阈值门在 Windows 上空转（已核实，非本次引入）**：core/server/zen 的 `test:coverage` 使用 `--test-coverage-include='src/**/*.ts'`，而 Node 的覆盖率 glob 相对 cwd 匹配，Windows 上实际匹配到 **0 个文件**，导致报告显示 `all files | 100.00` 但文件列表为空——阈值判定因此形同虚设。已用 `--test-coverage-include='**/*.ts'` 重跑 core 全量取得真实数字：**行 93.80% / 分支 80.96% / 函数 90.24%**（阈值 85%/74%，富余充足）。新增文件单独覆盖率：adapter `subscription/codex.ts` 98.28%、`claude.ts` 96.93%、`google.ts` 94.71%；provider `codex.ts` 88.10%、`claude.ts` 90.98%、`google.ts` 87.28%。该 glob 问题在 Linux CI 上是否存在需另行验证（若同样空转，说明 CI 的覆盖率门一直未生效）。

**真实账号本机终验（原 Q2 验收标准）：未执行 — 前置条件未满足**

2026-10-16 复核，本机三份凭证文件均不存在：`~/.codex/auth.json`、`~/.claude/.credentials.json`、`~/.gemini/oauth_creds.json`（另 `~/.config/gcloud/application_default_credentials.json` 亦无）。因此 §6 拍板的"真实账号跑通流式+非流式 chat"一项对三家均**未验证**，本期以"mock 契约测试全绿 + 静态代码审查"收尾。

触发条件：用户在本机用官方 CLI 登录任一家（`codex login` / `claude login` / Gemini CLI 首次运行）→ Dashboard「设置 → 订阅账号」导入 → 手动发起一次流式与非流式 chat。
用户可见影响：在完成该验收前，本功能属"实现完成但未经真实上游验证"，可能暴露于 R1（反自动化拒 fetch）与 R5（模型清单漂移）两个已识别风险，触发时表现为单 provider 报错，不影响免费渠道。

**全分支终审（2026-10-16，fresh reviewer）：2 Critical + 2 Important + 2 Minor，全部核实属实**

审查覆盖适配器框架、三家 adapter/provider、registry 路由、server 路由、凭据存储、UI 面板与审计脚本。以下缺陷均已按 TDD（先写失败测试再修复）处理完毕：

| #   | 严重度              | 缺陷                                                                                                                                                                                                                                                                                                                              | 修复                                                                                                                                                                  |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Critical            | 导入只写凭据池，**没有任何代码路径**把 `config.providers.codex/claude/google` 置 `enabled: true`（store.ts 默认全 false；`getProvider` 以此为第一道闸门；设置页 `SETTINGS_PROVIDERS` 不含这三家）。导入"成功"后 `/v1/models` 不列订阅模型、auto 选不到、显式 `codex:…` 抛 `provider codex is not enabled` —— **功能端到端不可用** | 导入成功即 `updateConfig` 置 `enabled: true`；先启用再落账号（`listEnabledProviders` 用 `hasCredentials()` 过滤，空账号不会往 `/v1/models` 塞废模型，故无副作用窗口） |
| C2  | Critical            | `POST .../refresh` 直接调 `adapter.refresh`，**完全绕过单飞**；与 provider 内部自动刷新并发时同一 refresh_token 被发两次 → 上游判 `refresh_token_reused`/`invalid_grant` → 路由把账号标 `invalid` → **永久废号**。而用户恰恰在出问题、有流量时才点"刷新"                                                                          | 新增模块级共享单飞 `runSharedFlight`（键 `${provider}:${accountId}`），provider 与 server 路由共用同一把锁；锁内重读运行时池取最新 RT                                 |
| I1  | Important           | 401 重试把 `refreshed.account` 传下去，而缓存命中路径返回的是调用方最初拿到的对象；单飞只对**在途**刷新去重、setttle 即删 key，故另一个请求若已完成刷新，重试会用已作废的 RT 再刷一次 → 同样废号。commit 622a28e 只修了单请求内部的重试，跨请求的陈旧引用仍在                                                                     | 三家 `refreshChain` 起始按 id 重读运行时池，以最新副本为准（与 C2 同一收口点）                                                                                        |
| I2  | Important           | ① `gemini` 启发式是**唯一没有 try/catch** 的分支，免费 Gemini API key 未启用时直接抛 `provider gemini is not enabled`，把本可回落的请求变成 500；② 三家订阅目录发布的 id 带前缀（`codex:…`/`google:…`），而目录查找只比对 `m.id === modelId`，**订阅兜底对裸名在三家上全部不可达**，§4.5 拍板的"兜底候选"是死路                   | ① 补 try/catch，与其余启发式一致地 fallthrough；② 目录查找同时认精确 id 与去前缀 id，命中多条时仍先取免费条目                                                         |
| M1  | Important（上调）   | `pickAutoModel` 的 sticky 命中即返回、不比较链首：免费池全冷却时钉上订阅模型后，即使免费池恢复也**一直钉在订阅模型上**，持续消耗已付费额度且用户无感知 —— 直接违反本功能的核心约束                                                                                                                                                | sticky 若钉在订阅模型上而链首已变回免费模型，则解钉改取链首                                                                                                           |
| M2  | Minor（不修，记录） | Google `ensureProject` 在一次网络往返后用可能陈旧的 `account.payload` 回写池/磁盘，与并发刷新形成 last-writer-wins。缓解因素：Google 不轮换 refresh token（`google.ts` 固定沿用 `opts.refreshToken`），后果只是短暂用旧 access token → 下次 401 自愈，不会废号                                                                    | 延后                                                                                                                                                                  |

**审查确认无问题的重点项**：凭据/秘密处理（错误全链路 `redact()`、401 分支刻意不读响应体防 token 回显、API 响应不含 payload、落盘加密）；auto 免费优先分区；`invalid_grant` 致命分类不会造成重试死循环；文件导入路径穿越防护（`~/` 前缀 + 白名单目录 `root + sep` 校验）；审计脚本双层排除。

**修复后验证**：core 787/787、server 391/391（各含新增回归测试）。C2 与 M1 的测试均已反向验证敏感性——临时还原修复后分别复现 `calls: expected 1, actual 2` 与 `expected: 'openrouter', actual: 'claude'`。

**已记录的偏差**

- 订阅模型 `free: true` + `subscription: true` 并存：免费审计靠 `subscription` 标记排除（见 R3 的补充实现）。
- `audit-free-models.mjs` 在 Windows 上 `await import()` 绝对路径抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，已改 `pathToFileURL`（Linux CI 行为不变，属附带修复）。
- scripts 层测试不在 CI 链上，本地 `node --test scripts/audit-free-models.test.mjs` 覆盖。
- 交付前遗留：`pnpm lint` 有 1 个 main 预存 warning（`zen/gateway-pool.test.ts`）；`pnpm format:check` 因 Windows CRLF 大批失败（基线同样）——两者均非本次引入，见 §11。
- **`test:pack` 在本机失败，两层原因叠加（均为基线既有，非本次引入）**：
  - **第一层（环境）**：本机 npm registry 为 `registry.npmmirror.com`，该镜像未实现 audit 端点，`smoke-package.mjs:116` 的 `npm audit --omit=dev --audit-level=moderate` 返回 `[NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet`。已隔离验证：同一 lockfile 下 `--registry https://registry.npmjs.org/` 可正常返回报告。
  - **第二层（真实依赖漏洞，换官方 registry 后暴露）**：打包产物审计出 **3 个漏洞（1 moderate、2 high）**——`fastify <=5.12.4`（仓库精确固定 `5.10.0`，7 条 high 公告，含 auth bypass、X-Forwarded spoofing、schema validation bypass，npm 报 **No fix available**）、`undici 7.0.0-7.29.0`（精确固定 `7.29.0`，10 条 high 公告，含 TLS 证书校验绕过、response splitting、跨用户 cookie 泄露，`npm audit fix` 可修）。两者均为 `packages/cli/package.json` 的直接固定依赖；本分支未改动任何 `package.json`/`pnpm-lock.yaml`（diff 为空），故打包依赖集与基线逐字节一致，**`test:pack` 在 main 上同样必败**。缓解因素：Gateway 默认仅绑定 `127.0.0.1`，大幅降低远程攻击面；但这仍是发布包的真实安全债务，需单独开任务处理（提升 `fastify` 至 >=5.12.5、`undici` 至修复版本，并复核 `--audit-level` 策略）。
- **CI 门槛修复（2026-10-16，本次交付的一部分）**：`format:check` 在基线上就有 396 个文件失败——成因有二，(a) 本机 `core.autocrlf=true` 使工作区为 CRLF 而 prettier 默认 `endOfLine: lf`；(b) lockfile 已锁定 prettier **3.9.6**（`package.json` 写 `^3.2.5`），而 31 个既有文件是旧版 prettier 格式化的，存在真实内容违规。已按 brief 第 2 步要求以仓库同版本 prettier 重排全部文件，`format:check` 现 EXIT=0；这 31 个文件的改动均为纯折行/表格对齐，无语义变化（已逐个抽查 `anthropic.ts`、`gemini.ts`、`ImageGeneratorView.tsx` 等）。`lint` 的 1 个 warning 是 `ZenProxyTransport` 类型导入后从未使用，已删除该导入，`lint` 现 EXIT=0。

## 11. 遗留问题（不阻塞交付）

1. **R1 未实测**：三家真实上游均未探测，`curl-impersonate` 可选依赖（Q3）未接入，需在真实账号终验时按 §7 降级路径判定。
2. **冷却清除按钮**：UI 未提供，账号卡展示 cooldowns 数据但无清除入口（计划标注"非本期必须"）。
3. **redact 覆盖缺口**：core `redact` 只匹配 ≥40 字符 base64，短 `rt-` 前缀 token 漏网；UI 已加第二道防线，core 侧待补。
4. **`/v1/models` 只透出布尔**：未暴露 plan / 账号状态。
5. **基线问题**（main 上已存在）：`format:check` 的 396 个失败与 `lint` 的 1 个 warning 已在本次交付中修复（见 §10）；server `opencode hasKey seam` flake 仍存在，与本功能无关，未处理。
6. **覆盖率阈值门可能失效**：core/server/zen 的 `test:coverage` 用 `--test-coverage-include='src/**/*.ts'`，Windows 上匹配 0 文件使阈值空转（见 §10）。若 Linux CI 同样空转，则 CI 的覆盖率门自始未生效，需改为 `**/*.ts` 并复核真实达标情况。本功能的真实覆盖率已单独验证达标。
7. **发布包安全债务（`test:pack` 必败的真实原因）**：`packages/cli` 精确固定 `fastify 5.10.0`（7 条 high 公告，npm 报 No fix available）与 `undici 7.29.0`（10 条 high 公告，可修），使 `test:pack` 的 `npm audit --audit-level=moderate` 无法通过。基线既有，与本功能无关；缓解因素是 Gateway 默认只绑 `127.0.0.1`。需单独开任务提升两个固定版本并复核 audit 策略。另：本机 npm 镜像 `registry.npmmirror.com` 未实现 audit 端点，会先于该问题失败，需 `npm_config_registry=https://registry.npmjs.org/` 才能看到真实审计结果。
