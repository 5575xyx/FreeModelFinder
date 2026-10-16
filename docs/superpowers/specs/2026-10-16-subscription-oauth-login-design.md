# 订阅账号集成设计（第二波：OAuth 交互登录 + 逐家弹窗 UI）

- 状态：**已实现（2026-10-16）** —— 设计经用户批准；11 个实施任务全部完成，台账见 `.superpowers/sdd/2026-10-16-subscription-oauth-login/progress.md`，交付与偏差记录见 §13
- 日期：2026-10-16
- 前序：`2026-10-14-subscription-accounts-design.md`（第一波，已交付并推送）
- 对齐基准：CLIProxyAPI v8 源码（浅克隆 `C:\Users\13428\AppData\Local\Temp\opencode\CLIProxyAPI`，HEAD `5fc580b`）

第一波把 OAuth 交互登录划为「二期」（前序 spec §4.4、§5.1、§5.3 均如此标注）。**用户已推翻该决策：OAuth 交互登录纳入本期，三家全做。**

---

## 1. 目标 / 非目标 / 反目标

### 目标

1. **三家订阅账号支持 OAuth 交互登录**（浏览器授权 → 本机回调 → 自动落账号），与参考项目逐条对齐。
2. **UI 从「共用一个粘贴框」改为「每家 provider 各自独立的弹窗」**，弹窗内同时提供 **OAuth 登录** 与 **导入 JSON 文件** 两条路。
3. **每家弹窗体现参考项目里真实存在的差异**（见 §4），不是换皮。
4. **路由全面改名对齐参考项目**（`credentials/*` + `oauth/*`，见 §3）。
5. **Google 的 `switch-project` 作为全局配置开关**，落在设置页。

### 非目标（本期不做）

- Codex 的 SIWC（Sign in with ChatGPT）凭据绑定格式 —— 参考项目里是一套独立凭据类型与设备 ID 绑定命令，工作量独立，留待后续。
- Google 的多项目**选择器**（列出全部 GCP 项目供选）—— 参考项目不提供该 UI。
- Claude 的组织**切换** —— 参考项目只读取并展示组织，不提供切换。
- 钥匙串 / DPAPI 解密（前序 §5.2、§5.3 已定为二期，维持不变）。

### 反目标

- 不照搬参考项目的界面（它是 TUI + API，Web UI 属单独下载资产）；对齐的是**交互流程与契约**。
- 不发明参考项目里不存在的「廉价的假对齐」（例如给 `switch-project` 编一个假的切换行为，见 §7）。

---

## 2. 交互流程（与参考项目逐条对齐）

参考项目每家两条路，我方照此实现：

**路 A — OAuth 交互登录**

1. UI：`GET /api/subscription/oauth/auth-url?provider=<p>` → `{status:"ok", url, state}`
2. UI：打开 `url`（浏览器）
3. 浏览器授权后重定向到该 provider 的**固定 loopback 回调**（§3.3），服务端本机监听接收 `code`/`state`
4. 服务端：校验 state → 换 token → 解析 profile → 落账号
5. UI：每 2 秒 `GET /api/subscription/oauth/status?state=<s>` → `{status:"wait"}` … `{status:"ok"}`
6. UI 取消：`DELETE /api/subscription/oauth/session?state=<s>` → `{status:"ok", cancelled:bool}`

**路 B — 导入凭据文件**

1. UI：文件选择器读取内容 → `POST /api/subscription/credentials?provider=<p>`，body `{raw}`
2. 或：自动探测本机默认路径 → `POST /api/subscription/credentials?provider=<p>`，body `{path:"~/.codex/auth.json"}`

---

## 3. 对齐契约（参考项目 v8 为唯一基准）

### 3.1 路由对照表

