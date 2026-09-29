# P1-C2：Zen 响应转换、SSE 与折叠 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@freemodelfinder/zen` 中落地「上游响应体 / SSE 流 → 统一 Zen 响应 / 流式增量」，并在「上游协议 == 客户端入站协议」时回填 `raw`/`rawProtocol`，以及把流式增量折叠成单个非流式响应。

**Architecture:** 新增 `packages/zen/src/protocol/response.ts`（三个协议的非流式响应解析 + `convertResponse` 分派 + `raw` 回填）与 `packages/zen/src/protocol/stream.ts`（SSE 行解析 + 三协议流式 chunk 解析 + `collapseChunks`）。响应模型在 P1-C1 的 `types.ts` 上补充（`ZenChatResponse` / `ZenStreamChunk`）。

**Tech Stack:** TypeScript、Node.js 内置 test runner（`node --test` + `tsx`）。

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-zen-integration-design.md`（「中间表示策略」「错误处理」节）
**参考实现（磁盘上，逐字段对照）:** `E:\AImoney\opencode2api\opencode2api\internal\protocol\{response,content,stream,stream_parser,stream_emitter,collapse}.go`

---

## 执行约定

与 P1-C1 相同：给出**精确接口、测试用例、关键算法**；**逐字段映射对照磁盘上的 Go 源码**。执行者先读对应 Go 文件再编码，reviewer 会对照 Go 源核对。

**边界**：本计划只做响应侧；agent 形变 / `ForcedEffort` / stale-reasoning 重试在 P1-C3。**必须承接 P1-C1 的终审移交项**：Anthropic 的 `thinking` 块 ↔ `reasoning` 的双向表示（本阶段定义响应侧表示，请求侧编码在 Task R5 一并补齐）。

## 文件结构（P1-C2）

| 文件                                            | 职责                                                                        | 任务    |
| ----------------------------------------------- | --------------------------------------------------------------------------- | ------- |
| `packages/zen/src/protocol/types.ts`            | 追加 `ZenToolCallDelta` / `ZenUsage` / `ZenChatResponse` / `ZenStreamChunk` | R1      |
| `packages/zen/src/protocol/response.ts`         | `convertResponse` 分派 + chat 响应解析 + `raw` 回填                         | R1      |
| `packages/zen/src/protocol/response.ts`（追加） | anthropic / responses 响应解析                                              | R2 / R3 |
| `packages/zen/src/protocol/stream.ts`           | SSE 行解析 + 三协议 chunk 解析                                              | R4      |
| `packages/zen/src/protocol/stream.ts`（追加）   | `collapseChunks` 折叠为响应                                                 | R5      |
| `packages/zen/src/protocol/anthropic.ts`        | 请求侧补 `thinking` 块编码（承接 C1 移交项）                                | R5      |
| `packages/zen/src/index.ts`                     | barrel 追加                                                                 | R5      |

---

### Task R1: 响应模型 + chat 响应解析 + `convertResponse` + `raw` 回填

**Files:**

- Modify: `packages/zen/src/protocol/types.ts`
- Create: `packages/zen/src/protocol/response.ts`
- Test: `packages/zen/src/__tests__/protocol-response.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/protocol-response.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertResponse, parseChatResponse } from '../protocol/response.js';

