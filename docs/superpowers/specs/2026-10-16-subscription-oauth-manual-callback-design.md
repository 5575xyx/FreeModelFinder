# 订阅账号集成设计（第三波：远程部署下的 OAuth 手动回调）

- 状态：**设计待批准**
- 日期：2026-10-16
- 前序：`2026-10-16-subscription-oauth-login-design.md`（第二波：OAuth 交互登录 + 逐家弹窗 UI，已实现、未推送）
- 对齐基准：CLIProxyAPI v8 源码（只读浅克隆 `C:\Users\13428\AppData\Local\Temp\opencode\CLIProxyAPI`，HEAD `5fc580b`）

第二波把 OAuth 交互登录做成「本机回环」后，**只在浏览器与网关同机时成立**。本波补上远程部署（Docker / VPS）下仍然可用的那条路 —— 参考项目里本来就有的**手动回调**。

---

## 1. 问题（有实测证据）

三家 provider 的 `redirect_uri` 是**写死的回环地址**：

| provider | redirect_uri                            | 来源                                        |
| -------- | --------------------------------------- | ------------------------------------------- |
| Codex    | `http://localhost:1455/auth/callback`   | 官方 OAuth 应用已注册，固定                 |
| Claude   | `http://localhost:54545/callback`       | 官方 OAuth 应用已注册，固定                 |
| Google   | `http://localhost:51121/oauth-callback` | 官方 OAuth 应用已注册，固定（第二波偏差 ⑤） |

回调由**网关进程**监听。于是当用户把面板部署到服务器、在**自己的笔记本**上打开浏览器时：

1. 点「打开浏览器登录」→ 服务端返回授权 URL，浏览器打开；
2. 用户在浏览器里完成授权；
3. 上游把浏览器重定向到 `http://localhost:1455/auth/callback`；
4. 这个 `localhost` 解析到**用户笔记本**，而监听器在**服务器**上 —— 永远收不到；
5. 授权页显示「无法连接」，面板干等 10 分钟超时。

**补充实测证据**：同机场景（第二波 §13.4）三家全流程可跑通；本机对三家的控制面探测也证明「这条链路本身是通的」，卡点只在**浏览器与网关不同机**这一件事上。

`docker-compose.yml` 是官方部署路径，所以这不是边缘场景。

---

## 2. 目标 / 非目标 / 反目标

### 目标

1. **远程部署（浏览器 ≠ 网关）下，三家仍能完成 OAuth 登录**。
2. 对齐参考项目的**手动回调轨**：`POST /oauth/callback` 收 `redirect_url`，由服务端拆参数（参考项目 `oauth_callback.go:56-75`）。
3. **面板上给出该轨的入口**（参考项目对应物是 TUI 输入框，`oauth_tab.go:100-103`）—— 这是当前唯一的缺口。
4. 回调输入按参考项目**宽容解析**：完整 URL / 裸 query / 裸 `k=v` / 裸 `code#state` / fragment 兜底（`misc/oauth.go:53-126`）。
5. 给出**自动轨**（SSH 端口转发）可照抄的指引，并写清端口映射的安全要求。
6. 手动轨与自动轨**落到同一条落库路径**（`landSubscriptionAccount`）。

### 非目标（本期不做）

- 参考项目的 `callbackForwarder`（绑 `0.0.0.0` + 302 转发到管理服务）—— 见 §3.3 偏差 ①。
- 把 `redirect_uri` 改成服务器公网地址 —— 上游精确匹配，必然被拒（§3.1）。
- 设备码流程（RFC 8628）—— 三家均不适用。
- 第二波非目标（SIWC、Google 多项目选择器、Claude 组织切换、钥匙串/DPAPI）维持不变。

### 反目标

- 不做「假的远程支持」：手动回调必须真把 code 交给服务端换 token，不是把 code 记下来当成功。

---

## 3. 契约（参考项目 v8 为唯一基准）

### 3.1 为什么不能改 redirect_uri

三家 `redirect_uri` 在官方 OAuth 应用里注册死（`openai_auth.go:28`、`anthropic_auth.go:34`、`antigravity/constants.go:8`），上游对 `redirect_uri` 做**精确匹配**。改成 `https://myserver.example/callback` 会被 `invalid_redirect_uri` 直接拒绝。

所以手动轨的方向只能是 **「用户把地址栏那条回跳 URL 带回来」**，不能是「上游把回调发到服务器」。