| 我方（新）                                   | 参考项目 v8                            | 说明                                                    |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `GET /api/subscription/credentials`          | `GET /credentials`                     | 列表                                                    |
| `POST /api/subscription/credentials`         | `POST /credentials`                    | 导入/上传；body `{raw}` 或 `{path}`；`?provider=` 可选  |
| `DELETE /api/subscription/credentials`       | `DELETE /credentials`                  | `?provider=&id=`（参考用 `?name=`，见 §3.4 偏差 ①）     |
| `POST /api/subscription/credentials/refresh` | `POST /credentials/refresh`            | body `{provider,id}` 或 `{all:true}`（参考 `{name       | all}`）               |
| `GET /api/subscription/oauth/auth-url`       | `GET /oauth/auth-url`                  | `?provider=` → `{status,url,state}`                     |
| `GET /api/subscription/oauth/status`         | `GET /oauth/status`                    | `?state=`                                               |
| `DELETE /api/subscription/oauth/session`     | `DELETE /oauth/session`                | `?state=`                                               |
| `POST /api/subscription/oauth/import`        | `POST /oauth/import`                   | `?provider=`，**别名**，与 `POST /credentials` 同处理器 |
| `GET                                         | POST /api/subscription/oauth/callback` | `GET                                                    | POST /oauth/callback` | 浏览器回调接收端点（§3.3） |
| `GET /api/subscription/import-hints`         | —（我方新增）                          | UI 展示默认导入路径，参考项目无对应                     |

**迁移**：第一波的 `GET /accounts`、`POST /import`、`DELETE /accounts/:p/:id`、`POST /accounts/:p/:id/refresh` **全部移除**（该 API 尚未发布，无外部兼容负担），UI 与测试同步改到新路径。

### 3.2 状态语义（严格照抄参考项目 `GetAuthStatus` / `CancelAuthSession`）

`GET oauth/status?state=`

| 情况              | 响应                                                     |
| ----------------- | -------------------------------------------------------- |
| 无 `state` 参数   | `200 {status:"ok"}`                                      |
| state 格式非法    | `400 {status:"error", error:"invalid state"}`            |
| state 未知/已过期 | `200 {status:"error", error:"unknown or expired state"}` |
| 等待中            | `200 {status:"wait"}`                                    |
| 失败              | `200 {status:"error", error:"<原因>"}`                   |
| 完成              | `200 {status:"ok"}`                                      |

`DELETE oauth/session?state=` → 缺 state `400 {status:"error",error:"missing state"}`；否则 `200 {status:"ok", cancelled:<bool>}`。

### 3.3 本机回调监听（三家的差异本体）

| provider | 回调 URL（redirect_uri）                | 端口来源                                         |
| -------- | --------------------------------------- | ------------------------------------------------ |
| Codex    | `http://localhost:1455/auth/callback`   | 官方 OAuth 应用已注册，**固定**                  |
| Claude   | `http://localhost:54545/callback`       | 官方 OAuth 应用已注册，**固定**                  |
| Google   | `http://localhost:51121/oauth-callback` | 官方 OAuth 应用已注册，**固定**（见 §13 偏差 ⑤） |

- **主机名必须是 `localhost`，不是 `127.0.0.1`**（实现期修正，见 §13 偏差 ④）；监听不指定 host，Node 绑双栈 `::`，`127.0.0.1` 与 `::1` 都能连上。
- 端口被占用（1455/54545/51121）→ 明确报错并点出端口号，**不改端口**（改了官方应用不认）。
- 参考项目在 WebUI 场景下用 `callbackForwarder` 把本机回调转发到管理端点；我方是单进程本机网关，**监听器直接完成会话**，无需转发器。因此 `oauth/callback` 端点作为**对标存在 + 兜底通道**（固定端口被占时可手工把回调地址指过来）。
- 每个 provider **同时只允许一个 pending 会话**（端口唯一）。已有 pending → `409`。

### 3.4 与参考项目的偏差（明确记录，避免"假对齐"）

① **删除/刷新的标识**：参考项目按**凭据文件名** `?name=` 定位；我方按 `provider + id`（id 由适配器 `accountIdOf` 派生）。语义等价，参数形状不同。
② **provider 参数值**：参考项目 Google 那家叫 `antigravity`；我方内部 ProviderId 是 `google`。我方**同时接受 `antigravity` 作为 `google` 的别名**（对齐而不churn）。
③ **`oauth/import` 的适用范围**：参考项目该端点只用于 `vertex`；我方把它作为 `provider` 作用域的导入别名。
④ **`switch-project`**：参考项目本快照中**无任何运行时消费点**（仅 config/TUI/管理端点），见 §7。
⑤ **Google 回调端口固定为 51121**（设计原写"动态端口"，见 §13 偏差 ②）。
⑥ **回调主机名为 `localhost`**（设计原写 `127.0.0.1`，见 §13 偏差 ④）。
⑦ **`switch-project` 走专用端点** `GET|PUT|PATCH /api/subscription/quota-exceeded/switch-project`，而不是复用 `/api/config`（§7 原写了相反的结论，见 §13 偏差 ③）。

