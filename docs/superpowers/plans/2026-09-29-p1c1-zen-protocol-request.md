# P1-C1：Zen 协议请求转换 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@freemodelfinder/zen` 中落地「把统一的 Zen 请求（含 tools / tool_calls / reasoning / 图片 / `raw` 旁路）编码成目标上游协议请求体（chat / responses / anthropic）」，并在「入站协议 == 目标协议」时走 `raw` 零损透传。

**Architecture:** 沿用 P1-A/B 的包结构，新增 `packages/zen/src/protocol/`。请求侧先定义与 core `ChatRequest` 结构等价的 Zen 请求模型（zen 不依赖 core），再由 `prepareRequest` 按目标协议分派：同协议直接克隆 `raw` 并改写 `model`；跨协议走结构化编码。

**Tech Stack:** TypeScript、Node.js 内置 test runner（`node --test` + `tsx`）。

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-zen-integration-design.md`（「中间表示策略」节）
**参考实现（磁盘上，供逐字段对照）:** `E:\AImoney\opencode2api\opencode2api\internal\protocol\{request,bridge,content}.go`

---

## 执行约定（重要）

opencode2api 的 `protocol` 包约 3800 行 Go，无法在计划里逐行内联。因此本计划提供：**精确接口、精确测试用例、关键算法代码**；**逐字段的协议映射请对照磁盘上的 Go 源码**（路径见上，也可用 `$env:TEMP\opencode\opencode2api`）。执行者必须先读对应 Go 文件再编码，reviewer 会对照 Go 源核对。

本计划**只做请求转换**（`ChatRequest` 侧 → 上游 body）。响应转换与 SSE 在 P1-C2，agent 形变 / `ForcedEffort` / stale-reasoning 重试在 P1-C3。

## 文件结构（P1-C1）

| 文件                                     | 职责                                                                                                    | 任务 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---- |
| `packages/core/src/types.ts`             | `ChatResponse.raw`/`StreamChunk.raw` + `rawProtocol`（P1-C 前置）                                       | C0   |
| `packages/zen/src/protocol/types.ts`     | `ZenProtocol`、`ZenClientProtocol`、`ZenChatRequest`/`ZenChatMessage`/`ZenToolDefinition`/`ZenToolCall` | C1   |
| `packages/zen/src/protocol/chat.ts`      | 结构化 → OpenAI Chat Completions body                                                                   | C2   |
| `packages/zen/src/protocol/anthropic.ts` | 结构化 → Anthropic Messages body                                                                        | C3   |
| `packages/zen/src/protocol/responses.ts` | 结构化 → OpenAI Responses body                                                                          | C4   |
| `packages/zen/src/protocol/request.ts`   | `prepareRequest` 分派 + 同协议 `raw` 短路                                                               | C5   |
| `packages/zen/src/index.ts`              | barrel 追加 protocol                                                                                    | C5   |

---

### Task C0: core 响应侧 `raw` 载体（P1-C 前置）

**Files:**

- Modify: `packages/core/src/types.ts`（`ChatResponse`、`StreamChunk` 接口）
- Test: `packages/core/src/__tests__/protocols-tools.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/__tests__/protocols-tools.test.ts` 追加：

```ts
describe('response raw carrier', () => {
  it('does not leak ChatResponse.raw into the OpenAI wire payload', () => {
    const payload = chatResponseToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      content: 'hi',
      finish_reason: 'stop',
      raw: { secretUpstreamField: 1 },
      rawProtocol: 'openai',
    }) as Record<string, unknown>;
    assert.equal('raw' in payload, false);
    assert.equal(JSON.stringify(payload).includes('secretUpstreamField'), false);
  });

  it('does not leak StreamChunk.raw into the OpenAI stream delta', () => {
    const payload = streamChunkToOpenAI({
      id: 'x',
      model: 'm',
      created: 1,
      delta: 'hi',
      raw: { secretUpstreamField: 1 },
      rawProtocol: 'openai',
    }) as Record<string, unknown>;
    assert.equal(JSON.stringify(payload).includes('secretUpstreamField'), false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: FAIL —— `raw`/`rawProtocol` 不是 `ChatResponse`/`StreamChunk` 的已知属性（TS 编译报错）。

- [ ] **Step 3: 实现**

`packages/core/src/types.ts` 的 `ChatResponse` 追加：

```ts
  raw?: unknown;
  rawProtocol?: 'openai' | 'anthropic' | 'gemini';
```

`StreamChunk` 追加：

```ts
  raw?: unknown;
  rawProtocol?: 'openai' | 'anthropic' | 'gemini';
```

（放在 `usage?` 之前，与 `reasoning?` 相邻。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/core test`
Expected: PASS（既有 399 例 + 新增 2 例 = 401）。**这条测试同时锁定了「现有出站序列化不会泄漏 `raw`」**。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/protocols-tools.test.ts
git commit -m "feat(core): ChatResponse/StreamChunk 增加 raw 响应载体"
```

---

### Task C1: Zen 请求模型与协议类型

**Files:**

- Create: `packages/zen/src/protocol/types.ts`
- Test: `packages/zen/src/__tests__/protocol-request.test.ts`（本任务先建，后续 C2–C5 追加）

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/protocol-request.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isZenProtocol } from '../protocol/types.js';

describe('zen protocol types', () => {
  it('accepts the three native protocols', () => {
    assert.equal(isZenProtocol('chat'), true);
    assert.equal(isZenProtocol('responses'), true);
    assert.equal(isZenProtocol('anthropic'), true);
  });

  it('rejects anything else', () => {
    assert.equal(isZenProtocol('systemone'), false);
    assert.equal(isZenProtocol(''), false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/protocol/types.ts`：

```ts
export type ZenProtocol = 'chat' | 'responses' | 'anthropic';
export type ZenClientProtocol = 'openai' | 'anthropic' | 'gemini';

export function isZenProtocol(value: string): value is ZenProtocol {
  return value === 'chat' || value === 'responses' || value === 'anthropic';
}

export interface ZenToolDefinition {
  type?: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ZenToolCall {
  id?: string;
  type?: 'function';
  function: { name: string; arguments?: string };
}

export interface ZenContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface ZenChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  contentParts?: ZenContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ZenToolCall[];
  reasoning?: string;
}

export interface ZenChatRequest {
  model: string;
  messages: ZenChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: ZenToolDefinition[];
  raw?: unknown;
  rawProtocol?: ZenClientProtocol;
}

export type ZenRequest = ZenChatRequest;
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/types.ts packages/zen/src/__tests__/protocol-request.test.ts
git commit -m "feat(zen): 协议类型与 Zen 请求模型"
```

---

### Task C2: 结构化 → OpenAI Chat Completions body

**Files:**

- Create: `packages/zen/src/protocol/chat.ts`
- Test: `packages/zen/src/__tests__/protocol-request.test.ts`（追加）

参考：`internal/protocol/request.go` 的 chat 编码路径、`internal/protocol/content.go`。

- [ ] **Step 1: 写失败测试**

追加：

```ts
import { toChatBody } from '../protocol/chat.js';

describe('zen chat body encoding', () => {
  it('encodes messages, tools, tool_calls and tool results', () => {
    const body = toChatBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'result', tool_call_id: 'call_1' },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      temperature: 0.3,
      max_tokens: 64,
      stream: true,
    });
    assert.equal(body.model, 'm');
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 64);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.role, 'system');
    assert.deepEqual(messages[2]?.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
    ]);
    assert.equal((messages[3] as Record<string, unknown>).tool_call_id, 'call_1');
    assert.deepEqual(body.tools, [
      { type: 'function', function: { name: 'f', parameters: { type: 'object' } } },
    ]);
  });

  it('encodes image content parts as a content array', () => {
    const body = toChatBody({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: 'see',
          contentParts: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0]?.content, [
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('omits tools/stream/optional numeric fields when absent', () => {
    const body = toChatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal('tools' in body, false);
    assert.equal('temperature' in body, false);
    assert.equal('max_tokens' in body, false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— `../protocol/chat.js` 不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/protocol/chat.ts`：

```ts
import type { ZenChatMessage, ZenRequest } from './types.js';

function encodeContent(message: ZenChatMessage): unknown {
  const hasImage = message.contentParts?.some((part) => part.type === 'image_url') ?? false;
  if (!hasImage || !message.contentParts) return message.content;
  return message.contentParts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text ?? '' }
      : { type: 'image_url', image_url: { url: part.image_url?.url ?? '' } },
  );
}

function encodeMessage(message: ZenChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: encodeContent(message) };
  if (message.name) out['name'] = message.name;
  if (message.tool_call_id) out['tool_call_id'] = message.tool_call_id;
  if (message.tool_calls && message.tool_calls.length > 0) out['tool_calls'] = message.tool_calls;
  return out;
}

export function toChatBody(request: ZenRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(encodeMessage),
  };
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.top_p !== undefined) body['top_p'] = request.top_p;
  if (request.max_tokens !== undefined) body['max_tokens'] = request.max_tokens;
  if (request.stop !== undefined) body['stop'] = request.stop;
  if (request.stream !== undefined) body['stream'] = request.stream;
  if (request.tools && request.tools.length > 0) body['tools'] = request.tools;
  return body;
}
```

> 若 `internal/protocol/request.go` 的 chat 编码还包含本任务未覆盖的字段（例如 `reasoning_effort` 透传、`stream_options`），请在实现中对照 Go 源补齐，并在报告中列出所对照的 Go 行号。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/chat.ts packages/zen/src/__tests__/protocol-request.test.ts
git commit -m "feat(zen): 结构化请求编码为 Chat Completions body"
```

---

### Task C3: 结构化 → Anthropic Messages body

**Files:**

- Create: `packages/zen/src/protocol/anthropic.ts`
- Test: `packages/zen/src/__tests__/protocol-request.test.ts`（追加）

参考：`internal/protocol/request.go` 的 anthropic 编码路径、`internal/protocol/content.go` 的 content block 转换。

- [ ] **Step 1: 写失败测试**

追加：

```ts
import { toAnthropicBody } from '../protocol/anthropic.js';

describe('zen anthropic body encoding', () => {
  it('splits system out and maps tool calls/results to blocks', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'checking',
          tool_calls: [
            { id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } },
          ],
        },
        { role: 'tool', content: 'sunny', tool_call_id: 'toolu_1' },
      ],
      max_tokens: 64,
      tools: [
        {
          type: 'function',
          function: { name: 'f', description: 'd', parameters: { type: 'object' } },
        },
      ],
    });
    assert.equal(body.model, 'm');
    assert.equal(body.max_tokens, 64);
    assert.deepEqual(body.system, [{ type: 'text', text: 'sys' }]);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(messages[0]?.role, 'user');
    const blocks = messages[1]?.content as Array<Record<string, unknown>>;
    assert.deepEqual(blocks?.[0], { type: 'text', text: 'checking' });
    assert.deepEqual(blocks?.[1], { type: 'tool_use', id: 'toolu_1', name: 'f', input: { q: 1 } });
    const resultBlocks = messages[2]?.content as Array<Record<string, unknown>>;
    assert.deepEqual(resultBlocks?.[0], {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'sunny',
    });
    assert.deepEqual(body.tools, [
      { name: 'f', description: 'd', input_schema: { type: 'object' } },
    ]);
  });

  it('maps images to base64/url source blocks', () => {
    const body = toAnthropicBody({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: 'see',
          contentParts: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
      max_tokens: 16,
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]?.content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/protocol/anthropic.ts`。要求：

- system 消息（`role:'system'`）抽到顶层 `system`（数组形式的 text block）；
- 文本 + 图片内容块：图片 URL 为 `data:<mime>;base64,<data>` → `{ type:'image', source:{ type:'base64', media_type, data } }`；普通 http(s) URL → `{ type:'image', source:{ type:'url', url } }`；
- assistant 的 `tool_calls` → `tool_use` 块（`input` = `JSON.parse(arguments)`，非对象回退 `{}`）；
- `role:'tool'` → 一个 `user` 消息，内含 `{ type:'tool_result', tool_use_id, content }`；
- `tools` → `{ name, description?, input_schema: parameters }`；
- `max_tokens` 为 Anthropic 必填；若请求未提供，使用一个默认上限常量（定义一个导出的 `DEFAULT_ANTHROPIC_MAX_TOKENS`，例如 `4096`，并在报告说明）。

> 逐字段映射与边界（多块、并行 tool_use、空文本块处理）请对照 `internal/protocol/request.go` 与 `content.go`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/anthropic.ts packages/zen/src/__tests__/protocol-request.test.ts
git commit -m "feat(zen): 结构化请求编码为 Anthropic Messages body"
```

---

### Task C4: 结构化 → OpenAI Responses body

**Files:**

- Create: `packages/zen/src/protocol/responses.ts`
- Test: `packages/zen/src/__tests__/protocol-request.test.ts`（追加）

参考：`internal/protocol/request.go` 的 responses 编码路径。

- [ ] **Step 1: 写失败测试**

追加：

```ts
import { toResponsesBody } from '../protocol/responses.js';

describe('zen responses body encoding', () => {
  it('encodes input items and tools', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"q":1}' } },
          ],
        },
        { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      stream: true,
    });
    assert.equal(body.model, 'm');
    assert.equal(body.stream, true);
    assert.equal(body.instructions, 'sys');
    const input = body.input as Array<Record<string, unknown>>;
    assert.equal(input[0]?.role, 'user');
    assert.deepEqual(body.tools, [{ type: 'function', name: 'f', parameters: { type: 'object' } }]);
  });
});
```

> Responses 协议的 `input` 项形状（message vs function_call vs function_call_output）、`instructions` 与 tool 定义的具体字段，请**以 `internal/protocol/request.go` 的 responses 路径为准**；上面的断言只是本任务的验收锚点，实现者需按 Go 源确定精确形状并在报告中列出对照行号。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**（按 Go 源对照）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/responses.ts packages/zen/src/__tests__/protocol-request.test.ts
git commit -m "feat(zen): 结构化请求编码为 Responses body"
```