> 附带核实：参考项目 `auth_files_provider_oauth.go:62` 有一句注释 "override redirect_uri to reuse server port"，但紧接的调用 `GenerateAuthURL(state, pkceCodes)` 用的仍是常量 `RedirectURI`。**注释是过时的**，写死没变。这是我们不改它的直接依据。

### 3.2 端点点位（第二波已实现，本波不改形状）

`GET|POST /api/subscription/oauth/callback`（`packages/server/src/routes/subscription-oauth.ts:232-274`）

| 输入                                        | 行为                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| `redirect_url`                              | 从该 URL 的 query 里拆 `code` / `state` / `error`        |
| `code` + `state`                            | 直接使用                                                 |
| `error` / `error_description`               | 带着原因让会话失败收尾（**不拿空 code 去换 token**）     |
| `state` 非法 / 缺失                         | `400 {status:"error", error:"invalid state"}`            |
| `state` 无 pending 会话（含已取消、已过期） | `400 {status:"error", error:"unknown or expired state"}` |
| 成功                                        | `200 text/html`（「授权完成，可以关闭此页」）            |

对齐参考项目 `oauth_callback.go:46-138`。

### 3.3 宽容解析规格（新增）

落在 `packages/core/src/credentials/oauth/parse-callback.ts`，**纯函数、无 IO**，可直接单测。逐条对齐 `misc/oauth.go:53-126`：

| 输入形态        | 例子                                                 | 处理                        |
| --------------- | ---------------------------------------------------- | --------------------------- |
| 完整 URL        | `http://localhost:1455/auth/callback?code=C&state=S` | 直接解析                    |
| 裸 query        | `?code=C&state=S`                                    | 前面补 `http://localhost`   |
| 裸 path         | `auth/callback?code=C&state=S`                       | 前面补 `http://`            |
| 裸 `k=v`        | `code=C&state=S`                                     | 前面补 `http://localhost/?` |
| 裸 `code#state` | `C#S`                                                | 拆 `#`（Claude 形态）       |
| 仅有 fragment   | `http://x/cb#code=C&state=S`                         | 从 fragment 补              |
| 仅 `error`      | `?error=access_denied`                               | 当失败处理                  |
| 空串            | `''`                                                 | 返回 `null`                 |
| 畸形（都不像）  | `not a url`                                          | 返回 `null`                 |

### 3.4 `state` 的来源：**UI 显式回传优先**

参考项目 TUI 提交的是 `{provider, redirect_url, state: m.authState}`（`oauth_tab.go:372-376`）—— **state 来自 UI 自己记住的会话**，不是从 URL 里抠。

我方照此：面板在 pending 期间已持有 `state`，提交时**优先显式带上**；`redirect_url` 解析出的 state 仅作兜底。

这消除了一类真实故障：某些回跳 URL 里的 state 可能被编码或截断，从 URL 抠会失败，而 UI 手里那份永远是对的。

### 3.5 自动轨：SSH 端口转发（文档级交付，不改代码）

仓库里有**两条**远程部署路径，都要覆盖：

**(a) Docker（`docker-compose.yml`）** —— 回调监听器在**容器内**绑 `::`，所以需要把三个端口从宿主回环映射进容器：

```yaml
ports:
  - '11435:11435'
  # 仅在本机回环发布：OAuth 回调只能在登录期间用，且监听器不鉴权
  - '127.0.0.1:1455:1455'
  - '127.0.0.1:54545:54545'
  - '127.0.0.1:51121:51121'
```

**(b) 服务器模式（`docs/SERVER_MODE.md`：Tailscale + Nginx + systemd）** —— 该文的原则是「**FreeModelFinder 不会监听 `0.0.0.0`**」，管理面板经 Tailscale 私有 HTTPS 到达，监听器直接在宿主上，无需端口映射。

两种模式下，从**自己的笔记本**建隧道即可让回调抵达服务器：

```bash
ssh -L 1455:127.0.0.1:1455 \
    -L 54545:127.0.0.1:54545 \
    -L 51121:127.0.0.1:51121 <user>@<server>
```

接上后照常点「打开浏览器登录」，回调经隧道抵达服务器，**全自动、无需粘贴**。

**安全要求（写进文档，不靠自觉）**：