---

## 4. 逐家差异（可执行规格）

|                  | Codex                               | Claude                                    | Google                                                                              |
| ---------------- | ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| 授权机制         | OAuth + **PKCE S256**               | OAuth + **PKCE S256**                     | OAuth **无 PKCE**（仅 state）                                                       |
| 回调             | `localhost:1455/auth/callback`      | `localhost:54545/callback`                | `localhost:51121/oauth-callback`                                                    |
| 换 token 的 body | form-urlencoded                     | **JSON**（axios 风格头）                  | form-urlencoded                                                                     |
| 登录后补取       | id_token JWT claims                 | `GET api.anthropic.com/api/oauth/profile` | `GET googleapis.com/oauth2/v2/userinfo`（email）＋ `FetchProjectID`（`project_id`） |
| 展示字段         | 邮箱、**套餐 Plus/Pro**、account_id | 邮箱、**组织**、account_uuid、device_ids  | 邮箱、**GCP 项目 project_id**                                                       |
| 导入文件         | `~/.codex/auth.json`                | `~/.claude/.credentials.json`             | `~/.gemini/oauth_creds.json`                                                        |
| 解析细节         | —                                   | 返回的 code 可能以 `#state` 结尾，需截断  | project_id 拉取失败仅告警、不阻断                                                   |

**复用**：以上除「补取 email/project」（Codex 走 id_token、Claude/Google 走 HTTP 探测）外，client_id / token 端点 / PKCE / 刷新逻辑**已在第一波适配器中**（前序 spec §5.1–§5.3 已逐条核实）。新增工作集中在：本机回调监听、会话管理、UI。

**Google 的 `client_secret`**：OAuth 交互登录走**内置 client_id**（参考项目 Antigravity 专用 client_id）；文件导入仍按第一波策略（文件含 secret 则用，缺失报错）。

---

## 5. 后端设计

### 5.1 新增模块

- `packages/core/src/credentials/oauth/` — OAuth 会话与监听器（provider 无关的通用层）
  - `session.ts`：`Map<state, Session>`；`Session = { provider, status:'wait'|'ok'|'error', error?, pkceVerifier?, createdAt, listener }`
  - `loopback.ts`：绑定 loopback 端口、接收一次回调、超时/取消时关闭
  - `state.ts`：随机 state 生成与格式校验（照参考 `ValidateOAuthState`）
- 三家适配器新增 `buildAuthUrl({state, redirectUri, verifier?})` 与 `exchangeCode({code, redirectUri, verifier?})`（**第一波只有 refresh/import，没有这两步**）

### 5.2 会话生命周期

- 超时 **10 分钟**（定时器驱动，到期置 `error:"timeout"` 并关闭监听器）。
- 取消（`DELETE oauth/session`）→ 关闭监听器、标记 cancelled；等待中的回调协程检测到非 pending 即退出且**不落账号**（照参考 `CancelAuthSession` 注释语义）。
- 完成 → 落账号（走第一波的 `upsertAccount`）→ `status:"ok"`。
- 进程退出 → 全部监听器关闭（`unref()` + 进程钩子）。

### 5.3 与第一波导入的一致性

**必须复用** `POST /import` 原有逻辑（含第一波修好的两处）：启用 provider + `getRegistry().updateConfig(next)` 同步内存 + `upsertAccount`。OAuth 落账号与文件导入落账号走**同一条落库路径**，避免第二波重犯 C1 那个"只写磁盘不同步内存"的缺陷。

### 5.4 安全闸门

沿用现有 `/api/subscription/*` 的 `x-fmf-client: ui` + 可信 Origin 校验（`server.ts`），OAuth 新端点一并纳入。

---

## 6. UI 设计

### 6.1 入口（替换现有面板）

三张 provider 卡片：名称 + 账号类型 + 连接状态 + 「添加账号」按钮 → 打开**该家自己的弹窗**。移除现有「共用一个粘贴框」。

