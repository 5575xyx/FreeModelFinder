# 通用工具调用（Provider 响应层补全）设计

日期：2026-09-30
状态：已批准（待实施）

## 目标

让 FreeModelFinder 成为**通用工具调用网关**：任意客户端（OpenAI / Anthropic / Gemini 协议）、任意 provider，工具 / MCP / 技能都能端到端透传。任何走 `/v1/chat/completions`、`/v1/messages`、Gemini 端点的客户端，只要能传 `tools`，就应能收到 `tool_calls` 并完成工具循环。

## 背景与现状

入站（客户端 → `ChatRequest`）与出站响应（`ChatResponse`/`StreamChunk` → 客户端三协议 SSE）已在 P0 落地，`tools` / `tool_calls` / `reasoning` 的类型与协议序列化均就绪。**唯一断点在 provider 响应解析层**：上游返回的 `tool_calls` 被静默丢弃，永远到不了客户端。

| 层                                                                             | 状态                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 入站三协议转换（`protocols/openai,anthropic,gemini.ts`）                       | ✅ 已有                                                                               |
| 出站请求（`ChatRequest` → 上游）：`tools`、assistant `tool_calls`、`tool` 结果 | ✅ 已有（`toUpstreamChatFields` 透传 `tools`；`toOpenAIMessages` 保留 tool 字段）     |
| **上游响应解析（provider 层）**                                                | ❌ **缺失**——无 provider 给 `ChatResponse.tool_calls` / `StreamChunk.tool_calls` 赋值 |
| 出站响应序列化（→ 客户端）                                                     | ✅ 已有（读取 `chunk.tool_calls` / `res.tool_calls`）                                 |

### 受影响 provider

| Provider                   | 关系                                                                                                                                        | 现状                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `OpenAICompatibleProvider` | **13 个 provider 共用**（openrouter/zhipu/siliconflow/modelscope/nvidia/github/cohere/huggingface/sensenova/qianfan/kilo/agnes/agnes-intl） | `chat()`/`stream()` 只取 `content`/`reasoning`；`OpenAILikeChoice` 类型无 `tool_calls` |
| `CustomProvider`           | 复制自前者                                                                                                                                  | 同上（重复实现）                                                                       |
| `ClineProvider`            | 原生 SSE                                                                                                                                    | `buildBody` 不转发 `tools`；JSON/SSE 解析忽略 `tool_calls`；「空内容」误判为错误       |
| `GeminiProvider`           | 原生协议                                                                                                                                    | `buildBody` 不含 `tools`；不解析 `functionCall`                                        |
| `ZenProvider`              | 薄壳 → `packages/zen`                                                                                                                       | ✅ **已具备**，见下                                                                    |

### Zen 现状（不在本次改动范围）

`ZenProvider` 是薄壳，工具能力已在 `packages/zen/src/protocol/` 完整实现：同协议 `raw` 零损透传（`request.ts`）、跨协议编解码（`chat.ts`/`anthropic.ts`/`responses.ts`）、非流式与流式响应解析（`response.ts`/`stream.ts`）、匿名通道自动补齐 core agent 工具（`agent.ts`）。**本次不为 Zen 做任何开发**，仅在端到端验证中纳入覆盖；实现其它 provider 时**以 Zen 的解析逻辑为参照**（字段形状、`function_call`→`tool_calls` 映射、delta 重组语义）。

## 架构

### 新增 `packages/core/src/providers/openai-like.ts`（纯函数，无状态）

集中解析 OpenAI 兼容响应，供 `OpenAICompatibleProvider` 与 `CustomProvider` 复用，消除二者现有重复：

- `parseOpenAIMessage(message)` → `{ content, reasoning?, tool_calls? }`
- `parseOpenAIDelta(delta)` → `{ content?, reasoning?, tool_calls?: ToolCallDelta[] }`
- `mapFinishReason(raw)` → `ChatResponse['finish_reason']`（含 `function_call` → `tool_calls`）
- `parseUsage(raw)` → `ChatResponse['usage'] | undefined`
- 内部 `parseToolCalls` / `parseToolCallDeltas`（形状对齐 `ToolCall` / `ToolCallDelta`）

### 各 provider 改动

- **`OpenAICompatibleProvider`**：`chat()`/`stream()` 改为调用 `openai-like.ts`，并把 `tool_calls` 填入 `ChatResponse` / `StreamChunk`。
- **`CustomProvider`**：同上（复用同一模块）。
- **`ClineProvider`**：
  - `buildBody` 增加转发 `req.tools`；
  - `parseJSONResponse` 解析 `message.tool_calls`；
  - `aggregateSSE` / `parseSSE` / `SseFrame` 增加 tool_call 增量；
  - 放宽 `chatAttempt` 的「空内容即错误」判定：有 `tool_calls` 时不算空。