- 这三个端口**只能绑宿主回环**（`127.0.0.1:` 前缀）。**绝不暴露到公网** —— 回调监听器不做鉴权，谁连上都能投递（拿不到正确 `state` 就落不了账号，但没有任何理由把它开着）。
- 映射写成**注释形式**放进 `docker-compose.yml`，保持默认 `docker compose up` 行为不变（登录时才临时打开）。

**未决问题（实施期用实测决定，不猜）**：能否在面板上**自动判断**「浏览器与网关不同机、请走手动轨 / 隧道」，从而主动提示而不是让用户干等超时？

- 候选判据：`/oauth/callback` 收到过请求说明自动轨可用；或 `auth-url` 响应里带一个探测标记。
- 已知难点：回调是**上游重定向浏览器**发出的，不经过我们的 fetch 层，所以「从浏览器侧探测」拿不到；只能靠**服务端是否收到过回调**来事后判断，而那已经太晚。
- 因此**默认方案 = 无条件同时给出手动粘贴框 + 折叠的隧道指引**（零错误提示的形状），不引入探测。若实施期发现可靠判据，再改进；**不为此编造机制**。

### 3.6 与参考项目的偏差（明确记录，避免「假对齐」）

① **不做 `callbackForwarder`**：参考项目的回调端口属于**另一个进程**，必须把 code 交给管理服务（`auth_files_oauth_callback.go:41-99` → `server_routes.go:153/169/185`）。我方监听器与网关**同进程**，收到回调就地收尾，转发器是冗余的。功能等价，实现更小。
② **`GET oauth/callback` 额外接受 `redirect_url`**：参考项目的 `GET` 只读 `provider/code/state/error` 四个 query（`oauth_callback.go:36-44`）。我方 `GET` 也读 `redirect_url`，是**超集**，保留。
③ **`error` / `error_description` 不做归一**：参考项目把后者提升为前者（`misc/oauth.go:110-113`）；我方 `error` 优先、`error_description` 兜底。
④ **粘贴入口在 Web 面板**：参考项目对应物在 TUI / CLI（`oauth_tab.go`、`sdk/auth/codex.go:113-127`）。它的 WebUI 是单独下载资产，不在本快照内。

---

## 4. 逐家差异

三家的差异本体在第二波已确立（端口 / 路径 / PKCE / 取 email 方式）。**手动回调是三家共用的兜底轨**，对三家一视同仁 —— 这本身也是参考项目的做法（同一个 handler 服务所有 provider）。

但**用户粘出来的内容逐家不同**，面板提示必须逐家准确：

| provider | 地址栏里会看到                                             | 备注                            |
| -------- | ---------------------------------------------------------- | ------------------------------- |
| Codex    | `http://localhost:1455/auth/callback?code=...&state=...`   | —                               |
| Claude   | `http://localhost:54545/callback?code=...&state=...`       | 个别情况下 `code` 后带 `#state` |
| Google   | `http://localhost:51121/oauth-callback?code=...&state=...` | 无 PKCE                         |

---

## 5. UI 设计（逐家弹窗内新增一块）

三家弹窗（`SubscriptionProviderDialog.tsx`）在 `phase === 'waiting'` 时新增「手动回调」区块 —— 对齐参考项目「发起登录后立刻可粘贴」的时序：

1. 说明文案：远程部署时浏览器与本机不同机，回调会打不开；把**浏览器地址栏那一整条 URL** 复制到这里。
2. 输入框：`data-testid=subscription-callback-url-<provider>`，粘贴回调整条 URL **或** 授权码本身。
3. 提交按钮：`data-testid=subscription-callback-submit-<provider>`，带 busy 态；提交成功后**立刻补一次轮询**。
4. 折叠的隧道指引（`<details>`，默认收起）：§3.5 的 `ssh -L` 命令。
5. 提交失败 → 复用现有错误展示（`describeOAuthError`），并**留在 `waiting`**（会话不退出，允许重贴）。

**响应契约（两种形状，别搞混）**：成功 → `200 text/html`（「授权完成，可以关闭此页」）；失败 → `400 application/json` `{status:"error", error:"<原因>"}`。所以面板必须**先看 `response.ok`**：成功即当成功（body 是 HTML，**不能 `response.json()`**）；失败才去 `response.json()` 取 `error`，解析不出再回落 `response.text()`，两种情况都过 `redactSecrets` 后展示。

**时序与不变式**：该区块只在 `phase === 'waiting'` 出现，而 `waiting` 只在 `auth-url` 成功、UI 已持有 `state` 之后进入。所以**提交时 `state` 必然在手**（§3.4），不存在「有粘贴框但没有会话」的状态。