### 6.2 弹窗结构（同构，逐家差异化填充）

```
┌─ <Provider> 订阅账号 · <授权机制徽标> ─────────── ×
│  用浏览器登录
│    说明文案（逐家不同）
│    [打开浏览器登录]
│    ● 等待授权中… 本机监听 <localhost:端口>，每 2 秒查一次状态
│  登录成功后自动读取（逐家不同）
│    邮箱 · <套餐 / 组织 / GCP 项目> · …
│  或导入凭据文件
│    <逐家默认路径>
│    [选择文件]
└──
```

差异化内容见 §4 末三行。弹窗内状态机：`idle → starting → waiting → ok|error`；`waiting` 期间「取消」按钮调 `DELETE oauth/session`。

### 6.3 文件导入

用真实文件选择器（`<input type="file" accept=".json,application/json">`）读内容 → `POST /api/subscription/credentials?provider=`，body `{raw}`。保留「自动探测默认路径」按钮（`{path}`）。

### 6.4 文案

`packages/ui/app/i18n.tsx` 的 zh/en 均需扩展：授权机制徽标、等待中提示、各家字段名、错误提示（超时 / 端口被占用 / state 失效 / 授权被拒）。

---

## 7. `switch-project` 全局开关

**事实**：参考项目中 `cfg.QuotaExceeded.SwitchProject` **只出现在 config 定义、TUI 配置字段、config diff、管理端点**，**没有任何运行时消费点**（对比 `AntigravityCredits` 由 `antigravity_executor_credits.go:285` 消费）。

**决定**：本期严格对齐参考项目 —— 落**全局配置项 + 设置页开关 + 管理端点**，**不编造切换行为**。

- `AppConfig` 新增 `quotaExceeded?: { switchProject?: boolean }`（对应参考 `quota-exceeded.switch-project`）
- UI：设置页一个开关「额度超限时自动切换项目」
- 行为接入记为**遗留项**：参考项目无可抄实现，需自研 GCP 项目重解析，超出本期对齐范围
- 端点：`GET|PUT|PATCH /api/subscription/quota-exceeded/switch-project`，请求/响应形状照抄参考项目（见 §13 偏差 ③；本节原写"复用 `/api/config`、不新增专用端点"，实施时按已批准的实施计划改为专用端点）

---

## 8. 测试策略

- **mock 契约测试**（与第一波同协议）：
  - `oauth/auth-url`：三家各自断言 url 里的 `client_id` / `redirect_uri` / `scope` / PKCE 参数（Google 断言**无** PKCE）
  - `oauth/status`：`wait → ok`、`wait → error`、无 state、非法 state、未知 state **六种分支逐一断言**
  - `oauth/session`（取消）：断言监听器关闭且**不落账号**
  - 回调：伪造 `code` + `state` 打到 loopback，断言 state 校验、换 token（mock 上游）、落账号、内存 registry 同步
  - 端口占用：1455 已被占用时返回明确错误
  - `credentials` CRUD：列表 / 导入（`raw` 与 `path`）/ 删除 / 刷新（单个与 `all`）
- **UI 测试**（vitest + msw）：三张卡片各自开弹窗、弹窗内 OAuth 轮询到 `ok` 后刷新列表、取消调 `session`、三家差异文案分别渲染
- 全部按 TDD（RED 先行）。
- **门禁必须串行**（教训：`test:coverage` 内含 `build:runtime` 且 `clean:true`，绝不可并发再跑 `build:runtime`）。

---

## 9. 交付切片

1. **核心 OAuth 层**：会话 + loopback 监听 + state/PKCE 工具（TDD）
2. **新路由骨架**：`credentials/*` + `oauth/*` 迁移改造，旧路由移除，UI 调用同步
3. **Codex OAuth**（打样）→ 4. **Claude OAuth** → 5. **Google OAuth**（动态端口 + userinfo + project_id）
4. **三家弹窗 UI** + i18n + UI 测试
5. **`switch-project` 全局开关**（config + 设置页）
6. **文档**：本 spec 状态更新、前序 spec §4.4/§5.1/§5.3 的「二期」标注改为「第二波已实现」、README/UI 说明

每片独立可测、可回滚。

---

## 10. 验收标准与前置