- **`GeminiProvider`**：
  - `buildBody` 增加 `tools`(`functionDeclarations`)（`toolConfig` 保持默认 AUTO，无需显式发送）；
  - 出站消息转换：assistant `tool_calls` → `functionCall`；`role:'tool'` → `functionResponse`（Gemini 以 **function name** 匹配，需按 `tool_call_id` 反查对应调用的 name）；
  - 响应解析：`functionCall` → `tool_calls`（`chat` + `stream`），`finish_reason` 为 `STOP` 时若含 `functionCall` 归为 `tool_calls`。

### 请求侧 id 保留（与 `tool_output_mismatch` 400 相关）

保证 assistant `tool_calls[].id` 与 `tool` 消息 `tool_call_id` 一一对应：

- `protocols/openai.ts` `normalizeOpenAIToolCall`：不再丢弃空/缺失 `id`；
- `providers/openai-messages.ts`：保留 `tool_call_id`（不因空串丢弃）；
- `protocols/anthropic.ts` `tool_call_id: r.tool_use_id ?? ''`：不产生空串，缺失时给出稳定兜底；
- 兜底 id 形如 `call_<index>`（对齐 `packages/zen/src/protocol/anthropic.ts` 既有约定），**仅补空缺，不覆盖上游 id**。

## 数据流

**流式（关键）**：上游 `delta.tool_calls` → `StreamChunk.tool_calls` **原样透传**（保留 `index`/`id`/`function.name`/`function.arguments`），不做聚合。出站层已按 `index` 消费，无需改：

- OpenAI：`streamChunkToOpenAI`（`protocols/openai.ts`）直接透传 `delta.tool_calls`；
- Anthropic：`routes/anthropic.ts` 按 `call.index` 组装 `tool_use` 块；
- Gemini：`routes/gemini.ts` 组装 `functionCall`。

**非流式**：`message.tool_calls` → `ChatResponse.tool_calls`，`finish_reason` 映射为 `'tool_calls'`；出站 `chatResponseToOpenAI` / `chatResponseToAnthropic` / Gemini 出站已支持。

## 错误处理与边界

- **tool-only 响应**（无文本）不再判为「空响应」错误。
- `content: null` 且带 `tool_calls` 时保留工具调用。
- `tool_call_id` / `tool_calls[].id` 缺失时生成 `call_<index>` 兜底（只补空缺）。
- **无 `tool_calls` 时行为与现状逐字节一致**（回归硬闸门：既有 provider 测试全绿）。

## 测试

- **core**：`openai-like` 单测（message/delta/finish/usage/tool_calls）；`openai-compatible` 与 `custom` 的 chat + stream 工具用例；`cline`（JSON + SSE）；`gemini`（`functionCall`）；请求侧 id 往返用例（assistant tool_calls ↔ tool 消息 id 一致）。
- **server**：端到端——`tools` 入站 → mock provider 返回 `tool_calls` → 三协议出站 SSE 正确。
- **回归**：core / server 全量绿；Zen 纳入端到端覆盖确认无回归。

## 不做（YAGNI）

- 非 Zen provider 的同协议 `raw` 零损透传（方案 C）——留后续。
- `tool_choice` / `parallel_tool_calls` 的精细透传——先保证主链路可用。
- Zen / `packages/zen` 的任何改动。

## 文件清单

| 文件                                               | 动作                                 |
| -------------------------------------------------- | ------------------------------------ |
| `packages/core/src/providers/openai-like.ts`       | 新建                                 |
| `packages/core/src/providers/openai-compatible.ts` | 改（复用 + fill tool_calls）         |
| `packages/core/src/providers/custom.ts`            | 改（复用 + fill tool_calls）         |
| `packages/core/src/providers/cline.ts`             | 改（tools 转发 + 解析 + 放宽空判定） |
| `packages/core/src/providers/gemini.ts`            | 改（tools + functionCall 双向）      |
| `packages/core/src/protocols/openai.ts`            | 改（id 保留）                        |
| `packages/core/src/protocols/anthropic.ts`         | 改（id 兜底）                        |
| `packages/core/src/providers/openai-messages.ts`   | 改（tool_call_id 保留）              |
| 各 provider 测试 + `protocols-tools` 测试          | 新建/扩展                            |
| `packages/server/src/routes/__tests__/`            | 端到端工具用例                       |
