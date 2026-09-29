# OpenCode Zen 集成设计（完全对齐 opencode2api 能力）

日期：2026-09-29
状态：已批准（设计经用户逐节确认，共 6 节 + 移植形态与范围两项前置决策）

## 背景

[5575xyx/opencode2api](https://github.com/5575xyx/opencode2api) 是一个 Go 实现的 OpenCode Zen / Zen Go API 网关：对外暴露 Chat Completions、Responses、Anthropic Messages 三种协议，对内按**每个模型各自的原生协议**转发到 `https://opencode.ai/zen` 与 `https://opencode.ai/zen/go`，并内置匿名通道（`Bearer public`）、双 Key 池、代理池、模型动态发现与定价。

本设计要把它的能力集成进 FreeModelFinder，使其成为 FMF 的又一个 provider（`opencode`）。用户指令为**全局指令：能力全面对齐 opencode2api**，即以 opencode2api 的功能集为规格，而不是取其子集。

FMF 侧现状（已核实）：

- 17 个 provider 全部继承 `OpenAICompatibleProvider`，**上游只有 OpenAI Chat 一种协议**（`packages/core/src/providers/openai-compatible.ts:34`）。
- 全仓 `opencode` / `zen` **零命中**，无半成品代码或配置占位。
- 唯一的 keyless 先例是 `cline.ts` 的 `hasCredentials()` 钩子。
- 网关入站为 OpenAI / Anthropic / Gemini 三协议，内部统一成 `ChatRequest`。

## 需求决策（用户拍板）

| #   | 决策项                               | 结论                                                                                                    |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | 协议覆盖范围                         | **三协议全量**（chat / responses / anthropic），对齐 opencode2api                                       |
| 2   | 「完全按照 opencode2api 实现」的范围 | **全局指令**，推翻先前的分项精简选择，能力全面对齐                                                      |
| 3   | 移植形态                             | **方案 A：新增独立 workspace package `@freemodelfinder/zen`**，core 内只放薄壳 provider                 |
| 4   | 匿名 / Key 通道关系                  | **匿名优先，失败回退 Key**（照 opencode2api 路由顺序）                                                  |
| 5   | 模型清单                             | **纯动态拉取**（`/v1/models` + 能力目录 + 定价目录）                                                    |
| 6   | Tier 范围                            | **Zen + Go 两个 tier 都做**（全局对齐指令覆盖了早先的「只做 Zen」）                                     |
| 7   | 协议转换深度                         | **完整转换：文本 + 工具 + reasoning + 图片**                                                            |
| 8   | 匿名通道启用方式                     | **加显式「匿名通道」开关**（provider 卡片 toggle，默认关）                                              |
| 9   | 代理 / 出口轮换                      | **完整复刻 opencode2api 代理池**（健康检查 + 指数冷却 + 会话亲和 + **SOCKS5 一次性做完**）              |
| 10  | 内部消息模型前置改造                 | **P0 做全，三条入站协议与三条出站序列化全部接通**                                                       |
| 11  | 中间表示策略                         | **结构化主干 + `raw` 旁路**（同协议透传零损，跨协议结构化桥接）                                         |
| 12  | 路由状态机                           | **完全对齐 opencode2api**（含指数冷却、per-tier 重编码、ctx 超时闸门、`ses_` 规范化）                   |
| 13  | UI 与诊断                            | 设置页照 cline 专属面板模式；**WebUI / Playground / 独立管理端不移植**，但 **attempt 级记录在包内保留** |

## 上游实测事实（硬约束，2026-09-29 实打真实上游验证）

以下每一条都经过实际 HTTP 请求确认，是实现必须遵守的契约：

| 约束                | 实测结果                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 匿名凭证            | `Authorization: Bearer public` → HTTP 200 ✅                                                                                                                                                                  |
| **User-Agent**      | 必须形如 `opencode/1.18.31 (win32 amd64; go1.24.0)`。Node/浏览器默认 UA → HTTP 403 `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}` |
| **Session ID 形状** | 必须 `ses_` + 12 位小写 hex + 14 位 base62（正则 `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`），否则 403                                                                                                              |
| **请求体形状**      | 必须 `stream: true` + 携带核心 agent 工具（`bash` / `edit` / `glob` / `grep` / `read`），否则 403 `FreeTierError`                                                                                             |
| Chat 流式 usage     | 需 `stream_options.include_usage: true` 才返回最终 usage 事件                                                                                                                                                 |
| 匿名模型列表        | `GET /v1/models`（匿名）→ 200，83 个模型，其中名字含 `free` 的约 11 个                                                                                                                                        |
| Anthropic 端点      | `POST /v1/messages`，头 `x-api-key` + `anthropic-version: 2023-06-01`；对不在匿名目录中的模型回 401 `ModelError: Model not supported`                                                                         |
| Responses 端点      | `POST /v1/responses` 协议本身可用；本机出口触发 `403 RegionError: This model is not available in your country.`（地区限制，需代理）                                                                           |
| 协议归属来源        | `https://models.opencode.ai/api.json` 的 `npm` 字段：`@ai-sdk/openai-compatible`→chat、`@ai-sdk/anthropic`→messages、`@ai-sdk/openai`→responses                                                               |
| 双 tier             | `https://opencode.ai/zen` 与 `https://opencode.ai/zen/go` 模型列表独立；部分 free 模型只在 Go 侧                                                                                                              |

> 上游识别「是否 OpenCode 客户端」的**决定性信号是 User-Agent**，其次是 session 形状与 agent 形状请求体。三者缺一即 403。

## 架构总览

实施分两个阶段，**P0 是 P1 的硬前置**：

```
阶段 P0（全仓前置）：内部消息模型扩展到支持 tools / tool_calls / reasoning
  影响 packages/core/types.ts、packages/core/protocols/*、packages/server/routes/*
  现有 17 个 provider 行为不变（新增字段全部 optional，缺省即现状）

阶段 P1（主体）：新增 packages/zen，按 Go 原结构 1:1 移植 opencode2api 能力
  packages/core/src/providers/zen.ts 只做薄壳委托
```

### 包结构

```
packages/zen/                      新增 @freemodelfinder/zen（纯逻辑，无 UI）
  src/
    config/      zod schema 与校验（对应 internal/config）
    gateway/     路由状态机、tier 编排、重试、上游请求（internal/gateway）
      anonymous.ts   匿名 body 形变（prepareAnonymousBody / shapeKeyBody）
      upstream.ts    doUpstreamTiers / doAnonymousUpstream / doKeyUpstream
      pool.ts        key 节点池、游标、冷却
      refresh.ts     周期刷新编排
      runtime.ts     Gateway 运行时装配与热切换
      monitor.ts     attempt 级记录
    protocol/    三协议双向转换 + SSE（internal/protocol）
      types.ts       Protocol 枚举与 Path()
      request.ts     PrepareRequest / ConvertRequest / ForcedEffort
      bridge.ts      跨协议中间结构
      content.ts     内容块（文本 / 图片 / 工具）转换
      response.ts    响应转换
      stream.ts      SSE 解析、重发、非流式折叠（collapse）
    models/      目录发现、协议归属、定价（internal/models）
      catalog.ts     Route()、匿名资格、per-tier 协议
      discovery.ts   /v1/models + models.opencode.ai + 文档回退
      pricing.ts     models.dev 抓取与 Decide()
      cache.ts       磁盘缓存
    identity/    session 规范化与请求标识（internal/identity）
    proxy/       代理池、绑定、健康复查（internal/gateway/pool.go 的代理部分 + health.go）
    http.ts      ZenHttpClient 端口 + 生产实现（node:http/https + *-proxy-agent）

packages/core/src/providers/zen.ts  薄壳：implements BaseProvider，委托 ZenGateway
```

### 建议阅读顺序（对应 opencode2api README）

1. `gateway/upstream.ts` → 请求如何在匿名 / Key / Tier 间流动
2. `protocol/request.ts` + `bridge.ts` → 请求如何被编码到目标协议
3. `models/catalog.ts` → 模型如何被路由
4. `providers/zen.ts` → FMF 如何消费以上能力

## 阶段 P0：内部消息模型扩展

### 缺口事实（已核实）

| 位置                                                   | 现状                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `ChatRequestSchema`（`packages/core/src/types.ts:60`） | 只有 `messages / temperature / top_p / max_tokens / stream / stop`，**无 `tools`** |
| `ChatMessage.content`（`types.ts:47`）                 | `string`，**无 `tool_calls`**                                                      |
| `ChatResponse` / `StreamChunk`（`types.ts:68-90`）     | **无 `tool_calls` 增量、无 `reasoning`**                                           |
| `finish_reason` 枚举                                   | 含 `'tool_calls'`，但无任何结构可承载                                              |
| 全仓 grep `tools\|tool_calls`                          | `packages/server` 仅一行注释；`packages/core` 仅上述枚举与 cline 常量              |

结论：入站 `tools` 在 `openAIToChatRequest()`（`packages/core/src/protocols/openai.ts:53`）即被丢弃，客户端的 agent 定义到不了 provider。**P0 不做，P1 的工具调用转换写得再正确也无法端到端工作。**

### P0 改动清单

1. **`packages/core/src/types.ts`**（全部 optional，缺省即现状）
   - `ChatRequest.tools?: ToolDefinition[]`、`ChatRequest.raw?: unknown`（见中间表示节）
   - `ChatMessage.tool_calls?: ToolCall[]`（`role: 'assistant'` 时）
   - `ChatMessage.reasoning?: string`（可选透传）
   - `ChatResponse.tool_calls?: ToolCall[]`、`ChatResponse.reasoning?: string`
   - `StreamChunk.tool_calls?: ToolCallDelta[]`、`StreamChunk.reasoning?: string`
   - `ToolDefinition` 支持 OpenAI 形（`type:'function', function:{...}`）与 Anthropic 形（`name/description/input_schema`）—— 由各协议层负责互转，中间表示统一用一种（选 OpenAI 形，与入站主流一致）
2. **三条入站转换**（`packages/core/src/protocols/{openai,anthropic,gemini}.ts`）
   - `openAIToChatRequest` 保留 `tools`，并把原始 body 挂到 `raw`
   - `anthropicToChatRequest` 保留 `tools`（含 `input_schema`）与 `tool_use` / `tool_result` 内容块
   - `geminiToChatRequest` 保留 `functionDeclarations` 与 `functionCall` / `functionResponse`
3. **三条出站序列化**
   - OpenAI：`tool_calls` → `message.tool_calls`，`finish_reason: 'tool_calls'`
   - Anthropic：`tool_use` 内容块 / `tool_result` 回填，`stop_reason: 'tool_use'`
   - Gemini：`functionCall` / `functionResponse`
4. **SSE 增量**：三协议的流式 handler 需识别并转发 `tool_calls` 与 `reasoning` 增量；`delta` 之外的字段不得丢失
5. **回归保障**：所有既有 provider 测试必须原样通过（新字段 optional 是硬要求）

> P0 完成后，**全部 17 个既有 provider 顺带获得工具调用能力**（凡是上游本来就返回 `tool_calls` 的，此前被静默丢弃）。

## 中间表示策略（结构化主干 + raw 旁路）

opencode2api 的转换层是「任意 JSON 进、任意 JSON 出」（`map[string]any`，约 3800 行 Go），因为其入站与出站都是三协议。FMF 的中间层是类型化的 `ChatRequest`。两者最根本的结构冲突必须显式处理。

opencode2api 的两条保真规则（`internal/protocol/request.go:17` `PrepareRequest`）：

1. **同协议**请求原样克隆透传，供应商特有字段（Anthropic `thinking`、Responses `reasoning` items 等）全部保留；
2. **跨协议**才走结构化桥接，允许有损。

若把一切都压进 `ChatRequest`，规则 1 即失效。因此采用：

```
入站 OpenAI/Anthropic/Gemini body
   │
   ├─→ 结构化: ChatRequest（P0 扩展后含 tools / tool_calls / reasoning / 图片）
   └─→ 旁路:   ChatRequest.raw = 原始 body（optional，仅 zen 读）
                    │
        ┌───────────┴────────────┐
   同协议？                   跨协议？
   是 → raw 仅改 model 后发出    否 → 按目标协议从 ChatRequest 编码
   （零信息损失）                （有损桥接，与 opencode2api 一致）
                    │
              上游响应 / SSE
                    │
        ┌───────────┴────────────┐
   同协议？                   跨协议？
   raw 直接回流                解码为 ChatResponse / StreamChunk
                    │
              出站按客户端入站协议序列化
```

约束：

- `raw` 是 `ChatRequest` 上的 **optional 字段**，其他 17 个 provider 完全忽略，不破坏现有抽象；
- auto-router、配额、调用日志、`onUsage` 只读结构化字段，全部照常工作；
- `raw` 只在「入站协议 == 目标 tier 原生协议」时启用；不满足则丢弃 `raw` 走结构化路径。

### 模块与 Go 源文件对应

| opencode2api 源文件                                                             | 行数 | 落到 `packages/zen/src/`                       |
| ------------------------------------------------------------------------------- | ---- | ---------------------------------------------- |
| `protocol/request.go` + `bridge.go`                                             | 1476 | `protocol/request.ts`（含 `ForcedEffort`）     |
| `protocol/response.go` + `content.go`                                           | 831  | `protocol/response.ts`                         |
| `protocol/stream.go` + `stream_parser.go` + `stream_emitter.go` + `collapse.go` | 1443 | `protocol/stream.ts`                           |
| `protocol/protocol.go` + `errors.go`                                            | 45   | `protocol/types.ts`                            |
| `gateway/upstream.go`                                                           | 782  | `gateway/upstream.ts` + `gateway/anonymous.ts` |
| `gateway/{pool,health,refresh,runtime,gateway}.go`                              | 1639 | `gateway/{pool,refresh,runtime}.ts`            |
| `models/{catalog,discovery,pricing,cache}.go`                                   | 1382 | `models/{catalog,discovery,pricing,cache}.ts`  |
| `identity/request.go`                                                           | ~180 | `identity/session.ts`                          |
| `config/*.go`（除 password/persistence）                                        | ~600 | `config/index.ts`（zod schema）                |

## 路由与通道状态机

对应 `internal/gateway/upstream.go`（782 行）与 `internal/models/catalog.go` 的 `Route()`。

### 路由决策（每次请求）

```
Catalog.Route(model, hasZenKeys, hasGoKeys, hasAnonymous)
  │
  ├─ 匿名资格 = pricing.Decide(model)
  │    = 名字含 "free"（不区分大小写）
  │      OR（models.dev 输入与输出成本均为 0 且未弃用）
  │    且模型未被标 unsupported 且存在于当前目录
  │
  ├─ 匿名可用 → Route{ Tier: zen, Anonymous: true, Protocol: protocols[zen],
  │                    KeyTiers: 按 prefer 顺序的可用认证 tier }
  │
  └─ 否则     → Route{ Tier: keyTiers[0], KeyTiers: […] }
```

- **匿名通道是 Zen-only**，即使目录只在 Go 侧声明该模型也先试 Zen；上游拒绝后进入认证回退计划。
- 只有匿名通道可用时，`/v1/models` 仅展示符合匿名条件的模型。

### 执行顺序（`doUpstreamTiers`）

1. **匿名阶段**：`Bearer public` 打 Zen，**每个可用代理最多一次**；任何失败（含 4xx/5xx）换下一个代理。成功即返回。**此阶段不受 `retry.max_attempts` 截断**，但与后续阶段共享请求总超时。
2. **认证阶段**：按 `prefer`（默认 `go`）遍历 `KeyTiers`；**每个 tier 用它自己的原生协议重新编码 body**；tier 内按 `retry.max_attempts`（默认 3，含首次）轮换 key。
3. **错误分类**：
   - 网络错误 / 认证失败 / 限流 / 5xx → 触发 key 轮换与冷却，tier 内可继续；
   - **其余 4xx → 结束当前 tier**（请求形状错误，换 key 无用），但**仍可进入下一个可用 tier**；
   - `ctx` 超时 → **立即停止**，不给从未真正尝试的 key / 代理记失败（`upstream.go` 中三处 `ctx.Err()` guard，必须逐一移植）。
4. **stale reasoning 重试**：上游回 400 且错误体同时含 `reasoning item|reasoning reference` 与 `not found|expir|does not exist|no longer` → 剥离 Responses 载荷中的 `previous_response_id` 与 `type:"reasoning"` 输入项，**重放一次**（保持客户端 session 不变以维持 prompt cache 亲和），尝试次数编号延续不重复。重试失败则返回原始错误。
5. **流开始后不再切换节点重新生成。**

### 匿名 body 形变（`gateway/anonymous.ts`）

匿名免费层**只接受 agent 形状的流式请求**，否则 403 `FreeTierError`。

- `prepareAnonymousBody(body, protocol)`：强制 `stream: true`；补齐缺失的 5 个核心工具 `bash / edit / glob / grep / read`（**仅工具名重要，网关合成最小参数定义**）；chat 协议补 `stream_options.include_usage: true`。
- `SystemOne` 载荷原样转发（决策请求不是 agent 流量，注入会被上游拒绝）。
- `shapeKeyBody(body, route, tier)`：**key 通道对 free 模型做同样形变**（上游现在对所有通道的 free 模型都要求 agent 形状），付费模型保持原 body；返回是否已改变，供网关决定是否需要把 SSE 折叠回 JSON。
- **非流式客户端折叠**：强制流式发出 → 收 SSE → 聚合为单个 JSON 响应返回客户端。

### Key 池与会话亲和

- `zen_keys` / `go_keys` 两个独立池；初始化时**均衡分配到代理**。
- 会话信号来源优先级：`x-session-id` → `x-opencode-session` → `x-session-affinity` → `conversation-id` → `conversation_id` → `metadata.session_id` → **第一条用户消息内容** → `previous_response_id` → 随机兜底。
- **全部规范化为 `ses_` + 12 hex + 14 base62**（`identity/session.ts` `canonicalSessionID`）：已合规则原样保留（维持上游 prompt cache 亲和），否则 sha256 确定性映射（前 6 字节 hex 作时间位，第 6-16 字节作 base62 随机位）。自 2026-09-16 起 Zen 免费层对非标准 session 直接 403。
- 无显式 session ID 时用第一条用户消息生成，故开场内容相同的会话可能共享亲和；调整 key 或代理池成员后原会选择的节点可能变化。
- 另发 `x-opencode-request`（`req_` + 16 hex）、`x-opencode-project`（`prj_` + 稳定 hash）、可选 `x-parent-session-id`。

### 失败冷却

- 指数增长，上限 = `performance.failure_cooldown_seconds`（默认 15）× **8**；
- 上游 `Retry-After` 更长则取更长者；
- **全部 key 都冷却时**仍尝试最早结束冷却的那个；**冷却中的匿名节点直接跳过**；
- 已标记异常的代理每 **15 分钟**经 Cloudflare trace 复查一次；
- 客户端取消 / ctx 过期**不惩罚**尚未实际使用的 key 或代理。

### 请求头契约

```
User-Agent:           opencode/1.18.31 (<os> <arch>; <go-version>)   ← 必需
x-opencode-client:    cli
x-opencode-session:   <canonical ses_...>
x-session-affinity:   <同上>
X-Session-Id:         <同上>
x-opencode-request:   req_<16hex>
x-opencode-project:   prj_<stable>
x-parent-session-id:  <可选>
Content-Type:         application/json
Accept:               application/json, text/event-stream
anthropic 协议额外:    x-api-key: <key>, anthropic-version: 2023-06-01,
                      anthropic-beta: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14
其余协议:              Authorization: Bearer <key>
```

`User-Agent` 中的版本号应做成常量，便于上游升级时单点修改。

## 代理池

对应 `internal/gateway/pool.go`（460 行）+ `health.go`（146 行）+ `internal/config/proxy.go`。

- **来源**：配置内 `proxies` 数组 + 可选 `proxyfile`；配置内先加载、再追加文件内容，**按首次出现顺序去重**。两个来源都为空时用 `["direct"]`。
- **proxyfile 格式**：每行一个地址，允许空行与注释；支持 `#`、`;`、`//` 注释标记，标记须位于行首或空白之后；相对路径基于配置文件所在目录解析。
- **类型**：`direct` / `http://` / `https://` / `socks5://` / `socks5h://`，URL 可含 `user:pass@` 认证。
- **绑定**：key 均衡分配到代理；匿名节点独立成池，按会话游标轮询。
- **健康**：真实流量触发代理检查、key 重新绑定与失败冷却；异常代理每 15 分钟复查。

### HTTP 抽象（测试可注入的关键）

`BaseProvider.ctx.fetchImpl` 是 `typeof fetch`，**不支持指定 per-proxy dispatcher**，而本设计必须按代理轮换并分别记健康。因此在 zen 包内定义自己的端口：

```ts
interface ZenHttpClient {
  send(request: ZenHttpRequest): Promise<ZenHttpResponse>;
}

interface ZenHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  proxy: ProxySpec;
  signal?: AbortSignal;
}

interface ZenHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}
```

- **生产实现（P1-A 已落地）**：`node:http` / `node:https` + `http-proxy-agent` / `https-proxy-agent` / `socks-proxy-agent`，**按目标协议而非代理协议选 agent**（https 目标恒用 `HttpsProxyAgent` 走 CONNECT；`http://` 代理访问 https 上游因此可用），agent 按 `(kind,url,target)` 缓存复用；
- **测试注入假实现** → 路由状态机、重试、冷却、代理轮换全部可离线验证；
- `ctx.fetchImpl` 仅用于 `models.opencode.ai` / `models.dev` 这类无代理语义的 GET。

> 实现偏离说明：原设计拟用 undici `request` + per-proxy dispatcher，但 undici 内置 `ProxyAgent` 仅支持 HTTP CONNECT，`socks5://` 无原生支持。改用 Node 原生 `http/https` + 三个 `*-proxy-agent` 包，可统一支持 direct / http / https / socks5 / socks5h，且 `SocksProxyAgent` 已处理 `socks5` 与 `socks5h` 的本地/远端 DNS 差异。这是 P1-A 已确认落地的实现。

### 依赖决策

**SOCKS5 本期一次性做完**（用户拍板）。最终依赖为 `socks-proxy-agent`（配合 `http-proxy-agent` / `https-proxy-agent`），已在 P1-A 锁定并写入 `packages/zen/package.json`。

## 模型发现与定价

| 来源                                  | 作用                                                                                                                             | 刷新                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `GET {zen,go}/v1/models`              | 该 tier 实际可路由的模型 ID                                                                                                      | `models.refresh_seconds`（默认 300，最小 1） |
| `https://models.opencode.ai/api.json` | **协议归属**（`provider.npm` 或 `model.provider.npm`）+ context / limit / reasoning / tool_call / structured_output / modalities | 同上                                         |
| zen / go 官方文档 `.mdx`              | 协议表**回退与覆盖**来源（上游端点更具体时优先）                                                                                 | 同上                                         |
| `https://models.dev/api.json`         | **定价与弃用** → 匿名资格判定                                                                                                    | 24 小时                                      |
| `models.protocols` 配置               | 手工强制某模型的协议（值仅允许 `chat` / `responses` / `anthropic`）                                                              | 静态                                         |

规则：

- **协议推断**：`capabilityTier(providerID, api)` 依 `opencode-go` / `/go/` 判 Go tier，`opencode` / `/zen/` 判 Zen tier；`protocolForSDK(npm)`：含 `anthropic` → messages，`@ai-sdk/openai` 或 `/openai` 结尾 → responses，`openai-compatible` → chat，其余标 unsupported。
- **per-tier 协议独立**：同一模型 Zen 可能是 chat、Go 可能是 messages。`Route.Protocols` 按 tier 各存一份，**跨 tier 重试必须重新编码**。
- **未支持协议的模型从 `/v1/models` 隐藏**，除非配了 `models.protocols` 覆盖。
- 协议优先级：配置覆盖 > 文档回退 > 能力目录 > 默认 chat（仅当目录尚未就绪）。
- **磁盘缓存**：`<configPath>.models.catalog.json` 与 `<configPath>.models.dev.json`，失败时保留旧数据。
- **stale 判定**：超过 `2 × refresh_seconds` 且不低于 60 秒 → 目录标记 stale，仍可用但整体降级。
- **目录就绪前**：`supportedLocked` 返回 true（不因发现失败让网关下线），`keyTierOrderLocked` 同样放行已配置 key。
- models.dev 解析：优先 `opencode` / `opencode-zen` / `opencode_zen` 键，其次任何含 `opencode` 的键，且该 provider 的 `id`/`name` 须含 `opencode`。

### 范围外

`/v1/systemone`（OpenCode 的结构化决策端点，非 LLM）**不在范围内**：FMF 网关入站没有对应协议，它不是聊天能力。

## 配置、UI 与接入点

### 配置落位

复用 `ProviderSettings.credentials.extra`（`Record<string, unknown>`），避免动 `AppConfig` schema：

```ts
providers.opencode = {
  enabled: boolean,
  credentials: {
    apiKey: '',                       // legacy 兼容，实际不用
    apiKeys: string[],                // → zen_keys（Zen key 池）
    extra: {
      goKeys: string[],               // → go_keys（独立池）
      anonymous: boolean,             // ← 显式「匿名通道」开关，默认 false
      prefer: 'go' | 'zen',           // 默认 'go'
      upstream: { zen: string, go: string },   // 默认见上文
      proxies: string[],
      proxyfile?: string,
      retry: { maxAttempts: 3, timeoutSeconds: 300 },
      performance: {
        attemptTimeoutSeconds: 0,     // 0 = 用请求总超时
        connectTimeoutSeconds: 5,
        failureCooldownSeconds: 15,
        maxIdleConns: 2048,
        maxIdleConnsPerHost: 256,
        maxConnsPerHost: 0,
        idleConnTimeoutSeconds: 120,
      },
      models: { refreshSeconds: 300, protocols: Record<string, 'chat'|'responses'|'anthropic'> },
      reasoning: {
        effort?: 'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'none',
        effortByModel: Record<string, string>,
      },
    },
  },
}
```

配置项语义完全沿用 opencode2api 文档；所有字段缺省时行为等同 opencode2api 默认值。

### 安全：`extra` 落盘加密缺口

`packages/core/src/config/store.ts:207` `encryptProviders()` 只加密 `apiKey`、`apiKeys`、`extra.sources[*].apiKey`（`mapCustomSourceKeys` 特化了 `sources` 结构）。**`extra` 里其他字段明文落盘**，`proxies` 中的 `user:pass@` 会裸奔。

必须：扩展为通用敏感字段加密（至少覆盖 `extra.proxies[]`），同步扩展解密路径（`store.ts:303`）与 `GET /api/config` 的脱敏输出。**此项为 P1 的阻塞项，不可延后。**

### UI

照 cline 专属面板模式（`SettingsView.tsx:1816-1897`）：

1. `packages/ui/app/lib/platforms.ts` `SETTINGS_PROVIDERS` 加 `opencode` 条目（label / link / guide）
2. `packages/ui/app/i18n.tsx` 补 zh + en `platforms.opencode.hint`（`i18n.test.tsx` 强制中英 parity）
3. 专属面板：匿名通道开关、zen / go 两个 key 池、prefer 选择、代理列表、高级（retry / performance / models / reasoning）
4. **解除空 key 阻断**：`saveProvider()` 的 `if (!keys.length) return`（约 `:438`）对 opencode 放行 —— `anonymous === true` 时允许无 key 启用
5. 卡片 `enabled` 判定（约 `:1818`）对 opencode 改为 `state?.enabled && (state.hasKey || state.anonymous)`

### 必改接入点

| #   | 文件                                                                  | 改动                                                                                                          |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/core/src/types.ts:3-21`                                     | `ProviderIdSchema` 加 `'opencode'`                                                                            |
| 2   | `packages/core/src/providers/zen.ts`                                  | 新建薄壳 provider                                                                                             |
| 3   | `packages/core/src/providers/index.ts`                                | barrel 导出                                                                                                   |
| 4   | `packages/core/src/registry.ts:41-58`                                 | `PROVIDER_CTORS` 加 key（缺则编译失败）                                                                       |
| 5   | `packages/core/src/registry.ts:168/210`                               | `hasCredentials()` gate 支持匿名启用                                                                          |
| 6   | `packages/core/src/config/store.ts:207/303`                           | `extra` 敏感字段加解密（**阻塞项**）                                                                          |
| 7   | `packages/core/src/router/auto-router.ts:149-162`                     | `providerBaseline` 加 RPM 分数                                                                                |
| 8   | `packages/core/src/quota.ts:32-59`                                    | `PROVIDER_POLICIES` 加条目（可选）                                                                            |
| 9   | `packages/server/src/server.ts:94-107`                                | `PROVIDER_LABELS`                                                                                             |
| 10  | `packages/server/src/server.ts:641`                                   | `hasKey` 从 cline 硬编码特判改为按 provider 分派：opencode → `enabled && (anonymous \|\| apiKeys.length > 0)` |
| 11  | `packages/server/src/onboarding.ts:15-29`                             | `ONBOARDING_ENVIRONMENT_KEYS`                                                                                 |
| 12  | `packages/ui/app/lib/platforms.ts`                                    | `SETTINGS_PROVIDERS`                                                                                          |
| 13  | `packages/ui/app/i18n.tsx`                                            | zh + en hint                                                                                                  |
| 14  | `packages/ui/app/components/SettingsView.tsx`                         | 专属面板 + 空 key 放行 + enabled 判定                                                                         |
| 15  | `packages/cli/src/commands/key.ts:14-30`                              | `KNOWN_PROVIDERS`                                                                                             |
| 16  | `scripts/audit-free-models.mjs:31-148`                                | `PROVIDER_META`                                                                                               |
| 17  | `scripts/update-readme-audit.mjs:20-35`                               | `FREE_TYPE_BY_ID`（如需分类）                                                                                 |
| 18  | `.github/workflows/daily-audit.yml:24-37`                             | zen secrets env                                                                                               |
| 19  | `docs/USAGE.md:125`、`docs/API.md`                                    | env var 与文档                                                                                                |
| 20  | `packages/core/src/providers/__tests__/provider-contracts.test.ts:22` | 契约测试登记                                                                                                  |
| 21  | 根 `package.json` / `pnpm-workspace.yaml` / `tsup.config.ts`          | `build:runtime` 加 zen 包、core external 化                                                                   |
| 22  | 测试聚合脚本                                                          | zen 纳入 `test:coverage`                                                                                      |

`README.md` 与 `FREE_MODELS.md` 的审计区块为自动生成，**不得手改**，跑 `pnpm audit:free-models` 产出。

## 错误处理

| 上游表现                                 | opencode2api 行为                 | 转成 FMF 分类                                   |
| ---------------------------------------- | --------------------------------- | ----------------------------------------------- |
| 401 / 403 / 429 / 5xx / 网络错误         | tier 内换 key、触发冷却           | `rate-limit` / `upstream` → auto-router 可切换  |
| 其余 4xx（400/404/422…）                 | **本 tier 不换 key**，结束 tier   | `request` → auto-router 不做池游走              |
| 匿名 403 `FreeTierError`                 | 换下一个代理                      | 匿名阶段内部消化，不外泄                        |
| 匿名 403 `RegionError`                   | 换下一个代理                      | 同上                                            |
| HTTP 200 但 SSE 内 error 事件 / 异常断流 | **计为失败**（`stream_error`）    | 必须抛出，交由既有 `stream-error-envelope` 处理 |
| 400 reasoning 引用过期                   | 剥离 reasoning 输入后**重放一次** | 内部重试，保会话亲和                            |
| 上游 `Retry-After`                       | 冷却取 max(指数, Retry-After)     | 冷却状态机                                      |

**SSE 流内错误是最易漏的一条**：FMF 现有 `routes/openai.ts` 流转发循环是「读到什么转发什么」，zen 路径必须把流内错误转成异常，否则客户端拿到半个响应仍以为成功。

上游错误体形如 `{"type":"error","error":{"type":"...","message":"..."}}`，需解析 `error.type` 以区分 `FreeTierError` / `RegionError` / `ModelError`。

## 测试策略

| 层            | 位置                                     | 手段                                                                                                                 |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| protocol 转换 | `packages/zen/src/protocol/__tests__/`   | 黄金用例：三协议两两互转（文本 / 工具 / reasoning / 图片）；同协议 `raw` 透传零变化                                  |
| 匿名形变      | 同上                                     | `stream:true`、5 个核心工具注入、`stream_options.include_usage`、非流式折叠回 JSON                                   |
| session       | `packages/zen/src/identity/__tests__/`   | `ses_` 规范化、已合规 ID 原样保留、种子回退、各 header 信号优先级                                                    |
| 路由状态机    | `packages/zen/src/gateway/__tests__/`    | 假 `ZenHttpClient`：匿名成功 / 失败回退、per-tier 重编码、4xx 不换 key、ctx 超时闸门、冷却指数、stale reasoning 重放 |
| 代理池        | `packages/zen/src/proxy/__tests__/`      | 轮换顺序、key 绑定、失败冷却、`proxyfile` 注释解析与去重                                                             |
| 模型发现      | `packages/zen/src/models/__tests__/`     | `api.json` npm→协议映射、文档回退、stale 判定、models.dev 匿名资格四种来源                                           |
| P0 数据模型   | `packages/core/src/protocols/__tests__/` | 三协议入站 `tools` 不再丢、三出站序列化、SSE 增量                                                                    |
| 端到端        | `packages/server/src/__tests__/`         | mock 上游三协议 + 真实 zen provider 走 `/v1/chat/completions` 与 `/v1/messages`                                      |
| 真实上游冒烟  | `scripts/zen-smoke.mjs`（手动）          | 打真 Zen（匿名 + key），**不进 CI**（依赖外网与地区）                                                                |

约定：

- **core / zen / server / cli**：Node.js 内置 test runner（`node --test`），经 `tsx` 加载。core 的 `package.json:22` 是**显式 glob 列举**，新测试必须落在已列目录。
- HTTP mock 统一走 `ProviderContext.fetchImpl` 或 `ZenHttpClient` 注入，参考 `providers/__tests__/free-catalog.test.ts:17-23`。
- 覆盖率：**新包建议与 core 对齐（85% lines / 74% branches）**并纳入 `pnpm test:coverage`；core / server 现有门槛不放松。
- 验证顺序（CI 既定）：`format:check → lint → build:runtime → typecheck → test:coverage → build → audit:prod → verify:release → test:pack`。zen 新包必须挂进 `build:runtime`。

## 明确不移植清单

| opencode2api 组件                                                    | 处置            | 理由                                              |
| -------------------------------------------------------------------- | --------------- | ------------------------------------------------- |
| `internal/admin/`（WebUI、Playground、登录会话、CSRF、登录限速）     | ❌ 不移植       | 用 FMF 自己的设置页；独立管理端与单端口架构冲突   |
| 独立监听端口 + 配置热重载（先验证再切换 Gateway）                    | ❌ 不移植       | FMF 用现有 config store 与单端口                  |
| `internal/telemetry/{metrics,logging}.go` 的请求级统计与 ring buffer | ❌ 不移植       | FMF 已有 call log + `onResponse` / `onUsage` 回调 |
| `internal/config/{password,persistence}.go`                          | ❌ 不移植       | FMF 已有 config store + crypto                    |
| WebUI 静态资源 `webui/`                                              | ❌ 不移植       | —                                                 |
| **上游尝试（attempt）级记录**                                        | ✅ **包内实现** | FMF 无此粒度；暴露查询接口，**UI 本期不展示**     |
| `/healthz`、`x-request-id` 响应头                                    | ✅ 保留         | 实现成本极低                                      |
| `logging.dump_request_bodies`（调试用，含脱敏）                      | ✅ 保留         | 排障必需，默认 false                              |

## 验收标准

1. `pnpm format:check` / `pnpm lint`（max warnings = 0）/ `pnpm build:runtime` / `pnpm typecheck` / `pnpm test:coverage` / `pnpm build` / `pnpm test:pack` 全绿。
2. **P0 回归**：现有 17 个 provider 全部测试原样通过，行为无变化。
3. **匿名通道**：`anonymous=true`、无任何 key 时，设置页可启用 opencode；`/v1/models` 展示匿名可用模型；`/v1/chat/completions` 真实返回（`scripts/zen-smoke.mjs` 手动验证）。
4. **Key 通道**：配置 zen key 后，匿名不可用的模型经 key 通道可用；`goKeys` 独立生效。
5. **回退**：匿名 403/429/5xx 后自动进入认证 tier，且在客户端可见的错误中体现最终所用通道。
6. **三协议**：同一模型在入站 OpenAI / Anthropic 两种客户端下均可用；协议归属错误时能靠 `models.protocols` 覆盖修正。
7. **工具调用**：客户端传 `tools` → 上游收到 → 响应 `tool_calls` 回到客户端，端到端不丢。
8. **代理**：配置多代理时匿名请求按序轮换；失败代理进入冷却并复查。
9. **安全**：`proxies` 中的认证信息在配置文件中以密文存储。
10. 无新增手改的 `README.md` / `FREE_MODELS.md` 审计区块。

## 风险与开放问题

| #   | 风险                                                                                                           | 缓解                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | **工作量**：opencode2api 的 `protocol` + `gateway` + `models` 约 7600 行 Go，TS 移植是本仓库迄今最大的单次新增 | 严格按 Go 源文件对应分模块提交；每个模块先测试后接入                                                                     |
| 2   | **P0 波及全仓**：扩展 `ChatRequest` 触及三条入站协议与三条出站序列化                                           | 新字段全 optional；P0 单独成 PR，跑完整回归                                                                              |
| 3   | SOCKS5 依赖引入                                                                                                | 已在 P1-A 锁定 `socks-proxy-agent`（配 `http-proxy-agent` / `https-proxy-agent`）；按目标协议选 agent 的行为已有回归测试 |
| 4   | 上游行为变更（UA / session / agent 形状是未公开契约）                                                          | 三者全部常量化、集中于一处；`scripts/zen-smoke.mjs` 可快速回归                                                           |
| 5   | 地区限制导致部分协议在某些出口不可用                                                                           | 代理池 + `RegionError` 换代理；文档说明需配置代理                                                                        |
| 6   | 动态模型目录拉取失败                                                                                           | 磁盘缓存 + stale 降级 + 目录就绪前放行已配置 key                                                                         |
| 7   | `extra` 加密改造可能影响既有 custom provider 的 `sources`                                                      | 沿用并扩展 `mapCustomSourceKeys` 的既有模式，补回归测试                                                                  |

开放问题（实施前需确认）：

1. SOCKS5 依赖的确切包名与版本（`socks` vs `proxy-agent` vs 其他）。
2. `User-Agent` 中的 opencode 版本号是否需要跟随上游发布节奏自动更新（当前建议：常量 + 手工跟进）。
3. attempt 级记录的查询接口形态（REST 路径或仅进程内 API）——不影响 UI 的部分可后置。