- **mock 契约测试全绿**（§8）+ 现有门禁全绿（format/lint/typecheck/test:coverage）。
- **真实账号本机验收**（延续第一波口径：流式 + 非流式各跑通一轮 chat）。
  - **前置条件**：本机 `~/.codex/auth.json`、`~/.claude/.credentials.json`、`~/.gemini/oauth_creds.json` **均不存在**（2026-10-14 实测），且官方 CLI 未登录。
  - **本期前置改为**：OAuth 交互登录本身**不需要**预先登录官方 CLI —— 用户点「打开浏览器登录」即可完成授权。这是本波相对第一波的**实质改善**。
  - 若用户未完成任一家的浏览器授权，该家记为「未执行—前置条件未满足」。

---

## 11. 风险

- **R1（延续）Cloudflare / 反自动化**：Claude 与 ChatGPT 的控制面可能拒绝普通 Node fetch。OAuth 的 `auth-url` 是纯字符串拼接（无网络），但**换 token 与 profile 探测要发真实请求** —— 这是 R1 首次在**必须走通的路径**上出现（第一波导入路径可离线）。缓解：先浏览器风格头实测；必要时 optionalDependencies 引入 curl-impersonate（前序 Q3 已拍板）。
- **R6 固定端口冲突**：1455/54545 被其它程序占用（例如用户同时开着官方 CLI）。缓解：明确报错 + 提示占用者 + `oauth/callback` 兜底通道。
- **R7 与官方 CLI 抢占刷新**：延续 R2。OAuth 登录后 FMF 接管令牌，用户再跑官方 CLI 可能使其失效。
- **R8 路由改名破坏既有测试**：第一波 server 测试（392 条）大量断言 `/api/subscription/*` 路径。迁移必须一次性改全，避免半新半旧。

---

## 12. 留给实现者的决定

- OAuth 会话 Map 与 registry 的耦合方式（是否放进 registry 或独立单例）
- loopback 监听在 Windows 上的复用端口细节（`SO_REUSEADDR` 行为）
- 弹窗组件拆分与状态机实现形式
- `switch-project` 在设置页的具体挂载点与文案
- Google 动态端口的选择策略（由 OS 分配 vs 预扫一段范围）

---

## 13. 交付状态与偏差记录（2026-10-16）

第二波 11 个任务全部完成，分支 `feature/subscription-accounts`。完整台账（含每条 Ruling 与理由）见
`.superpowers/sdd/2026-10-16-subscription-oauth-login/progress.md`。

### 13.1 实际路由（以此为准，覆盖 §3.1）

| 方法                    | 路径                                              | 说明                                                               |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `GET`                   | `/api/subscription/credentials`                   | 聚合三家账号列表                                                   |
| `POST`                  | `/api/subscription/credentials?provider=`         | `{raw}` 或 `{path}`；**两条路（OAuth 落库 / 文件导入）共用此路径** |
| `DELETE`                | `/api/subscription/credentials?provider=&id=`     | 移除账号                                                           |
| `POST`                  | `/api/subscription/credentials/refresh`           | `{provider,id}` 或 `{all:true}`                                    |
| `GET`                   | `/api/subscription/oauth/auth-url?provider=`      | `{status,url,state}`                                               |
| `GET`                   | `/api/subscription/oauth/status?state=`           | `{status:'wait'\|'ok'\|'error',error?}`                            |
| `DELETE`                | `/api/subscription/oauth/session?state=`          | `{status:'ok',cancelled}`                                          |
| `GET` / `POST`          | `/api/subscription/oauth/callback`                | 兜底通道（provider 不认 loopback 时用）                            |
| `GET` / `PUT` / `PATCH` | `/api/subscription/quota-exceeded/switch-project` | `{"switch-project": boolean}`                                      |

`/api/subscription/accounts`、`/api/subscription/import` 两条旧路由**已删除**（API 未发布，无兼容负担）。

### 13.2 实际端口与同名对齐

| provider | 回调                                    | PKCE   | 换 token body       |
| -------- | --------------------------------------- | ------ | ------------------- |
| codex    | `http://localhost:1455/auth/callback`   | S256   | form                |
| claude   | `http://localhost:54545/callback`       | S256   | JSON + axios 风格头 |
| google   | `http://localhost:51121/oauth-callback` | **无** | form                |

