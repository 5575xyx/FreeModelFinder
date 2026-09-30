# 通用工具调用（Provider 响应层补全）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有 provider 把上游返回的 `tool_calls` 抬成 `ChatResponse.tool_calls` / `StreamChunk.tool_calls`，并修正请求侧 tool id 配对，使任意客户端经网关都能端到端完成工具/MCP 调用。

**Architecture:** 新建纯函数模块 `providers/openai-like.ts` 集中解析 OpenAI 兼容响应，供 `OpenAICompatibleProvider`（13 provider 基类）与 `CustomProvider` 复用；`ClineProvider` / `GeminiProvider` 各自按原生协议补解析。协议出站（三协议 SSE）与入站已是 P0 落地，本次不动。`ZenProvider` 已具备能力，仅验证。

**Tech Stack:** TypeScript strict、zod、Node 内置 test runner（`tsx`）、Fastify。

**Spec:** `docs/superpowers/specs/2026-09-30-universal-tool-calling-design.md`

## 关键背景（执行前必读）

- 代码**不写注释**（仓库硬规则）。
- 流式**不聚合** `delta.tool_calls`：原样透传，出站层已按 `index` 消费。
- 无 `tool_calls` 时行为必须与现状逐字节一致（回归硬闸门）。
- 参照实现：`packages/zen/src/protocol/response.ts` 与 `stream.ts`（字段形状、`function_call`→`tool_calls`、`call_${index}` 兜底约定）。
- core 改动后，跑 server 测试前先 `pnpm --filter @freemodelfinder/core build`（server 加载 core dist）。
- 仓库有并行会话在改无关文件；只提交本计划涉及文件。

## 依赖与顺序

Task 1（解析模块）→ Task 2（OpenAI 兼容家族）→ Task 3（请求侧 id）→ Task 4（cline）→ Task 5（gemini）→ Task 6（端到端 + 全量验证）。Task 3 与 1/2 无强耦合，但按序执行。

## 验证命令模板

```
npx prettier --write <改动文件>
npx eslint <改动文件> --max-warnings=0
pnpm --filter @freemodelfinder/core build; if ($?) { pnpm --filter @freemodelfinder/core test }
```

（server 相关 Task 追加 `pnpm --filter @freemodelfinder/server test`）

---

## Task 1 — `openai-like.ts` 解析模块（纯新文件 + 测试）

**Files:**