**为什么复用同一个端点而不是新开一个**：多一条分支就多一个「用户点了取消、账号却冒出来」的机会。两条轨走同一个 `callbackHandler`，校验与失败路径才能保证完全一致。

---

## 6. 测试策略（每项都可执行）

TDD：先写失败测试再实现。

1. **解析器单测（core）**：§3.3 表格的 9 种输入形态逐一断言；含 `code#state`、fragment 兜底、空串。
2. **路由契约测试（server）**：
   - `POST /oauth/callback` 收 `{redirect_url}` → 推进会话 → 落账号（已有测试，**扩充到裸 `code=..` 与裸 `code#state` 形态**）；
   - `POST` 收 `{code, state}`（不带 URL）；
   - `POST` 收 `{state, error}` → 会话 `error` 且**账号表不变**；
   - 拿**已取消**的 state 提交 → `400 unknown or expired state`，账号表不变；
   - 拿**已过期**（sweep 后）的 state 提交 → 同上。
3. **UI 测试（vitest + msw）**：
   - `waiting` 阶段渲染粘贴框与提交按钮；
   - 提交成功 → 继续轮询到 `ok`；
   - 提交返回 `400` → 显示错误、**仍在 `waiting`**、可再次提交；
   - 取消后粘贴框消失。
4. **回归门禁（串行！）**：`format:check` → `lint` → `build:runtime` → `typecheck` → `test:coverage`（`build:runtime` 内含 tsup `clean:true`，并发会清空 dist）。

---

## 7. 验收

- 全部单测 / 契约测试绿，覆盖率不降（core 85% 行、server 80% 行、cli 80% 行、ui 无阈值）。
- **真机（等价环境）**：让浏览器与网关不同机 —— 本机浏览器 + 网关监听非回环地址（或 Docker 起在另一端口）—— 走通：发起登录 → 授权 → 复制地址栏 URL → 粘贴 → 账号出现在列表。
- 若当日网络/地域仍不允许（第二波已实测：Codex 地域受限、Claude 403、Google 本机连不通），则**退化为用伪造 code 验证到 token 端点**，证明「code 被正确取出并送达换 token」，并如实记录 —— 明确写成「未完成真实账号端到端」，不含糊过去。

---

## 8. 风险

| 风险                                         | 缓解                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 用户粘的是「授权页地址」而非「回跳地址」     | 解析失败给明确文案；提示里强调「地址栏里带 `code=` 的那条」                                                    |
| 手动提交与 10 分钟超时竞争                   | 失败不退会话、可重贴；超时文案引导重新发起                                                                     |
| 远程下固定端口被公网扫到                     | 文档强制 `-p 127.0.0.1:...`、不暴露；监听器只认 `state`                                                        |
| 远程下 `~/.codex/auth.json` 在服务器上不存在 | 文件导入的「选择文件」走浏览器读文件、不受影响（第二波已如此）；文档说明「自动探测默认路径」是**服务器**的路径 |

---

## 9. 交付物清单

| 文件                                                                   | 变更                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/core/src/credentials/oauth/parse-callback.ts`                | 新增（宽容解析，纯函数）                                                  |
| `packages/core/src/index.ts`                                           | 在 §「credentials/oauth」导出组里补一行具名导出（本仓不使用目录 barrel）  |
| `packages/core/src/credentials/oauth/__tests__/parse-callback.test.ts` | 新增                                                                      |
| `packages/server/src/routes/subscription-oauth.ts`                     | `readCallback` 换用新解析器                                               |
| `packages/server/src/routes/__tests__/subscription-oauth.test.ts`      | 扩充形态用例                                                              |
| `packages/ui/app/components/SubscriptionProviderDialog.tsx`            | 新增「手动回调」区块                                                      |
| `packages/ui/app/components/__tests__/subscription-panel.test.tsx`     | 新增 4 条用例                                                             |
| `packages/ui/app/i18n.tsx`                                             | 新增文案（中/英）                                                         |
| `docker-compose.yml`                                                   | **注释形式**补上三个端口映射示例（默认行为不变）                          |
| `docs/SERVER_MODE.md`                                                  | 新增「订阅账号的 OAuth 登录」小节：两种部署形态 + 隧道命令 + 端口安全要求 |
| `docs/USAGE.md`                                                        | 订阅账号小节补「远程部署」说明（若该文档已有对应小节）                    |