`antigravity` 作为 `google` 的**别名**被接受（参考项目内部用 `antigravity` 作 provider key）。

### 13.3 与已批准设计的偏差（逐条）

1. **路由改名范围**：§3.1 只列了 `credentials/*`，实际同时新增了 `oauth/auth-url|status|session|callback` 四个端点并删除两条旧路由（已获批准的实施计划）。
2. **Google 回调端口固定 51121**（不是 §3.3 写的「动态端口」）。依据：参考项目 `antigravity/constants.go` 里 `RedirectURI` 是固定值，且上游对 `redirect_uri` 做精确匹配 —— 动态端口必然失败。
3. **`switch-project` 走专用端点**（不是 §7 写的「复用 `/api/config`」）。依据：参考项目 `internal/api/server_management.go` 就注册了 `GET|PUT|PATCH /quota-exceeded/switch-project`；已批准的实施计划按参考实现改为专用端点，`PUT` 同时接受参考项目的 `{"value":bool}` 与计划里的 `{"switch-project":bool}`。
4. **回调主机名 `localhost`**（不是 §3.3 写的 `127.0.0.1`）。依据：三家参考项目注册的 `redirect_uri` 都是 `http://localhost:<port><path>`，上游精确匹配，`127.0.0.1` 会真实失败；`listen` 不指定 host，Node 绑双栈 `::`。
5. **Google 仍然只落配置**：`switch-project` 没有运行时消费点（参考项目本快照里同样只写不读），UI 开关背后不存在「编造出来的切换行为」。
6. **CORS 预检的方法白名单**（验收期新增修复）：`@fastify/cors` 默认只广播 `GET,HEAD,POST`，而本波新增了 `PUT`/`PATCH`/`DELETE`。**真机表现是「点了没反应」**：取消登录不释放会话、`switch-project` 开关写不进去、移除账号无效。历史代码全用 GET/POST 所以从未暴露；而 `app.inject` 测试**不过预检**，全绿也守不住这一层。修法：显式声明 6 个方法 + 一条只走 `OPTIONS` 的回归用例。
7. **网络失败的 `cause` 被吞掉**（验收期新增修复）：undici 的网络层失败一律抛泛泛的 `TypeError: fetch failed`，真正可行动的信息（连接超时 / DNS / 代理拒绝）在 `cause` 里。三家共 6 处改为 `describeFetchFailure()`。这是真实账号验收最可能卡住的一层，只报 `fetch failed` 等于没报。

### 13.4 验证

- `pnpm format:check` → `pnpm lint` → `pnpm build:runtime` → `pnpm typecheck` → `pnpm test:coverage` 串行全绿。
- 测试计数：core **827**、server **423**、ui **295**（26 文件）、cli **376**、zen **14**，全 0 失败。
- **真机浏览器端到端**（`pnpm dev:ui` + 真实 server，非 msw）：三家磁贴在设置页「来源」下渲染；打开 Codex 弹窗显示 `OAuth + PKCE S256` / `本机回调 localhost:1455/auth/callback` / 自动读取「邮箱、套餐、账号 ID」；点「打开浏览器登录」真的申请到端口并进入「等待授权中」，`auth-url` 返回的 URL 含 `redirect_uri=http://localhost:1455/auth/callback`、`prompt=login`、`code_challenge`；同家第二次申请 409；点「取消」→ 重新登录可以再次成功（未修 CORS 时这里会一直 409）；`switch-project` 开关点两下，服务端真值随之 `true` → `false`。
- 真实账号端到端（流式 + 非流式）与 R1 控制面探测见 §11 与交付说明。

### 13.5 已知遗留（非目标外的额外记录）

- `audit:prod` / `test:pack` 两层在**基线**即失败（npmmirror registry + `fastify`/`undici` 固定漏洞），与本波无关；缓解措施是网关只绑 `127.0.0.1`。
- 延期 Minor 池（第一波遗留）：`/v1/models` 未透出 plan、audit provider 白名单双处硬编码、冷却清除按钮、core `redact` 阈值、Claude `max_tokens` 默认值、三家 catalog vision 能力未声明、`cline.ts` 同类 stale-refresh-token replay、Google `ensureProject` 陈旧回写。
- 三家 provider **没有**设置页启用开关（本波只做了 `switch-project`）。