describe('zen chat response parsing', () => {
  it('parses content, tool_calls, reasoning and usage', () => {
    const res = parseChatResponse({
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hi',
            reasoning_content: 'because',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    assert.equal(res.id, 'gen_1');
    assert.equal(res.content, 'hi');
    assert.equal(res.reasoning, 'because');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.id, 'call_1');
    assert.equal(res.usage?.total_tokens, 7);
  });

  it('falls back to reasoning when content is empty', () => {
    const res = parseChatResponse({
      id: 'x',
      model: 'm',
      created: 1,
      choices: [
        { message: { role: 'assistant', content: '', reasoning: 'think' }, finish_reason: 'stop' },
      ],
    });
    assert.equal(res.content, 'think');
    assert.equal(res.reasoning, 'think');
  });
});

describe('zen convertResponse raw passthrough', () => {
  it('attaches raw when client protocol matches the chat upstream', () => {
    const body = {
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      vendor_flag: true,
    };
    const res = convertResponse(body, 'chat', 'openai');
    assert.equal(res.raw, body);
    assert.equal(res.rawProtocol, 'openai');
  });

  it('omits raw for a cross-protocol client', () => {
    const body = {
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    };
    const res = convertResponse(body, 'chat', 'gemini');
    assert.equal(res.raw, undefined);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— `../protocol/response.js` 不存在。

- [ ] **Step 3: 实现**

`packages/zen/src/protocol/types.ts` 追加：

```ts
export interface ZenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ZenToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ZenChatResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  tool_calls?: ZenToolCall[];
  reasoning?: string;
  usage?: ZenUsage;
  raw?: unknown;
  rawProtocol?: ZenClientProtocol;
}

export interface ZenStreamChunk {
  id: string;
  model: string;
  created: number;
  delta: string;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  tool_calls?: ZenToolCallDelta[];
  reasoning?: string;
  usage?: ZenUsage;
  raw?: unknown;
  rawProtocol?: ZenClientProtocol;
}
```

新建 `packages/zen/src/protocol/response.ts`（本任务只含 chat 解析与分派；anthropic/responses 在 R2/R3 追加）：

```ts
import type {
  ZenChatResponse,
  ZenClientProtocol,
  ZenProtocol,
  ZenToolCall,
  ZenUsage,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseUsage(value: unknown): ZenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const out: ZenUsage = {};
  const prompt = num(usage['prompt_tokens']);
  const completion = num(usage['completion_tokens']);
  const total = num(usage['total_tokens']);
  if (prompt !== undefined) out.prompt_tokens = prompt;
  if (completion !== undefined) out.completion_tokens = completion;
  if (total !== undefined) out.total_tokens = total;
  const details = asRecord(usage['prompt_tokens_details']);
  const cached = num(details?.['cached_tokens']);
  if (cached !== undefined) out.prompt_tokens_details = { cached_tokens: cached };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseToolCalls(value: unknown): ZenToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ZenToolCall[] = [];
  for (const raw of value) {
    const call = asRecord(raw);
    if (!call) continue;
    const fn = asRecord(call['function']);
    calls.push({
      ...(str(call['id']) ? { id: str(call['id']) } : {}),
      type: 'function',
      function: {
        name: str(fn?.['name']) ?? '',
        ...(str(fn?.['arguments']) !== undefined ? { arguments: str(fn?.['arguments']) } : {}),
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

const FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter']);

function finishReason(value: unknown): ZenChatResponse['finish_reason'] {
  const v = str(value);
  return v && FINISH.has(v) ? (v as ZenChatResponse['finish_reason']) : null;
}

export function parseChatResponse(body: unknown): ZenChatResponse {
  const payload = asRecord(body) ?? {};
  const choices = Array.isArray(payload['choices']) ? (payload['choices'] as unknown[]) : [];
  const choice = asRecord(choices[0]) ?? {};
  const message = asRecord(choice['message']) ?? {};
  const primary = str(message['content']) ?? '';
  const reasoning = str(message['reasoning_content']) ?? str(message['reasoning']) ?? '';
  const tool_calls = parseToolCalls(message['tool_calls']);
  return {
    id: str(payload['id']) ?? `zen-${Date.now()}`,
    model: str(payload['model']) ?? '',
    created: num(payload['created']) ?? Math.floor(Date.now() / 1000),
    content: primary || reasoning,
    finish_reason: finishReason(choice['finish_reason']),
    ...(tool_calls ? { tool_calls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(parseUsage(payload['usage']) ? { usage: parseUsage(payload['usage']) } : {}),
  };
}

const CLIENT_TO_PROTOCOL: Partial<Record<ZenClientProtocol, ZenProtocol>> = {
  openai: 'chat',
  anthropic: 'anthropic',
};

export function convertResponse(
  body: unknown,
  upstream: ZenProtocol,
  client: ZenClientProtocol,
): ZenChatResponse {
  if (upstream !== 'chat') {
    throw new Error(`unsupported upstream protocol: ${upstream}`);
  }
  const parsed = parseChatResponse(body);
  if (CLIENT_TO_PROTOCOL[client] === upstream) {
    return { ...parsed, raw: body, rawProtocol: client };
  }
  return parsed;
}
```

> R1 只支持 `chat` 上游；`anthropic`/`responses` 抛明确错误。R2 增加 `anthropic` 分支、R3 增加 `responses` 分支（各自把对应解析函数接入 switch）。本任务提交时 chat 路径必须完全可用。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/types.ts packages/zen/src/protocol/response.ts packages/zen/src/__tests__/protocol-response.test.ts
git commit -m "feat(zen): 响应模型、chat 响应解析与 raw 回填"
```

---

### Task R2: Anthropic 响应解析

**Files:**

- Modify: `packages/zen/src/protocol/response.ts`
- Test: `packages/zen/src/__tests__/protocol-response.test.ts`（追加）

参考：`internal/protocol/response.go` 的 anthropic→内部路径、`content.go` 的 `thinking` 块解码。

- [ ] **Step 1: 写失败测试**

```ts
import { parseAnthropicResponse } from '../protocol/response.js';

describe('zen anthropic response parsing', () => {
  it('joins text blocks and maps tool_use to tool_calls', () => {
    const res = parseAnthropicResponse({
      id: 'msg_1',
      model: 'm',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_1', name: 'f', input: { q: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    assert.equal(res.content, 'hi');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.id, 'toolu_1');
    assert.equal(res.tool_calls?.[0]?.function.arguments, '{"q":1}');
    assert.equal(res.usage?.prompt_tokens, 3);
    assert.equal(res.usage?.completion_tokens, 4);
  });

  it('surfaces a thinking block as reasoning', () => {
    const res = parseAnthropicResponse({
      id: 'msg_1',
      model: 'm',
      content: [
        { type: 'thinking', thinking: 'step' },
        { type: 'text', text: 'answer' },
      ],
      stop_reason: 'end_turn',
    });
    assert.equal(res.reasoning, 'step');
    assert.equal(res.content, 'answer');
  });
});
```

> `stop_reason` 映射（`end_turn`→`stop`、`max_tokens`→`length`、`tool_use`→`tool_calls`、`stop_sequence`→`stop`）对照 `response.go`。`thinking` 块 → `reasoning` 是本阶段承接 C1 移交项的关键，须实现并把 `signature` 保留到（若 `ZenChatResponse` 需要）——如 Go 将其保留在 reasoning item 中，请如实报告需要如何在类型上承载。

- [ ] **Step 2–4: 实现并验证**

对照 Go 源实现 `parseAnthropicResponse`，运行 `pnpm --filter @freemodelfinder/zen test` 至 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/response.ts packages/zen/src/__tests__/protocol-response.test.ts
git commit -m "feat(zen): Anthropic 响应解析（含 thinking→reasoning）"
```

---

### Task R3: Responses 响应解析

**Files:**

- Modify: `packages/zen/src/protocol/response.ts`
- Test: `packages/zen/src/__tests__/protocol-response.test.ts`（追加）

参考：`internal/protocol/response.go` 的 responses→内部路径。

- [ ] **Step 1: 写失败测试**

```ts
import { parseResponsesResponse } from '../protocol/response.js';

describe('zen responses response parsing', () => {
  it('reads output_text, function_call and usage', () => {
    const res = parseResponsesResponse({
      id: 'resp_1',
      model: 'm',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"q":1}' },
      ],
      status: 'completed',
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    assert.equal(res.content, 'hi');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.id, 'call_1');
    assert.equal(res.usage?.prompt_tokens, 3);
  });
});
```

> 具体 output item 形状、reasoning summary、`status`→`finish_reason` 映射以 Go `response.go` 为准；若与上面断言不同，按 Go 修正测试并报告。

- [ ] **Step 2–4: 实现并验证**

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/response.ts packages/zen/src/__tests__/protocol-response.test.ts
git commit -m "feat(zen): Responses 响应解析"
```

---

### Task R4: SSE 行解析与三协议流式 chunk

**Files:**

- Create: `packages/zen/src/protocol/stream.ts`
- Test: `packages/zen/src/__tests__/protocol-stream.test.ts`（新建）

参考：`internal/protocol/stream.go` + `stream_parser.go`。

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/protocol-stream.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SseParser,
  parseChatChunk,
  parseAnthropicChunk,
  parseResponsesChunk,
} from '../protocol/stream.js';

describe('zen sse parser', () => {
  it('splits events across chunk boundaries', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push('data: {"a":'), []);
    const events = parser.push('1}\n\ndata: [DONE]\n\n');
    assert.deepEqual(events, [{ data: '{"a":1}' }, { data: '[DONE]' }]);
  });

  it('ignores non-data lines and empty events', () => {
    const parser = new SseParser();
    const events = parser.push(': comment\n\nevent: x\ndata: {"a":1}\n\n');
    assert.deepEqual(events, [{ event: 'x', data: '{"a":1}' }]);
  });
});

describe('zen stream chunk parsing', () => {
  it('parses a chat content delta', () => {
    const chunk = parseChatChunk({
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [{ delta: { content: 'hi', reasoning: 'r' }, finish_reason: null }],
    });
    assert.equal(chunk.delta, 'hi');
    assert.equal(chunk.reasoning, 'r');
  });

  it('parses chat tool_call deltas with cumulative index', () => {
    const chunk = parseChatChunk({
      id: 'gen_1',
      model: 'm',
      created: 1,
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"q"' } }],
          },
          finish_reason: null,
        },
      ],
    });
    assert.equal(chunk.tool_calls?.[0]?.index, 0);
    assert.equal(chunk.tool_calls?.[0]?.function?.name, 'f');
  });

  it('parses an anthropic content_block_delta', () => {
    const chunk = parseAnthropicChunk({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    });
    assert.equal(chunk.delta, 'hi');
  });

  it('parses a responses output_text delta', () => {
    const chunk = parseResponsesChunk({ type: 'response.output_text.delta', delta: 'hi' });
    assert.equal(chunk.delta, 'hi');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

新建 `packages/zen/src/protocol/stream.ts`。要求：

- `SseParser`：累积文本，按 `\n\n`（兼容 `\r\n\r\n`）切分事件；每个事件解析 `event:` 与 `data:` 行，`data` 多行用 `\n` 连接；忽略注释行（`:` 开头）；`[DONE]` 作为数据原样产出。
- `parseChatChunk(payload): ZenStreamChunk`：从 `choices[0].delta` 取 `content`/`reasoning_content`/`reasoning`/`tool_calls`（`tool_calls` 转 `ZenToolCallDelta[]`，保留 `index`）；`finish_reason` 映射。
- `parseAnthropicChunk(payload): ZenStreamChunk`：`content_block_delta` 的 `text_delta`/`input_json_delta`/`thinking_delta`；`message_delta` 的 `stop_reason`/`usage`；`message_start` 的 id/model/usage。
- `parseResponsesChunk(payload): ZenStreamChunk`：`response.output_text.delta`、`response.function_call_arguments.delta`、`response.completed`（usage/status）。

> 三协议事件名与字段以 Go `stream_parser.go`/`stream_emitter.go` 为准；上面仅为验收锚点，实现须对照 Go 并按需修正测试。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/stream.ts packages/zen/src/__tests__/protocol-stream.test.ts
git commit -m "feat(zen): SSE 解析与三协议流式 chunk"
```

---

### Task R5: 流折叠 + Anthropic 请求侧 thinking + barrel

**Files:**

- Modify: `packages/zen/src/protocol/stream.ts`（追加 `collapseChunks`）
- Modify: `packages/zen/src/protocol/anthropic.ts`（请求侧补 `thinking` 块，承接 C1 移交项）
- Modify: `packages/zen/src/index.ts`
- Test: `packages/zen/src/__tests__/protocol-stream.test.ts` + `protocol-request.test.ts`（追加）

参考：`internal/protocol/collapse.go`。

- [ ] **Step 1: 写失败测试**

`protocol-stream.test.ts` 追加：

```ts
import { collapseChunks } from '../protocol/stream.js';

describe('zen collapse', () => {
  it('aggregates content, tool calls, reasoning and usage', () => {
    const res = collapseChunks([
      { id: 'gen_1', model: 'm', created: 1, delta: 'He', reasoning: 'r1' },
      { id: 'gen_1', model: 'm', created: 1, delta: 'llo' },
      {
        id: 'gen_1',
        model: 'm',
        created: 1,
        delta: '',
        finish_reason: 'tool_calls',
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"q":1}' } }],
      },
      { id: 'gen_1', model: 'm', created: 1, delta: '', usage: { total_tokens: 7 } },
    ]);
    assert.equal(res.id, 'gen_1');
    assert.equal(res.content, 'Hello');
    assert.equal(res.reasoning, 'r1');
    assert.equal(res.finish_reason, 'tool_calls');
    assert.equal(res.tool_calls?.[0]?.function.arguments, '{"q":1}');
    assert.equal(res.usage?.total_tokens, 7);
  });
});
```

`protocol-request.test.ts` 追加：

```ts
it('encodes assistant reasoning as a thinking block for anthropic', () => {
  const body = toAnthropicBody({
    model: 'm',
    messages: [{ role: 'assistant', content: 'answer', reasoning: 'step' }],
    max_tokens: 16,
  });
  const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.deepEqual(messages[0]?.content[0], { type: 'thinking', thinking: 'step' });
});
```

> `thinking` 块是否需要 `signature` 字段以被 Anthropic 接受，请对照 Go 决定；若需要且无法从 `ZenChatMessage.reasoning` 提供，按 Go 行为实现并在报告中说明（可能只对带 signature 的 reasoning 产出 thinking 块）。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

- `collapseChunks(chunks: ZenStreamChunk[]): ZenChatResponse`：拼接 `delta`、`reasoning`，按 `index` 合并 `tool_calls` 增量（追加 `arguments`），取最后一个非空 `finish_reason`/`usage`/`id`/`model`/`created`。
- `anthropic.ts` 请求侧：assistant 的 `reasoning` 产出 `{ type:'thinking', thinking }`（按 Go 处理 signature）。
- barrel 追加 `export * from './protocol/response.js'; export * from './protocol/stream.js';`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test && pnpm --filter @freemodelfinder/zen typecheck && pnpm --filter @freemodelfinder/zen build`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/stream.ts packages/zen/src/protocol/anthropic.ts packages/zen/src/index.ts packages/zen/src/__tests__/protocol-stream.test.ts packages/zen/src/__tests__/protocol-request.test.ts
git commit -m "feat(zen): 流折叠、Anthropic thinking 编码与协议 barrel"
```

---

## 验收清单（P1-C2）

- [ ] `pnpm --filter @freemodelfinder/zen test` 全绿
- [ ] `pnpm build:runtime`、`pnpm typecheck`、`pnpm lint` 通过
- [ ] 仅本计划列出的文件被提交

## 后续子阶段

- **P1-C3**：agent 形变（`prepareAnonymousBody`/`shapeKeyBody`）、`ForcedEffort`、stale-reasoning 重试。

## 终审移交项（P1-C3 / P1-D / P1-E 必须承接）

1. **流式同协议 `raw`/`rawProtocol` 未填充**（Important，计划缺口）：`StreamChunk.raw` 字段已定义但 `stream.ts` 无赋值点；spec「响应侧 raw 载体」要求流式同协议时回填原始 SSE 行。需在 P1-E 接线消费方之前补齐。
2. **Anthropic `thinking` 的 `signature` 不承载**（Important，显式有损）：`ZenChatMessage.reasoning`/`ZenChatResponse.reasoning` 均为纯字符串，`signature_delta` 与块内 `signature` 丢弃；同协议靠 `raw` 保真，跨协议重放可能被 Anthropic 拒绝无签名 thinking。需扩展 core/zen 类型或明确记为有损。
3. **Responses 流式的 `output_item.done` reasoning 与 `function_call_arguments.done` 兜底**（Minor）。
4. **`output_item` 关联键**：当前仅用 `output_index`，Go 用 `item.id ?? item_id ?? output_index`（`stream_parser.go:354-364`）；同 index 复用边界可能错配。
5. **chat 非流式在 `choices` 非空时忽略 `error`**（Minor，流式侧已修）。
6. **chat 空 content 回退 reasoning**（计划 R1 指定，偏离 Go，会让客户端收到重复内容）。

## 自查记录

1. **Spec 覆盖**：spec「中间表示策略」响应侧（同协议 `raw` 回流 + 跨协议结构化）由 R1–R3 落地；SSE（`stream.go` 族）由 R4；非流式折叠（`collapse.go`）由 R5；C1 移交的 Anthropic `thinking` 双向由 R2 + R5 落地。
2. **占位符扫描**：R2–R5 的逐字段映射以磁盘 Go 源为权威（已显式说明）；R1 给出完整代码（含 `parseAnthropicResponse`/`parseResponsesResponse` 的临时占位，R2/R3 替换）。
3. **类型一致性**：`ZenChatResponse`/`ZenStreamChunk`（R1）与 core `ChatResponse`/`StreamChunk`（P1-C1 C0）结构等价；`ZenToolCallDelta` 与 core 的同名类型一致。
