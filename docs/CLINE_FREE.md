# 从 cline-free 迁移到内置 Cline Provider

FreeModelFinder 现在把 Cline 作为**一等内置 Provider**：不再需要在本机跑 `cline-free` 反代进程，
也不需要手填 `sk-cline-*` 占位 Key——在 Dashboard 的 Cline 平台卡片里用**设备码登录**自己的 Cline
账号，凭据加密保存在本机，网关直接用 Cline 的免费额度。

本文是旧的「cline-free sidecar + 自定义来源」接入方式的**迁移说明**，同时覆盖新方式的用法。

## 一、内置的 4 个模型怎么用

Cline 卡片启用且池内至少有一个可用账号后，模型目录会多出 4 个内置模型（`GET /v1/models` 可见）：

| 对外模型 ID                            | 显示名                           |
| -------------------------------------- | -------------------------------- |
| `cline:cline-free/deepseek-v4.1-flash` | `cline-free/deepseek-v4.1-flash` |
| `cline:deepseek/deepseek-v4-flash`     | `deepseek/deepseek-v4-flash`     |
| `cline:z-ai/glm-5.3-flash`             | `z-ai/glm-5.3-flash`             |
| `cline:poolside/laguna-s-2.1:free`     | `poolside/laguna-s-2.1:free`     |

- 对外规范 ID 恒为 `cline:<上游原生 ID>`，标记为 `free: true`、能力为文本。
- **设为默认模型**：设置页「当前模型」区块选择，或 `fmf model use cline:cline-free/deepseek-v4.1-flash`。
- **参与自动路由**：启用 `auto` 后，这 4 个模型会进入聚合池成为候选，池内限流/失败会先换号，
  池尽再由自动路由切到其他候选。
- **粘贴裸上游名也认**：`cline-free/...`、`cline/...`、`cline-pass/...` 形式的模型名会被启发式
  路由到 Cline（模型 ID 原样发给上游）；若 Cline 未启用或无可用账号，则按既有启发式回退。
- 无需 API Key：Cline 走账号凭据（refreshToken），不走 `credentials.apiKey`，网关不会要求补 Key。

### 模型清单动态同步

除上述 4 个内置模型外，Cline 卡片默认还会**动态同步上游的免费模型**：网关从上游
`recommended-models` 端点的 `free` 分组拉取清单，与内置 4 个**取并集**（按上游原生 ID 去重，
内置 4 个始终保留），一并出现在 `GET /v1/models` 与设置页的模型选择里。同步到的新模型同样标记
`free: true`、对外 ID 为 `cline:<上游原生 ID>`，用法与内置模型完全一致。

- **可在设置里关闭**：Cline 卡片的勾选框「动态同步上游免费模型」（默认勾选）。关闭后模型清单
  只保留内置 4 个，不再访问上游。
- **刷新节奏对用户透明**：清单**惰性刷新**（读取模型列表时按需同步）+ **30 分钟**内存缓存；
  网关不做后台定时轮询，缓存随重启清空。
- **上游不可用时不影响使用**：断网或上游异常时自动**退回上一次同步到的清单**；进程刚启动、
  还没有任何缓存时则**退回内置 4 个**。模型列表接口**不会因为网络问题报错**——故障期间只要
  有人读取列表且缓存已过期，就会周期性重试。

## 二、登录流程（设置 → 来源设置 → Cline 平台卡片）

1. 打开 Dashboard **设置 → 来源设置**，找到 **Cline** 卡片（提示文案：免 API Key，凭据只保存在本机）。
2. 点 **登录 Cline 账号**，面板显示：
   - **验证码**（可一键复制）与 **打开授权页** 链接（上游固定授权域名）；
   - **有效期倒计时**（有效期由上游授权会话给出）。
3. 在授权页用 Cline 账号确认授权。面板每 **2.5 秒**轮询一次登录结果：
   - `pending` → 继续等待；
   - `complete` → 提示「登录成功：<账号>」，**自动勾选「启用 Cline」**（若自动启用失败，
     会提示 `已登录，但自动启用失败，请手动勾选「启用 Cline」`），随后刷新配置，
     卡片徽章变为 **已配置**；
   - `expired` → 「授权已过期，请重试」；`denied` → 「授权被拒绝，请重试」；两者都可**重试**。
