# P0：内部消息模型扩展（tools / tool_calls / reasoning）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 FreeModelFinder 的内部消息模型 `ChatRequest` / `ChatResponse` / `StreamChunk` 承载工具调用与 reasoning，并打通三条入站协议（OpenAI / Anthropic / Gemini）与三条出站序列化，使客户端传入的 `tools` 能到达 provider、上游返回的 `tool_calls` 能回到客户端。

**Architecture:** 以 `ChatRequest` 为结构化主干，新增 optional `raw` 字段保存入站原始 body（供后续 Zen 同协议零损透传使用）；所有新增字段一律 optional，缺省时行为与现状完全一致，因此现有 17 个 provider 无需改动。协议转换集中在 `packages/core/src/protocols/`，SSE 增量序列化在 `packages/server/src/routes/`。

**Tech Stack:** TypeScript、zod、Node.js 内置 test runner（`node --test` + `tsx`）、Fastify。

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-zen-integration-design.md`（阶段 P0 部分）

---

## 关键背景（执行前必读）

1. **测试放哪里**：`packages/core/package.json` 的 `test` / `test:coverage` 用**显式 glob 列举**测试目录（`src/__tests__/*.test.ts`、`src/providers/__tests__/*.test.ts` 等）。**`src/protocols/__tests__` 不在 glob 内，且该目录不存在**。因此本计划的 core 协议测试一律新建在 **`packages/core/src/__tests__/`**（已有 `protocols-vision.test.ts` 先例），**不需要改 package.json**。
2. **跑 core 测试**：`pnpm --filter @freemodelfinder/core test`
3. **跑 server 测试**（依赖 core 构建产物）：`pnpm build:runtime && pnpm --filter @freemodelfinder/server test`
4. **既有行为不可变**：所有新字段 optional。Task 11 的全量回归是硬闸门。
5. **仓库风格**：TypeScript strict + `noUncheckedIndexedAccess: true`；ESLint `no-explicit-any` 已关闭，但仍优先用具体类型；**不要写行尾注释**。

## 文件结构

| 文件 | 职责 | 动作 |
| --- | --- | --- |
| `packages/core/src/types.ts` | 全部消息类型与 zod schema | 修改（Task 1） |
| `packages/core/src/protocols/openai.ts` | OpenAI 入站转换 + 出站序列化 | 修改（Task 2、3） |
| `packages/core/src/providers/openai-messages.ts` | `ChatMessage[]` → provider 出站 OpenAI messages | 修改（Task 4） |
| `packages/core/src/protocols/anthropic.ts` | Anthropic 入站转换 + 出站序列化 | 修改（Task 5、6） |
| `packages/server/src/routes/anthropic.ts` | Anthropic SSE 出站 | 修改（Task 7） |
| `packages/core/src/protocols/gemini.ts` | Gemini 入站转换 + 出站序列化 | 修改（Task 8、9） |
| `packages/server/src/routes/gemini.ts` | Gemini SSE 出站 | 修改（Task 9） |
| `packages/core/src/providers/openai-compatible.ts` | 填充 `reasoning` 字段 | 修改（Task 10） |
| `packages/core/src/__tests__/protocols-tools.test.ts` | 协议层工具调用测试 | 新建（Task 2 起复用） |
| `packages/server/src/routes/__tests__/tools-stream.test.ts` | SSE 出站测试 | 新建（Task 7、9） |

---

### Task 1: 类型定义扩展

**Files:**
- Modify: `packages/core/src/types.ts`（`ChatMessageSchema` 约 47 行、`ChatRequestSchema` 约 60 行、`ChatResponse` 约 68 行、`StreamChunk` 约 84 行）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/__tests__/protocols-tools.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatRequestSchema } from '../types.js';

describe('tools typing', () => {
  it('parses a request carrying tools and raw', () => {
    const parsed = ChatRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } },
        },
      ],
      raw: { some: 'upstream-specific-field' },
    });
    assert.equal(parsed.tools?.[0]?.function.name, 'get_weather');
    assert.deepEqual(parsed.raw, { some: 'upstream-specific-field' });
  });

  it('keeps request parseable when tools and raw are absent', () => {
    const parsed = ChatRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(parsed.tools, undefined);
    assert.equal(parsed.raw, undefined);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `tools` 不是 `ChatRequestSchema` 的被允许属性（zod 报错 `Unrecognized key(s)`），且 `parsed.tools` 类型不存在导致 TS 编译报错。

- [ ] **Step 3: 最小实现**

在 `packages/core/src/types.ts` 中，`ChatContentPartSchema` 定义之后、`ChatMessageSchema` 之前插入：

```ts
export const ToolFunctionParametersSchema = z.record(z.unknown());

export const ToolDefinitionSchema = z.object({
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: ToolFunctionParametersSchema.optional(),
  }),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string().optional(),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().optional(),
    arguments: z.string().optional(),
  }).optional(),
});
export type ToolCallDelta = z.infer<typeof ToolCallDeltaSchema>;
```

修改 `ChatMessageSchema`，追加两个 optional 字段：

```ts
export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.string(),
  contentParts: z.array(ChatContentPartSchema).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  reasoning: z.string().optional(),
});
```

修改 `ChatRequestSchema`，追加两个 optional 字段：

```ts
export const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  raw: z.unknown().optional(),
});
```

修改 `ChatResponse` 接口：

```ts
export interface ChatResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  tool_calls?: ToolCall[];
  reasoning?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}
```

修改 `StreamChunk` 接口：

```ts
export interface StreamChunk {
  id: string;
  model: string;
  created: number;
  delta: string;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  tool_calls?: ToolCallDelta[];
  reasoning?: string;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS（全部既有测试 + 新增 2 例）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/protocols-tools.test.ts
git commit -m "feat(core): 消息模型扩展 tools/tool_calls/reasoning 与 raw 旁路"
```

---

### Task 2: OpenAI 入站保留 tools 与 raw

**Files:**
- Modify: `packages/core/src/protocols/openai.ts`（`OpenAIChatCompletionRequest` 约 9-22 行、`openAIToChatRequest` 约 53-73 行）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/__tests__/protocols-tools.test.ts` 追加：

```ts
import {
  chatResponseToOpenAI,
  openAIToChatRequest,
  type OpenAIChatCompletionRequest,
} from '../protocols/openai.js';
import type { ChatResponse } from '../types.js';

describe('openai inbound tools', () => {
  it('keeps tools and captures the raw body', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'search', parameters: { type: 'object' } } },
      ],
      seed: 7,
    } as unknown as OpenAIChatCompletionRequest;
    const out = openAIToChatRequest(body);
    assert.equal(out.tools?.[0]?.function.name, 'search');
    assert.deepEqual(out.raw, body);
  });

  it('omits tools and raw when the client sent neither', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    } as OpenAIChatCompletionRequest);
    assert.equal(out.tools, undefined);
    assert.equal(out.raw, undefined);
  });

  it('keeps assistant tool_calls on the message', () => {
    const out = openAIToChatRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
      ],
    } as unknown as OpenAIChatCompletionRequest);
    assert.equal(out.messages[0]?.tool_calls?.[0]?.id, 'call_1');
  });
});

describe('openai outbound tool_calls', () => {
  it('serializes tool_calls and tool_calls finish reason', () => {
    const res: ChatResponse = {
      id: 'x',
      model: 'm',
      created: 1,
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } },
      ],
    };
    const payload = chatResponseToOpenAI(res) as {
      choices: Array<{ message: Record<string, unknown>; finish_reason: string }>;
    };
    assert.equal(payload.choices[0]?.finish_reason, 'tool_calls');
    assert.deepEqual(payload.choices[0]?.message.tool_calls, res.tool_calls);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `out.tools` 为 `undefined`（入站丢弃）、`out.raw` 为 `undefined`、`payload.choices[0].message.tool_calls` 为 `undefined`。

- [ ] **Step 3: 实现入站**

修改 `packages/core/src/protocols/openai.ts` 顶部 import：

```ts
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from '../types.js';
```

扩展 `OpenAIChatCompletionRequest`：

```ts
export interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | OpenAIContentPart[] | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
    reasoning?: string;
  }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: ToolDefinition[];
}
```

改写 `openAIToChatRequest`：

```ts
export function openAIToChatRequest(req: OpenAIChatCompletionRequest): ChatRequest {
  const messages: ChatMessage[] = req.messages.map((m) => {
    const contentParts = extractContentParts(m.content);
    const tool_calls = m.tool_calls?.map(normalizeOpenAIToolCall);
    const reasoning = m.reasoning_content ?? m.reasoning;
    return {
      role: m.role,
      content: normalizeContent(m.content),
      contentParts,
      name: m.name,
      tool_call_id: m.tool_call_id,
      ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  });
  return {
    model: req.model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
    stop: req.stop,
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    raw: req,
  };
}
```

补充两个辅助函数（放在 `normalizeContent` 之后）：

```ts
function normalizeOpenAIToolCall(t: OpenAIToolCall): ToolCall {
  return {
    ...(t.id ? { id: t.id } : {}),
    type: 'function',
    function: {
      name: t.function?.name ?? '',
      ...(t.function?.arguments !== undefined ? { arguments: t.function.arguments } : {}),
    },
  };
}
```

`normalizeContent` 的入参类型需要接受 `null`：

```ts
function normalizeContent(
  c: OpenAIChatCompletionRequest['messages'][number]['content'],
): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  return c
    .filter((part) => part.type === 'text' || part.type === 'input_text')
    .map((part) => part.text ?? '')
    .join('');
}
```

`extractContentParts` 同样需要在 `!Array.isArray(c)` 前处理 `null`：

```ts
function extractContentParts(
  content: OpenAIChatCompletionRequest['messages'][number]['content'],
):
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  | undefined {
  if (!Array.isArray(content)) return undefined;
  // ... 原有循环保持不变
```

> 注意 `raw: req` 会把入站原始 body（含 `tools`、供应商特有字段如 `seed`）完整保留，这是 Zen 同协议透传的数据源。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/protocols/openai.ts packages/core/src/__tests__/protocols-tools.test.ts
git commit -m "feat(core): OpenAI 入站保留 tools/tool_calls 并捕获 raw body"
```

---

### Task 3: OpenAI 出站序列化 tool_calls 与 reasoning

**Files:**
- Modify: `packages/core/src/protocols/openai.ts`（`chatResponseToOpenAI` 约 75 行、`streamChunkToOpenAI` 约 92 行）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
import { streamChunkToOpenAI } from '../protocols/openai.js';
import type { StreamChunk } from '../types.js';

describe('openai stream tool deltas', () => {
  it('emits tool_calls deltas on the chunk', () => {
    const chunk: StreamChunk = {
      id: 'x',
      model: 'm',
      created: 1,
      delta: '',
      finish_reason: 'tool_calls',
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '' } }],
    };
    const payload = streamChunkToOpenAI(chunk) as {
      choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
    };
    assert.equal(payload.choices[0]?.finish_reason, 'tool_calls');
    assert.deepEqual(payload.choices[0]?.delta.tool_calls, chunk.tool_calls);
  });

  it('does not add tool_calls key when absent', () => {
    const payload = streamChunkToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      delta: 'hi',
      finish_reason: 'stop',
    }) as { choices: Array<{ delta: Record<string, unknown> }> };
    assert.equal('tool_calls' in (payload.choices[0]?.delta ?? {}), false);
  });

  it('carries reasoning on the chunk alongside content delta', () => {
    const payload = streamChunkToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      delta: '',
      reasoning: 'thinking…',
    }) as { choices: Array<{ delta: Record<string, unknown> }> };
    assert.equal(payload.choices[0]?.delta.reasoning, 'thinking…');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `finish_reason` 为 `null`、`delta.tool_calls` 不存在、`delta.reasoning` 不存在。

- [ ] **Step 3: 实现**

改写 `packages/core/src/protocols/openai.ts` 的两个出站函数：

```ts
export function chatResponseToOpenAI(res: ChatResponse) {
  const message: Record<string, unknown> = { role: 'assistant', content: res.content };
  if (res.tool_calls && res.tool_calls.length > 0) message.tool_calls = res.tool_calls;
  if (res.reasoning) message.reasoning = res.reasoning;
  return {
    id: res.id,
    object: 'chat.completion',
    created: res.created,
    model: res.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: res.finish_reason ?? 'stop',
      },
    ],
    usage: res.usage,
  };
}

export function streamChunkToOpenAI(chunk: StreamChunk) {
  const delta: Record<string, unknown> = {};
  if (chunk.delta) {
    delta.role = 'assistant';
    delta.content = chunk.delta;
  }
  if (chunk.tool_calls && chunk.tool_calls.length > 0) delta.tool_calls = chunk.tool_calls;
  if (chunk.reasoning) delta.reasoning = chunk.reasoning;
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: chunk.created,
    model: chunk.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: chunk.finish_reason ?? null,
      },
    ],
  };
}
```

> 保持 `delta` 在没有 content / tool_calls / reasoning 时为空对象（与现状 `chunk.delta ? {...} : {}` 语义一致）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/protocols/openai.ts packages/core/src/__tests__/protocols-tools.test.ts
git commit -m "feat(core): OpenAI 出站序列化 tool_calls 与 reasoning"
```

---

### Task 4: provider 出站 message 保留 tool 字段

**Files:**
- Modify: `packages/core/src/providers/openai-messages.ts`（全文件 20 行）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
describe('toOpenAIMessages tool fields', () => {
  it('keeps tool_call_id, name and assistant tool_calls', async () => {
    const { toOpenAIMessages } = await import('../providers/openai-messages.js');
    const out = toOpenAIMessages([
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
      ] },
      { role: 'tool', content: 'result', tool_call_id: 'call_1', name: 'f' },
    ]);
    assert.deepEqual(out[0], {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
      ],
    });
    assert.equal((out[1] as { tool_call_id?: string }).tool_call_id, 'call_1');
    assert.equal((out[1] as { name?: string }).name, 'f');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— 输出的 message 不含 `tool_calls` / `tool_call_id` / `name`。

- [ ] **Step 3: 实现**

重写 `packages/core/src/providers/openai-messages.ts`：

```ts
import type { ChatMessage } from '../types.js';

export interface OpenAIMessageOut {
  role: string;
  content: string | unknown[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatMessage['tool_calls'];
}

export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessageOut[] {
  return messages.map((m) => {
    const extras: Partial<OpenAIMessageOut> = {};
    if (m.name) extras.name = m.name;
    if (m.tool_call_id) extras.tool_call_id = m.tool_call_id;
    if (m.tool_calls && m.tool_calls.length > 0) extras.tool_calls = m.tool_calls;

    const hasImage = m.contentParts?.some((p) => p.type === 'image_url') ?? false;
    if (hasImage && m.contentParts) {
      return {
        role: m.role,
        content: m.contentParts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: p.image_url.url } },
        ),
        ...extras,
      };
    }
    return { role: m.role, content: m.content, ...extras };
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 检查既有调用方无破坏**

Run: `pnpm build:runtime && pnpm --filter @freemodelfinder/core typecheck`
Expected: 通过。`toOpenAIMessages` 的返回类型由 `Array<{ role: string; content: string | unknown[] }>` 收紧为具名接口（字段为 optional 超集），所有既有调用方兼容。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/providers/openai-messages.ts packages/core/src/__tests__/protocols-tools.test.ts
git commit -m "feat(core): provider 出站 message 保留 tool_call_id/name/tool_calls"
```

---

### Task 5: Anthropic 入站保留 tools、tool 内容块与 raw

**Files:**
- Modify: `packages/core/src/protocols/anthropic.ts`（`AnthropicMessagesRequest` 约 9-21 行、`anthropicToChatRequest` 约 60-83 行）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
import { anthropicToChatRequest, type AnthropicMessagesRequest } from '../protocols/anthropic.js';

describe('anthropic inbound tools', () => {
  it('maps tools, tool_use blocks and raw', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SH' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }],
        },
      ],
      tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object' } }],
      max_tokens: 64,
      metadata: { user_id: 'u1' },
    } as unknown as AnthropicMessagesRequest;

    const out = anthropicToChatRequest(body);
    assert.equal(out.tools?.[0]?.function.name, 'get_weather');
    assert.deepEqual(out.raw, body);
    const assistant = out.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant?.tool_calls?.[0]?.id, 'toolu_1');
    assert.equal(assistant?.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(assistant?.tool_calls?.[0]?.function.arguments, '{"city":"SH"}');
    const toolMsg = out.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg?.tool_call_id, 'toolu_1');
    assert.equal(toolMsg?.content, 'sunny');
  });

  it('omits tools and raw when absent', () => {
    const out = anthropicToChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    } as AnthropicMessagesRequest);
    assert.equal(out.tools, undefined);
    assert.equal(out.raw, undefined);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `out.tools` / `out.raw` 为 `undefined`，且 `tool_use` 块未被识别（`tool_calls` 缺失、`tool_result` 未转成 `role:'tool'` 消息）。

- [ ] **Step 3: 实现**

修改 `packages/core/src/protocols/anthropic.ts` 顶部 import：

```ts
import type {
  ChatMessage,
  ChatRequest,
  ToolCall,
  ToolDefinition,
} from '../types.js';
```

扩展接口与新增类型：

```ts
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  source?: { type?: string; media_type?: string; url?: string; data?: string };
}

export interface AnthropicMessagesRequest {
  model: string;
  system?: string | Array<{ type: 'text'; text: string }>;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | AnthropicBlock[];
  }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
}
```

在 `anthropicContentToParts` 之后新增工具块解析：

```ts
function blocksToToolCalls(blocks: AnthropicBlock[]): ToolCall[] | undefined {
  const calls: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue;
    calls.push({
      ...(b.id ? { id: b.id } : {}),
      type: 'function',
      function: {
        name: b.name ?? '',
        arguments: b.input === undefined ? '{}' : JSON.stringify(b.input),
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function blockText(block: AnthropicBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

function anthropicToolsToDefinitions(tools: AnthropicTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.input_schema ? { parameters: t.input_schema } : {}),
    },
  }));
}
```

改写 `anthropicToChatRequest`：

```ts
export function anthropicToChatRequest(req: AnthropicMessagesRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  if (req.system) {
    const sys =
      typeof req.system === 'string' ? req.system : req.system.map((s) => s.text).join('\n\n');
    messages.push({ role: 'system', content: sys });
  }
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    const toolCalls = blocksToToolCalls(m.content);
    const results = m.content.filter((b) => b.type === 'tool_result');
    const parts = anthropicContentToParts(m.content);

    if (results.length > 0) {
      for (const r of results) {
        messages.push({
          role: 'tool',
          content: blockText(r),
          tool_call_id: r.tool_use_id ?? '',
        });
      }
      continue;
    }

    const text = contentToString(m.content);
    const entry: ChatMessage = {
      role: m.role,
      content: text,
      contentParts: parts,
    };
    if (toolCalls) entry.tool_calls = toolCalls;
    messages.push(entry);
  }

  return {
    model: req.model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
    stop: req.stop_sequences,
    ...(req.tools && req.tools.length > 0
      ? { tools: anthropicToolsToDefinitions(req.tools) }
      : {}),
    raw: req,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/protocols/anthropic.ts packages/core/src/__tests__/protocols-tools.test.ts
git commit -m "feat(core): Anthropic 入站保留 tools/tool_use/tool_result 与 raw"
```

---

### Task 6: Anthropic 出站序列化 tool_use 块

**Files:**
- Modify: `packages/core/src/protocols/anthropic.ts`（`chatResponseToAnthropic` 约 85-109 行）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
import { chatResponseToAnthropic } from '../protocols/anthropic.js';

describe('anthropic outbound tool_use', () => {
  it('emits a tool_use block and stop_reason tool_use', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_1',
      model: 'm',
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } },
      ],
    }) as { content: Array<Record<string, unknown>>; stop_reason: string };
    assert.equal(payload.stop_reason, 'tool_use');
    const block = payload.content[0] as Record<string, unknown>;
    assert.equal(block.type, 'tool_use');
    assert.equal(block.id, 'call_1');
    assert.equal(block.name, 'f');
    assert.deepEqual(block.input, { q: 1 });
  });

  it('keeps text block when there are no tool calls', () => {
    const payload = chatResponseToAnthropic({
      id: 'msg_1',
      model: 'm',
      content: 'hello',
      finish_reason: 'stop',
    }) as { content: Array<Record<string, unknown>>; stop_reason: string };
    assert.equal(payload.stop_reason, 'end_turn');
    assert.deepEqual(payload.content, [{ type: 'text', text: 'hello' }]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `stop_reason` 为 `'tool_calls'`（未映射），`content` 只有 text 块。

- [ ] **Step 3: 实现**

`chatResponseToAnthropic` 的入参需要承载 `tool_calls`。先把它改成接受 `ChatResponse`（调用方 `packages/server/src/routes/anthropic.ts:93` 传的就是 `ChatResponse`，字段兼容）：

```ts
export function chatResponseToAnthropic(res: ChatResponse) {
  const content: Array<Record<string, unknown>> = [];
  if (res.tool_calls && res.tool_calls.length > 0) {
    for (const call of res.tool_calls) {
      let input: unknown = {};
      const rawArgs = call.function.arguments;
      if (rawArgs) {
        try {
          input = JSON.parse(rawArgs);
        } catch {
          input = {};
        }
      }
      content.push({
        type: 'tool_use',
        id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: call.function.name,
        input,
      });
    }
  } else {
    content.push({ type: 'text', text: res.content });
  }
  if (res.reasoning) {
    content.unshift({ type: 'text', text: res.reasoning });
  }

  const stop_reason =
    res.finish_reason === 'length'
      ? 'max_tokens'
      : res.finish_reason === 'tool_calls'
        ? 'tool_use'
        : res.finish_reason === 'stop'
          ? 'end_turn'
          : res.finish_reason;

  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content,
    stop_reason,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}
```

同时需要在文件顶部 import `ChatResponse`：

```ts
import type { ChatMessage, ChatRequest, ChatResponse, ToolCall, ToolDefinition } from '../types.js';
```

并把 `packages/server/src/routes/anthropic.ts:4` 的 import 保持不变（它已经导入 `ChatResponse`，`chatResponseToAnthropic(response)` 的实参类型本就是 `ChatResponse`）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 服务端编译检查**

Run: `pnpm build:runtime && pnpm --filter @freemodelfinder/server typecheck`
Expected: 通过（`chatResponseToAnthropic` 入参从匿名结构体改为 `ChatResponse`，调用方实参已是 `ChatResponse`）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/protocols/anthropic.ts packages/core/src/__tests__/protocols-tools.test.ts
git commit -m "feat(core): Anthropic 出站序列化 tool_use 块与 stop_reason"
```

---

### Task 7: Anthropic SSE 路由支持多 content_block

**Files:**
- Modify: `packages/server/src/routes/anthropic.ts`（流式分支约 140-164 行）
- Test: `packages/server/src/routes/__tests__/tools-stream.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `packages/server/src/routes/__tests__/tools-stream.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatRequest, StreamChunk } from '@freemodelfinder/core';

interface FakeProvider {
  id: string;
  chat(req: ChatRequest): Promise<never>;
  stream(req: ChatRequest): AsyncIterable<StreamChunk>;
}

function makeRegistry(provider: FakeProvider) {
  return {
    resolveModel: () => ({ provider, modelId: 'm' }),
    getAutoRouter: () => ({
      isEnabled: () => false,
      preflight: async () => ({ switched: false }),
      maybeSwitchBack: async () => null,
      markRateLimited: () => undefined,
      rememberPreference: () => undefined,
      notify: () => undefined,
    }),
  };
}

async function collectAnthropicStream(chunks: StreamChunk[]): Promise<string> {
  const { registerAnthropicRoutes } = await import('../../routes/anthropic.js');
  const written: string[] = [];
  const provider: FakeProvider = {
    id: 'fake',
    chat: async () => {
      throw new Error('unused');
    },
    stream: async function* () {
      for (const c of chunks) yield c;
    },
  };
  const app = {
    post: (path: string, handler: unknown) => {
      app.handler = handler;
      app.path = path;
    },
    handler: undefined as unknown,
    path: '',
  };
  registerAnthropicRoutes(app as never, () => makeRegistry(provider) as never);

  const reply = {
    raw: {
      writeHead: () => undefined,
      write: (s: string) => {
        written.push(s);
      },
      end: () => undefined,
    },
  };
  await (app.handler as (req: unknown, rep: unknown) => Promise<void>)(
    {
      body: {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
        stream: true,
      },
    },
    reply,
  );
  return written.join('');
}

describe('anthropic sse tool blocks', () => {
  it('opens and closes a tool_use content block', async () => {
    const out = await collectAnthropicStream([
      { id: 'x', model: 'm', created: 1, delta: 'thinking' },
      {
        id: 'x',
        model: 'm',
        created: 1,
        delta: '',
        finish_reason: 'tool_calls',
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{}' } }],
      },
    ]);
    assert.ok(out.includes('"type":"content_block_start"'));
    assert.ok(out.includes('"type":"tool_use"'));
    assert.ok(out.includes('"type":"input_json_delta"'));
    assert.ok(out.includes('"stop_reason":"tool_use"'));
    assert.ok(out.includes('event: message_stop'));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build:runtime && pnpm --filter @freemodelfinder/server test`
Expected: FAIL —— 输出中没有 `"type":"tool_use"` 与 `"type":"input_json_delta"`。

- [ ] **Step 3: 实现**

替换 `packages/server/src/routes/anthropic.ts` 中从 `write('content_block_start'` 到 `write('message_delta'` 之前的整段：

```ts
      write('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });

      let toolBlockOpen = false;
      let toolBlockIndex = 0;

      try {
        for await (const chunk of provider.stream(dispatchReq)) {
          if (chunk.tool_calls && chunk.tool_calls.length > 0) {
            if (toolBlockOpen) {
              write('content_block_stop', { type: 'content_block_stop', index: toolBlockIndex });
            }
            toolBlockIndex += 1;
            toolBlockOpen = true;
            const first = chunk.tool_calls[0]!;
            write('content_block_start', {
              type: 'content_block_start',
              index: toolBlockIndex,
              content_block: {
                type: 'tool_use',
                id: first.id ?? `toolu_${toolBlockIndex}`,
                name: first.function.name,
                input: {},
              },
            });
            const args = first.function.arguments;
            if (args) {
              write('content_block_delta', {
                type: 'content_block_delta',
                index: toolBlockIndex,
                delta: { type: 'input_json_delta', partial_json: args },
              });
            }
            continue;
          }
          if (chunk.delta) {
            if (toolBlockOpen) {
              write('content_block_stop', {
                type: 'content_block_stop',
                index: toolBlockIndex,
              });
              toolBlockOpen = false;
              toolBlockIndex += 1;
              write('content_block_start', {
                type: 'content_block_start',
                index: toolBlockIndex,
                content_block: { type: 'text', text: '' },
              });
            }
            write('content_block_delta', {
              type: 'content_block_delta',
              index: toolBlockIndex,
              delta: { type: 'text_delta', text: chunk.delta },
            });
          }
        }
        if (toolBlockOpen) {
          write('content_block_stop', { type: 'content_block_stop', index: toolBlockIndex });
        } else {
          write('content_block_stop', { type: 'content_block_stop', index: toolBlockIndex });
        }
        write('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason:
              chunkFinishReason === 'tool_calls' || toolBlockOpen ? 'tool_use' : 'end_turn',
          },
          usage: { output_tokens: 0 },
        });
```

同时需要在循环外记录最后一个 `finish_reason`。在 `let toolBlockOpen = false;` 上方声明：

```ts
      let chunkFinishReason: string | null = null;
```

并在循环体内每轮赋值：

```ts
          if (chunk.finish_reason) chunkFinishReason = chunk.finish_reason;
```

> 上面两个分支都写 `content_block_stop` 属于刻意简化：文本块与工具块的收尾逻辑一致，保留单点写出避免漏写。若实现时更倾向合并为循环后的统一一次写出，可自行收敛，但**测试断言的三个事件必须都在**。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build:runtime && pnpm --filter @freemodelfinder/server test`
Expected: PASS（含既有全部 server 测试）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/anthropic.ts packages/server/src/routes/__tests__/tools-stream.test.ts
git commit -m "feat(server): Anthropic SSE 输出 tool_use 内容块"
```

---

### Task 8: Gemini 入站保留 tools、functionCall 与 raw

**Files:**
- Modify: `packages/core/src/protocols/gemini.ts`（`GeminiHttpRequest` 约 9-21 行、`geminiToChatRequest` 约 23-74 行）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
import { geminiToChatRequest, type GeminiHttpRequest } from '../protocols/gemini.js';

describe('gemini inbound tools', () => {
  it('maps functionDeclarations, functionCall and functionResponse', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'SH' } } }],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'get_weather', response: { r: 'sunny' } } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] }],
      generationConfig: { temperature: 0.2 },
    } as unknown as GeminiHttpRequest;

    const out = geminiToChatRequest('m', body);
    assert.equal(out.tools?.[0]?.function.name, 'get_weather');
    assert.deepEqual(out.raw, body);

    const modelMsg = out.messages.find((m) => m.role === 'assistant');
    assert.equal(modelMsg?.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(modelMsg?.tool_calls?.[0]?.function.arguments, '{"city":"SH"}');

    const fnResp = out.messages.find((m) => m.role === 'tool');
    assert.equal(fnResp?.content, '{"r":"sunny"}');
    assert.equal(fnResp?.name, 'get_weather');
  });

  it('omits tools and raw when absent', () => {
    const out = geminiToChatRequest('m', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    } as GeminiHttpRequest);
    assert.equal(out.tools, undefined);
    assert.equal(out.raw, undefined);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `out.tools` / `out.raw` 为 `undefined`，`functionCall` 未转成 `tool_calls`。

- [ ] **Step 3: 实现**

修改 `packages/core/src/protocols/gemini.ts` import：

```ts
import type { ChatMessage, ChatRequest, ToolCall, ToolDefinition } from '../types.js';
```

扩展接口：

```ts
interface GeminiContentPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: unknown };
}

interface GeminiToolDeclaration {
  functionDeclarations?: Array<{
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

export interface GeminiHttpRequest {
  contents: Array<{
    role: 'user' | 'model';
    parts: GeminiContentPart[];
  }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: GeminiToolDeclaration[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
}
```

新增转换辅助（放在 `geminiToChatRequest` 之前）：

```ts
function geminiToolsToDefinitions(tools: GeminiToolDeclaration[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const t of tools) {
    for (const d of t.functionDeclarations ?? []) {
      if (!d.name) continue;
      out.push({
        type: 'function',
        function: {
          name: d.name,
          ...(d.description ? { description: d.description } : {}),
          ...(d.parameters ? { parameters: d.parameters } : {}),
        },
      });
    }
  }
  return out;
}

function geminiFunctionCalls(parts: GeminiContentPart[]): ToolCall[] | undefined {
  const calls: ToolCall[] = [];
  for (const p of parts) {
    if (!p.functionCall?.name) continue;
    calls.push({
      type: 'function',
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}
```

改写 `geminiToChatRequest` 的 contents 循环体（`for (const c of req.contents)` 内）：

```ts
  for (const c of req.contents) {
    const responses = c.parts.filter((p) => p.functionResponse?.name);
    if (responses.length > 0) {
      for (const r of responses) {
        const fn = r.functionResponse!;
        messages.push({
          role: 'tool',
          name: fn.name ?? '',
          content: JSON.stringify(fn.response ?? {}),
        });
      }
      continue;
    }

    const text = c.parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text!)
      .join('');
    const parts: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    > = [];
    let sawImage = false;
    for (const p of c.parts) {
      if (p.inlineData?.data) {
        const mime = p.inlineData.mimeType ?? 'image/png';
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${p.inlineData.data}` },
        });
        sawImage = true;
      } else if (p.fileData?.fileUri) {
        parts.push({ type: 'image_url', image_url: { url: p.fileData.fileUri } });
        sawImage = true;
      } else if (typeof p.text === 'string') {
        parts.push({ type: 'text', text: p.text });
      }
    }
    const entry: ChatMessage = {
      role: c.role === 'model' ? 'assistant' : 'user',
      content: text,
      contentParts: sawImage ? parts : undefined,
    };
    const calls = geminiFunctionCalls(c.parts);
    if (calls) entry.tool_calls = calls;
    messages.push(entry);
  }
```

并在 return 中加入 `tools` 与 `raw`：

```ts
  const tools = req.tools ? geminiToolsToDefinitions(req.tools) : [];
  return {
    model,
    messages,
    temperature: req.generationConfig?.temperature,
    top_p: req.generationConfig?.topP,
    max_tokens: req.generationConfig?.maxOutputTokens,
    stop: req.generationConfig?.stopSequences,
    stream,
    ...(tools.length > 0 ? { tools } : {}),
    raw: req,
  };
```

> ⚠️ 这里 `raw: req` 是**无条件**的，与 openai/anthropic 的条件写法不同。为保持三协议一致，请改成：仅当 `req.tools` 存在或 `req.contents` 含 functionCall/functionResponse 时才写入 `raw`。实现方式：

```ts
  const rawRelevant =
    (req.tools?.length ?? 0) > 0 ||
    req.contents.some((c) => c.parts.some((p) => p.functionCall || p.functionResponse));
  return {
    model,
    messages,
    temperature: req.generationConfig?.temperature,
    top_p: req.generationConfig?.topP,
    max_tokens: req.generationConfig?.maxOutputTokens,
    stop: req.generationConfig?.stopSequences,
    stream,
    ...(tools.length > 0 ? { tools } : {}),
    ...(rawRelevant ? { raw: req } : {}),
  };
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/protocols/gemini.ts packages/core/src/__tests__/protocols-tools.test.ts
git commit -m "feat(core): Gemini 入站保留 functionDeclarations/functionCall 与 raw"
```

---

### Task 9: Gemini 出站序列化 functionCall

**Files:**
- Modify: `packages/core/src/protocols/gemini.ts`（`chatResponseToGemini` 约 76-105 行）
- Modify: `packages/server/src/routes/gemini.ts`（流式 parts 构造，约 130-150 行）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（追加）+ `packages/server/src/routes/__tests__/tools-stream.test.ts`（追加）

- [ ] **Step 1: 写失败测试（core）**

```ts
import { chatResponseToGemini } from '../protocols/gemini.js';

describe('gemini outbound functionCall', () => {
  it('emits a functionCall part and FINISH_REASON_UNSPECIFIED is not used', () => {
    const payload = chatResponseToGemini({
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } }],
    }) as {
      candidates: Array<{ content: { parts: Array<Record<string, unknown>> }; finishReason: string }>;
    };
    assert.equal(payload.candidates[0]?.finishReason, 'STOP');
    const part = payload.candidates[0]?.content.parts[0] as Record<string, unknown>;
    assert.equal((part.functionCall as { name: string }).name, 'f');
    assert.deepEqual((part.functionCall as { args: unknown }).args, { q: 1 });
  });

  it('keeps text part when there are no tool calls', () => {
    const payload = chatResponseToGemini({
      content: 'hello',
      finish_reason: 'stop',
    }) as {
      candidates: Array<{ content: { parts: Array<Record<string, unknown>> } }>;
    };
    assert.deepEqual(payload.candidates[0]?.content.parts, [{ text: 'hello' }]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `parts[0]` 是 `{text: ''}`，不含 `functionCall`。

- [ ] **Step 3: 实现 core 出站**

改写 `chatResponseToGemini` 的入参与内容构造（入参类型对齐 `ChatResponse` 的子集）：

```ts
export function chatResponseToGemini(res: {
  content: string;
  finish_reason: string | null;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}) {
  const parts: Array<Record<string, unknown>> = [];
  if (res.tool_calls && res.tool_calls.length > 0) {
    for (const call of res.tool_calls) {
      let args: unknown = {};
      if (call.function.arguments) {
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = {};
        }
      }
      parts.push({ functionCall: { name: call.function.name, args } });
    }
  } else {
    parts.push({ text: res.content });
  }

  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts,
        },
        finishReason:
          res.finish_reason === 'length'
            ? 'MAX_TOKENS'
            : res.finish_reason === 'stop' || res.finish_reason === 'tool_calls'
              ? 'STOP'
              : res.finish_reason?.toUpperCase(),
        index: 0,
      },
    ],
    usageMetadata: res.usage
      ? {
          promptTokenCount: res.usage.prompt_tokens ?? 0,
          candidatesTokenCount: res.usage.completion_tokens ?? 0,
          totalTokenCount: res.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
```

- [ ] **Step 4: 写失败测试（server 流式）**

在 `packages/server/src/routes/__tests__/tools-stream.test.ts` 追加：

```ts
async function collectGeminiStream(chunks: StreamChunk[]): Promise<string> {
  const { registerGeminiRoutes } = await import('../../routes/gemini.js');
  const written: string[] = [];
  const provider: FakeProvider = {
    id: 'fake',
    chat: async () => {
      throw new Error('unused');
    },
    stream: async function* () {
      for (const c of chunks) yield c;
    },
  };
  const app = {
    post: (path: string, handler: unknown) => {
      app.handlers.set(path, handler);
    },
    handlers: new Map<string, unknown>(),
  };
  registerGeminiRoutes(app as never, () => makeRegistry(provider) as never);

  const handler = [...app.handlers.entries()].find(([p]) => p.includes('streamGenerateContent'))![1];
  const reply = {
    raw: {
      writeHead: () => undefined,
      write: (s: string) => {
        written.push(s);
      },
      end: () => undefined,
    },
  };
  await (handler as (req: unknown, rep: unknown) => Promise<void>)(
    {
      body: {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
      params: { model: 'm' },
      query: { alt: 'sse' },
    },
    reply,
  );
  return written.join('');
}

describe('gemini sse functionCall', () => {
  it('emits a functionCall part on the stream', async () => {
    const out = await collectGeminiStream([
      {
        id: 'x',
        model: 'm',
        created: 1,
        delta: '',
        finish_reason: 'tool_calls',
        tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"q":1}' } }],
      },
    ]);
    assert.ok(out.includes('"functionCall"'));
    assert.ok(out.includes('"name":"f"'));
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `pnpm build:runtime && pnpm --filter @freemodelfinder/server test`
Expected: FAIL —— 流式输出不含 `"functionCall"`。

- [ ] **Step 6: 实现 server 流式**

替换 `packages/server/src/routes/gemini.ts` 流式循环内的 payload 构造：

```ts
    for await (const chunk of provider.stream(dispatchReq)) {
      const parts: Array<Record<string, unknown>> = [];
      if (chunk.tool_calls && chunk.tool_calls.length > 0) {
        for (const call of chunk.tool_calls) {
          let args: unknown = {};
          if (call.function.arguments) {
            try {
              args = JSON.parse(call.function.arguments);
            } catch {
              args = {};
            }
          }
          parts.push({ functionCall: { name: call.function.name, args } });
        }
      } else if (chunk.delta) {
        parts.push({ text: chunk.delta });
      }
      const payload = {
        candidates: [
          {
            content: { role: 'model', parts },
            index: 0,
            finishReason:
              chunk.finish_reason === 'stop' || chunk.finish_reason === 'tool_calls'
                ? 'STOP'
                : chunk.finish_reason === 'length'
                  ? 'MAX_TOKENS'
                  : null,
          },
        ],
      };
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
```

- [ ] **Step 7: 运行确认通过**

Run: `pnpm build:runtime && pnpm --filter @freemodelfinder/server test && pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/protocols/gemini.ts packages/server/src/routes/gemini.ts \
        packages/core/src/__tests__/protocols-tools.test.ts packages/server/src/routes/__tests__/tools-stream.test.ts
git commit -m "feat: Gemini 出站序列化 functionCall（core + SSE 流式）"
```

---

### Task 10: OpenAI 兼容 provider 填充 reasoning 字段

**Files:**
- Modify: `packages/core/src/providers/openai-compatible.ts`（`chat()` 约 52-86 行、`stream()` 约 88-142 行）
- Test: `packages/core/src/providers/__tests__/provider-contracts.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/providers/__tests__/provider-contracts.test.ts` 追加（沿用该文件既有的 `ProviderContext.fetchImpl` 注入模式；下方 `makeProvider` 需按该文件已有的 provider 构造方式替换为真实子类）：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpenAICompatibleProvider } from '../openai-compatible.js';
import type { ModelInfo, ProviderId } from '../../types.js';

class ReasoningProbeProvider extends OpenAICompatibleProvider {
  readonly id: ProviderId = 'custom';
  readonly displayName = 'Probe';
  protected baseUrl(): string {
    return 'https://upstream.example/v1';
  }
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}

const SSE = [
  'data: {"id":"c1","model":"m","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"step one"},"finish_reason":null}]}',
  '',
  'data: {"id":"c1","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

describe('openai-compatible reasoning field', () => {
  it('surfaces reasoning on the chunk without dropping it', async () => {
    const provider = new ReasoningProbeProvider({
      credentials: { apiKey: 'k' },
      fetchImpl: (async () =>
        new Response(SSE, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch,
    });
    const seen: Array<{ delta: string; reasoning?: string }> = [];
    for await (const chunk of provider.stream({ model: 'm', messages: [], stream: true })) {
      seen.push({ delta: chunk.delta, ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}) });
    }
    assert.equal(seen[0]?.reasoning, 'step one');
    assert.equal(seen[0]?.delta, '');
    assert.equal(seen[1]?.delta, 'answer');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `seen[0].reasoning` 为 `undefined`（现有实现把 reasoning 合并进了 `delta`，实际会得到 `delta === 'step one'`）。

- [ ] **Step 3: 实现**

在 `packages/core/src/providers/openai-compatible.ts` 的 `OpenAILikeChoice` 中确认 `delta.reasoning` 已存在（已有）。改写 `stream()` 循环内的 chunk 构造：

```ts
          const choice = json.choices[0];
          const primaryDelta = choice?.delta?.content ?? '';
          const reasoningDelta =
            (choice?.delta?.reasoning_content ?? '') || (choice?.delta?.reasoning ?? '');
          yield {
            id: json.id,
            model: json.model,
            created: json.created,
            delta: primaryDelta || reasoningDelta,
            finish_reason: (choice?.finish_reason ?? null) as StreamChunk['finish_reason'],
            ...(reasoningDelta && !primaryDelta ? { reasoning: reasoningDelta } : {}),
          };
```

改写 `chat()` 中的 reasoning 处理（保持 `content` 语义不变，另填 `reasoning`）：

```ts
    const choice = data.choices[0];
    const msg = choice?.message;
    const primary = typeof msg?.content === 'string' ? msg.content : '';
    const reasoning =
      (typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '') ||
      (typeof msg?.reasoning === 'string' ? msg.reasoning : '');
    const content = primary || reasoning;
    return {
      id: data.id,
      model: data.model,
      created: data.created,
      content,
      finish_reason: (choice?.finish_reason ?? 'stop') as ChatResponse['finish_reason'],
      ...(reasoning && !primary ? { reasoning } : {}),
      usage: data.usage,
    };
```

> **不改变既有 `content` 行为**：`content = primary || reasoning` 原样保留。新增的 `reasoning` 字段仅在「只有 reasoning、没有正文」时填充，因此对所有既有调用方是纯增量。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/providers/openai-compatible.ts packages/core/src/providers/__tests__/provider-contracts.test.ts
git commit -m "feat(core): OpenAI 兼容 provider 分离输出 reasoning 字段"
```

---

### Task 11: 全量验证与收尾

**Files:**
- 无新增；仅验证。

- [ ] **Step 1: 构建运行时**

Run: `pnpm build:runtime`
Expected: core 与 server 构建成功，无 TS 错误。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 全部 package 通过。

- [ ] **Step 3: Lint（零警告）**

Run: `pnpm lint`
Expected: `0 warnings`。

- [ ] **Step 4: 格式检查**

Run: `pnpm format:check`
Expected: 全部通过。若失败，运行 `pnpm exec prettier --write <失败文件>` 后重跑。

- [ ] **Step 5: 覆盖率闸门**

Run: `pnpm test:coverage`
Expected: core ≥ 85% lines / 74% branches，server ≥ 80% / 75%，cli ≥ 80% lines，ui 通过。**若覆盖率因新增分支下降，补测试而不是调低阈值。**

- [ ] **Step 6: 17 个既有 provider 回归确认**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: `providers/__tests__/` 下全部既有用例（`provider-contracts`、`agnes-multimodal`、`cline`、`cline-catalog`、`free-catalog`）通过，无需改动任何 provider 实现文件。

- [ ] **Step 7: 完整测试与打包**

Run: `pnpm test && pnpm build && pnpm test:pack`
Expected: 全部通过。

- [ ] **Step 8: 提交（如有格式化改动）**

```bash
git add -A
git commit -m "chore: P0 内部消息模型扩展全量验证"
```

---

## 验收清单（对应 spec 验收标准 1、2、7）

- [ ] 客户端传 `tools` → `ChatRequest.tools` 存在 → provider 出站 body 含 `tools`
- [ ] 上游返回 `tool_calls` → `ChatResponse.tool_calls` → 三协议出站均可表达
- [ ] 三协议入站的工具定义不再丢弃
- [ ] `ChatRequest.raw` 捕获入站原始 body（供 P1 Zen 同协议透传）
- [ ] 现有 17 个 provider 测试原样通过，行为无变化
- [ ] `pnpm lint` 零警告、`pnpm typecheck` 通过、`pnpm test:coverage` 达标

## 自查记录

1. **Spec 覆盖**：spec「阶段 P0」清单 5 项 —— ①类型扩展（Task 1）②三入站保留 tools + raw（Task 2/5/8）③三出站序列化（Task 3/6/9 + Task 4 的 provider 出站 message）④SSE 增量（Task 3/7/9）⑤回归（Task 11）。✅ 无缺口。
2. **占位符扫描**：无 TBD / TODO / "similar to Task N"；每个代码步骤均给出完整代码或精确修改点。Task 7 Step 3 中标注的双分支 `content_block_stop` 已显式说明是刻意简化并给出收敛许可。
3. **类型一致性**：`ToolDefinition.function.name` / `ToolCall.function.arguments` / `ToolCallDelta.index` 在 Task 1 定义后，Task 2-9 的用法一致；`chatResponseToAnthropic` 在 Task 6 改为 `ChatResponse` 入参，Task 7 的调用方无需改动；`chatResponseToGemini` 入参为结构化子集，Task 9 的调用方 `routes/gemini.ts` 传入的是 `ChatResponse`，超集兼容。