| 文件                                                        | 改动                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/core/src/providers/openai-like.ts`                | **新建**：纯函数解析 OpenAI 兼容响应                                           |
| `packages/core/src/providers/__tests__/openai-like.test.ts` | **新建**（node:test；core test glob 已含 `src/providers/__tests__/*.test.ts`） |

**导出（签名固定，供 Task 2 消费）：**

- `parseToolCalls(value: unknown): ToolCall[] | undefined`——数组为空/非法 → undefined；每项 `{ id?, type:'function', function:{ name, arguments? } }`；`id` 仅在有非空字符串时带
- `parseToolCallDeltas(value: unknown): ToolCallDelta[] | undefined`——每项 `{ index, id?, type:'function', function?:{ name?, arguments? } }`；`index` 缺省 0
- `parseOpenAIMessage(message: unknown): { content: string; reasoning?: string; tool_calls?: ToolCall[] }`——`content` 支持 string / 文本 part 数组（拼 text），null/缺省 → `''`；`reasoning` 取 `reasoning_content ?? reasoning`（非空才带）
- `parseOpenAIDelta(delta: unknown): { content?: string; reasoning?: string; tool_calls?: ToolCallDelta[] }`——`content` 非空才带；`reasoning` 非空才带
- `mapFinishReason(value: unknown): ChatResponse['finish_reason']`——`function_call` → `'tool_calls'`；`stop|length|tool_calls|content_filter` 原样；其余 → `null`
- `parseUsage(value: unknown): ChatResponse['usage'] | undefined`

**测试要点（TDD 先红后绿）：**

- message 含 `tool_calls`（带 id / 不带 id）；`content:null` + tool_calls；文本 part 数组 content
- delta 含 `tool_calls`（index 递增、`function.name` 仅首块、`function.arguments` 分片）；`content` 与 `tool_calls` 同块
- `mapFinishReason('function_call') === 'tool_calls'`；未知值 → null
- `parseUsage` 含 `prompt_tokens_details.cached_tokens`
- 无 `tool_calls` 时对应字段为 `undefined`（不是空数组）

- [ ] 逐用例 TDD（先红）
- [ ] 验证命令模板（core）
- [ ] Commit: `feat(core): OpenAI 兼容响应解析模块 openai-like`

## Task 2 — `OpenAICompatibleProvider` + `CustomProvider` 复用并填充 tool_calls

**Files:**

| 文件                                                                            | 改动                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/providers/openai-compatible.ts`                              | ① `OpenAILikeChoice`（:5-20）类型加 `tool_calls`（message 与 delta）；② `chat()`（:52-87）改用 `parseOpenAIMessage` + `parseUsage` + `mapFinishReason`，填入 `tool_calls`；③ `stream()`（:89-143）改用 `parseOpenAIDelta`，`yield` 带 `tool_calls`（**即使 `delta` 为空也要在有 tool_calls 时产出该 chunk**） |
| `packages/core/src/providers/custom.ts`                                         | 同步改造 `chat()`（:151-189）与 `stream()`（:191-248）复用 `openai-like`（消除现有重复），行为与上一致                                                                                                                                                                                                        |
| `packages/core/src/providers/__tests__/provider-contracts.test.ts` 或就近新测试 | 扩展：chat 返回 `tool_calls` + `finish_reason:'tool_calls'`；stream 产出 tool_call delta；tool-only（无文本）不报错                                                                                                                                                                                           |

**要点：**

- `content` 为 null 且带 tool_calls 时：`content` 仍为 `''`，`tool_calls` 保留
- 保留既有 `reasoning` 分离语义（`content || reasoning`）不变——`tool_calls` 为**附加**字段
- 非流式 `ChatResponse.tool_calls` 与流式 `StreamChunk.tool_calls` 字段名严格对齐 spec
- 13 个继承 provider 不单独改（基类覆盖即可）

**测试要点：**

- mock fetch 返回 `choice.message.tool_calls` → `ChatResponse.tool_calls` 正确、`finish_reason` 映射
- mock SSE 返回含 `delta.tool_calls` 的帧 → 产出 `chunk.tool_calls`（index/id/function）；纯 tool 帧 `delta === ''`
- 无 tool_calls 的既有响应 → 输出与改动前一致的 `content`/`reasoning`/`finish_reason`
- 回归：`pnpm --filter @freemodelfinder/core test` 全绿（含既有 max-tokens 等 provider 用例）

- [ ] TDD
- [ ] 验证命令模板（core）
- [ ] Commit: `feat(core): OpenAI 兼容 provider 解析并透传 tool_calls`

## Task 3 — 请求侧 tool id 保留

**Files:**

| 文件                                                  | 改动                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/protocols/openai.ts`               | `normalizeOpenAIToolCall`（:50-59）保留 `id`：缺失/空串时给稳定兜底 `call_<index>`（index 为入站 tool_calls 数组下标）；调用点（:85）传入下标 |
| `packages/core/src/providers/openai-messages.ts`      | `toOpenAIMessages`（:11-32）保留 `tool_call_id`（不再因空串丢弃；`undefined` 仍不带）                                                         |
| `packages/core/src/protocols/anthropic.ts`            | `tool_call_id: r.tool_use_id ?? ''`（:132）→ 缺失时兜底为对应的 `call_<index>`（与 tool_use 序号对应），不产生空串                            |
| `packages/core/src/__tests__/protocols-tools.test.ts` | 扩展 id 往返用例                                                                                                                              |

**要点：**

- 目标：assistant `tool_calls[].id` 与紧随的 `tool` 消息 `tool_call_id` **一一对应**，消除 `tool_output_mismatch`
- 兜底只补空缺，绝不覆盖上游已给的 id
- Anthropic 侧 `tool_result.tool_use_id` 缺失时才兜底；有值原样保留

**测试要点：**

- OpenAI 入站：assistant tool_calls 无 id + 后续 tool 消息 → 二者 id 一致（非空）
- Anthropic 入站：`tool_use` 无 id + `tool_result` 无 `tool_use_id` → 配对一致
- 有 id 时原样保留（不覆盖）
- 无 tool 消息的普通请求零变化

- [ ] TDD
- [ ] 验证命令模板（core）
- [ ] Commit: `fix(core): 保留 tool_call id 配对避免上游 mismatch`

## Task 4 — `ClineProvider` 工具支持

**Files:**

| 文件                                                  | 改动                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/providers/cline.ts`                | ① `buildBody`（:487-503）转发 `req.tools`（如有）；② `parseJSONResponse`（:711-747）解析 `message.tool_calls`（复用 `openai-like.parseToolCalls`）；③ `aggregateSSE`（:749-774）+ `parseSSE`/`SseFrame`：累积 tool_call 增量并在结果里重组（参照 `packages/zen/src/protocol/stream.ts` 的 `collapseChunks` 逻辑）；④ **放宽空判定**：`chatAttempt`（:548）有 `tool_calls` 时不再抛「empty content」 |
| `packages/core/src/providers/__tests__/cline.test.ts` | 扩展：JSON 响应带 tool_calls；SSE 带 tool 增量重组；tool-only 不报 empty                                                                                                                                                                                                                                                                                                                            |

**要点：**

- `buildBody` 仅在 `req.tools?.length` 时加 `tools`，不影响既有请求体
- `finish_reason` 映射：上游 `tool_calls`/`function_call` → `'tool_calls'`
- 非流式聚合与流式 `stream()`（cline 的 openStream 路径）都要输出 tool_calls——先读现状确认 `stream()` 如何用 `parseSSE`
- 用现有测试的 mock/SSE 工具模式

- [ ] TDD
- [ ] 验证命令模板（core）
- [ ] Commit: `feat(core): cline provider 工具调用转发与解析`

## Task 5 — `GeminiProvider` 工具支持

**Files:**

| 文件                                                                 | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/providers/gemini.ts`                              | ① 类型：`GeminiContentPart` 加 `functionCall?: { name?, args? }`、`functionResponse?: { name?, response? }`；② `buildBody`（:123-140）加 `tools:[{ functionDeclarations }]`（由 `req.tools` 转换，OpenAI 形 → Gemini 形）；③ `toGeminiContents`/`buildMessageParts`（:49-88）：assistant `tool_calls` → `functionCall` part；`role:'tool'` → `functionResponse` part（**按 `tool_call_id` 反查对应 function name**，`response` 为解析后的内容对象）；④ `chat()`（:184-215）与 `stream()`（:217-274）解析 `parts` 里的 `functionCall` → `tool_calls`，`finish_reason`：含 `functionCall` 归为 `'tool_calls'` |
| `packages/core/src/providers/__tests__/`（新 gemini 工具测试或就近） | 扩展：入站 tools 塑造、functionCall 响应解析、functionResponse 出站                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**要点：**

- Gemini `role` 只有 user/model：`tool` 结果挂在 user 侧 `functionResponse`；assistant `functionCall` 在 model 侧
- function name 反查：维护 `tool_call_id → name` 映射（来自历史 assistant `tool_calls`）
- 流式：每个候选的 `parts` 里 `functionCall` 直接产 `chunk.tool_calls`（index 递增）
- 无 tools/tool_calls 时请求体与响应解析与现状一致

- [ ] TDD
- [ ] 验证命令模板（core）
- [ ] Commit: `feat(core): gemini provider functionCall 双向支持`

## Task 6 — server 端到端 + 全量验证

**Files:**

| 文件                                                                               | 改动                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/routes/__tests__/`（新增/扩展，如 `universal-tools.test.ts`） | 端到端：`tools` 入站 → mock provider 返回 `tool_calls` → OpenAI / Anthropic / Gemini 三协议出站 SSE 正确序列化（含 `finish_reason`）；Zen 路径纳入一条覆盖确认无回归 |
| （可能的修复）                                                                     | 验证链暴露的问题（仅限本特性范围）                                                                                                                                   |

**验证链（AGENTS.md CI 顺序，既定例外照旧）：**

```
逐文件 prettier（本特性改动文件）   # 仓级 format:check 因 CRLF 基线跳过
pnpm lint
pnpm build:runtime
pnpm typecheck
pnpm test:coverage
pnpm build
# 跳过：format:check、test:pack、audit:prod、verify:release
```

- [ ] 端到端用例 TDD（先 server build 再跑）
- [ ] 全链跑通（失败 → 修 → 重跑；范围外/并行会话问题如实标注不扩大修复面）
- [ ] 报告：Status、每步结果、各包测试数字、覆盖率、遗留清单；**提醒用户推送（不自行 push）**

## 执行后流程

按 subagent-driven-development：每 Task 实现者 → spec 合规审 → 质量审 → 修复回炉 → 复审 Approved 才进下一 Task；全部完成后 final review。

## Self-Review（spec 覆盖核对）

- provider 响应解析（OpenAI 兼容/custom/cline/gemini）→ Task 1/2/4/5 ✅
- 请求侧 id 配对 → Task 3 ✅
- Zen 不变 + 验证 → Task 6 ✅
- tool-only 不算空、content null 边界 → Task 2/4 ✅
- 无 tool_calls 逐字节一致 → 各 Task 回归点 + Task 6 ✅
- YAGNI（raw 透传 / tool_choice / zen 改动）→ 未列入 ✅