4. **多账号**：点「登录其他账号」重复上述流程，账号会进同一个池子轮换。
5. 中途可点 **取消登录**；关掉页面即停止轮询，服务端 flow 只存在网关内存、到期自动作废（无后台任务）。

相关管理 API（与既有 `/api/*` 一样受本地 UI origin 门禁保护）：

```text
POST /api/cline/login/start                        → { flowId, code, userUrl, expiresAt }
POST /api/cline/login/poll        ← { flowId }     → pending | complete | expired | denied
GET  /api/cline/accounts                           → 账号列表（状态/冷却/用量，不含 refreshToken）
POST /api/cline/accounts/:id/cooldowns/clear       → { cleared }
POST /api/cline/accounts/:id/logout                → { ok }
```

## 三、账号池、冷却与换号语义

**账号池**

- 一个平台可挂多个账号；取号策略默认 `round_robin`，可在 `config.json` 的
  `credentials.cline.strategy` 改为 `fill` / `random`；`cooldownFallbackMinutes` 可改冷却兜底分钟数。
- 面板逐账号展示：状态徽章（`可用` / `需重新登录`）、冷却倒计时、添加时间、最近使用、
  用量摘要（请求 / 输入 / 输出 tokens）与最近一次错误（已脱敏）。

**冷却（限流退避）**

- 粒度是 **账号 × 模型**：同一账号在 A 模型被限流，不影响它在 B 模型上的请求。
- 429 的恢复时刻按 **Retry-After 头 > 明确字段 > 文本时长 > 兜底分钟**（默认 5 分钟）解析，
  单条冷却上限 24 小时；上游返回 200 但内容为空时，该账号该模型冷却 **30 秒**再换号重试。
- 冷却只存在内存里，**网关重启会丢**（属预期：重启后立刻再撞 429 很正常）。
- 面板可对单个账号点 **解除冷却**（立即清掉该账号的冷却条目）。

**换号**

- 单个请求最多换 **3 个账号**（且不超过池大小），已尝试过的账号不会重复尝试。
- 会触发换号：429（限流）、401/403（凭据失效，同时把该账号标成 `需重新登录`）、网络错误与 5xx。
- 不换号：400（模型名等账号无关错误，直接报错，避免把配置错误放大成账号雪崩）、
  流式响应中途断开（不可重放，错误原样透传）。
- 刷新端点（refreshToken → accessToken）遇到网络错误/5xx **不判失效**，防止误杀账号；
  access token 内存缓存、过期前刷新，且并发请求共享同一次刷新（防刷新风暴）。

**池尽与自动路由**

- 所有账号都在冷却 → 抛出 `cline failed 429 rate limit: all <N> accounts are cooling for <模型>, reset at <ISO>`。
- 若开启自动路由，这个 429 会升级成**模型级冷却**并 failover 到其他候选（关闭自动路由时，
  显式 `cline:` 请求只做池内换号、不做跨 provider 兜底；池内换号不受自动路由开关影响）。
- 所有账号都失效 → `cline failed <状态码>: <N> 个账号凭据失效，请重新登录`。

## 四、API 示例