---

### Task C5: `prepareRequest` 分派与同协议 `raw` 短路 + barrel

**Files:**

- Create: `packages/zen/src/protocol/request.ts`
- Modify: `packages/zen/src/index.ts`
- Test: `packages/zen/src/__tests__/protocol-request.test.ts`（追加）

参考：`internal/protocol/request.go` 的 `PrepareRequest`。

- [ ] **Step 1: 写失败测试**

追加：

```ts
import { prepareRequest } from '../protocol/request.js';

describe('zen prepareRequest', () => {
  it('short-circuits to the raw body when the client protocol is chat', () => {
    const raw = {
      model: 'orig-model',
      messages: [{ role: 'user', content: 'hi' }],
      seed: 7,
      stream: true,
    };
    const body = prepareRequest(
      {
        model: 'new-model',
        messages: [{ role: 'user', content: 'hi' }],
        raw,
        rawProtocol: 'openai',
      },
      'chat',
    );
    assert.equal(body.model, 'new-model');
    assert.equal(body['seed'], 7);
    assert.equal(body.stream, true);
  });

  it('encodes structurally for a cross-protocol target', () => {
    const body = prepareRequest(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        raw: { messages: [{ role: 'user', content: 'hi' }] },
        rawProtocol: 'openai',
      },
      'anthropic',
    );
    assert.equal(body.max_tokens, 4096);
    assert.ok(Array.isArray(body.messages));
  });

  it('does not reuse raw when the protocols differ', () => {
    const body = prepareRequest(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        raw: { model: 'orig', messages: [], seed: 7 },
        rawProtocol: 'gemini',
      },
      'chat',
    );
    assert.equal('seed' in body, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/protocol/request.ts`：