```bash
# 列出模型（含 cline:*）
curl http://127.0.0.1:11435/v1/models \
  -H "authorization: Bearer <网关 API Key（开启强制鉴权时）>"

# 非流式
curl http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer <网关 API Key（开启强制鉴权时）>" \
  -d '{
    "model": "cline:cline-free/deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "hi"}]
  }'

# 流式
curl -N http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer <网关 API Key（开启强制鉴权时）>" \
  -d '{"model":"cline:deepseek/deepseek-v4-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

Anthropic `/v1/messages` 与 Gemini `/v1beta/...` 端点同样可用（协议转换由网关既有协议层完成），
把 `model` 换成上表的 `cline:*` 即可。

## 五、与旧的裸 token / cline-free 接入方式的区别

| 维度         | 旧方式：cline-free sidecar + 自定义来源                                         | 新方式：内置 Cline Provider                                                                            |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 运行前提     | 本机常驻 `cline-free` 进程（`http://localhost:8787/v1`），进程/端口出问题就全挂 | 网关本体能力，无额外进程                                                                               |
| 凭据         | 手填 `sk-cline-*` 占位 Key（或把裸 token 配在来源里）                           | 无 API Key；页面内设备码登录，refreshToken 保存在本机                                                  |
| 落盘         | 由 cline-free / 自定义来源自行保存                                              | `config.json` 的 `credentials.cline`，写盘前用本机 `master.key` 加密（`v3:` 密文），API 与日志均不回显 |
| 模型 ID      | 手填模型列表，对外形如 `custom:<来源>:<模型>`                                   | 内置 4 个模型，对外 `cline:<上游原生 ID>`，无需手填                                                    |
| 多账号与退避 | 单实例能力，限流行为由 sidecar 决定                                             | 账号池轮换 + 账号×模型冷却 + 单请求最多换 3 个号 + 池尽冒泡/自动路由                                   |
| 可观测       | 看不到用量与冷却                                                                | 面板内可见每账号用量、冷却倒计时、最近错误（脱敏）                                                     |

**迁移步骤**

1. 在设置的**自定义来源**里删除指向 `http://localhost:8787/v1` 的那条来源（模型 ID 形如
   `custom:<来源>:<模型>` 的引用会一并失效）；
2. 停掉 cline-free 进程（`8787` 端口不再需要；继续跑也不影响，但会与内置 Provider 重复消耗额度）；
3. 在 Cline 平台卡片点**登录 Cline 账号**完成设备码授权，确认卡片徽章变为**已配置**；
4. 把默认模型/自动路由里的旧 `custom:...` 模型换成 `cline:...`。
   迁移期间直接粘贴 `cline-free/...` 这类裸上游名也能命中 Cline。

## 六、常见问题

### 一直 429，换号也救不回来

单个请求最多换 3 个账号，池子小或全被限流时会直接抛 429（报错里带整池最早的恢复时刻）。
处理办法：等冷却结束、在面板点**解除冷却**、多登录几个账号扩大池子，或开启自动路由让请求切到
其他来源。全部账号标成「需重新登录」时则不是限流问题，见下一条。

### 提示「N 个账号凭据失效，请重新登录」/ 徽章是「需重新登录」

refreshToken 被上游判定失效（授权撤销、过期、账号异常）时，该账号状态会持久化为 `invalid`，
不会自动恢复——重新走一遍设备码登录即可；不需要的账号可直接**登出**（删除其凭据条目）。
刷新端点的网络错误/5xx 不会判失效，不用担心网络抖动误杀账号。

### 免费额度是多少？会不会突然收费/改规则

免费额度、限速和可用模型完全由 Cline 上游决定，随时可能变化，网关只能感知到 429 与错误体，
按上文的冷却/换号策略退避。协议层移植自 `cline-free`（MIT，源码注释有标注），上游接口或额度
规则调整后可能需要更新网关版本。用量摘要只统计经过网关的请求，配额口径以上游为准。

### 迁移后老模型找不到 / 默认模型失效

旧的自定义来源删除后，`custom:<来源>:<模型>` 就不存在了，需要重新设置默认模型与自动路由候选，
或改用 `cline:<上游原生 ID>`。粘贴 `cline-free/...`、`cline/...`、`cline-pass/...` 裸名会路由到
Cline（前提是 Cline 已启用且池内有可用账号）。

### 冷却/用量在重启后清零

冷却态只在内存（避免 429 高频写盘），重启即丢；用量统计落在
`~/.freemodelfinder/credentials-usage.json`（随 `FREEMODELFINDER_HOME` 覆盖），重启不清零。

### 凭据安全吗

refreshToken 仅在本机 `config.json` 内以 `v3:` 密文保存，只在内存中解密使用；`GET /api/cline/accounts`
与 `/api/config` 都不会回显它，错误信息统一过脱敏层（掩掉 `Bearer *`、`refresh_token=*` 与长 base64）。
管理端 `/api/cline/*` 与既有 `/api/*` 一样受本地 UI origin 门禁保护，网关监听默认仍是 `127.0.0.1`。