```ts
import { toAnthropicBody } from './anthropic.js';
import { toChatBody } from './chat.js';
import { toResponsesBody } from './responses.js';
import type { ZenClientProtocol, ZenProtocol, ZenRequest } from './types.js';

const CLIENT_TO_PROTOCOL: Record<ZenClientProtocol, ZenProtocol> = {
  openai: 'chat',
  anthropic: 'anthropic',
  gemini: 'chat',
};

function cloneRaw(raw: unknown, model: string): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return { ...(raw as Record<string, unknown>), model };
}

export function prepareRequest(request: ZenRequest, target: ZenProtocol): Record<string, unknown> {
  if (request.rawProtocol && CLIENT_TO_PROTOCOL[request.rawProtocol] === target) {
    const cloned = cloneRaw(request.raw, request.model);
    if (cloned) return cloned;
  }
  switch (target) {
    case 'anthropic':
      return toAnthropicBody(request);
    case 'responses':
      return toResponsesBody(request);
    default:
      return toChatBody(request);
  }
}
```

`packages/zen/src/index.ts` 追加：

```ts
export * from './protocol/types.js';
export * from './protocol/chat.js';
export * from './protocol/anthropic.js';
export * from './protocol/responses.js';
export * from './protocol/request.js';
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test && pnpm --filter @freemodelfinder/zen typecheck && pnpm --filter @freemodelfinder/zen build`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/request.ts packages/zen/src/index.ts packages/zen/src/__tests__/protocol-request.test.ts
git commit -m "feat(zen): prepareRequest 分派与同协议 raw 短路"
```

---

## 验收清单（P1-C1）

- [ ] `pnpm --filter @freemodelfinder/core test` 全绿（含 C0）
- [ ] `pnpm --filter @freemodelfinder/zen test` 全绿
- [ ] `pnpm build:runtime`、`pnpm typecheck`、`pnpm lint` 通过
- [ ] 仅本计划列出的文件被提交

## 后续子阶段

- **P1-C2**：响应转换（upstream body → `ChatResponse`，并填充 `raw`/`rawProtocol`）+ SSE 解析/重发 + 非流式折叠。
- **P1-C3**：agent 形变（`prepareAnonymousBody`/`shapeKeyBody`）、`ForcedEffort`、stale-reasoning 重试。

## 自查记录

1. **Spec 覆盖**：spec「中间表示策略」的请求侧（同协议 `raw` 零损 + 跨协议结构化）由 C1–C5 落地；响应侧 `raw` 载体由 C0 落地（决策已写入 spec）；响应转换/SSE 明确归属 P1-C2，agent 形变等归属 P1-C3。
2. **占位符扫描**：C3/C4 的详细字段映射**以磁盘上的 Go 源为权威**（已在「执行约定」与各任务中显式说明），非占位符；C0/C1/C2/C5 给出完整代码。
3. **类型一致性**：`ZenChatRequest`/`ZenChatMessage`（C1）与 core `ChatRequest`/`ChatMessage` 结构等价；`ZenProtocol` 与 config 的 `ZenNativeProtocol` 取值一致；`prepareRequest` 的 `rawProtocol` 与 C0 的 `ChatRequest.rawProtocol` 语义一致。
