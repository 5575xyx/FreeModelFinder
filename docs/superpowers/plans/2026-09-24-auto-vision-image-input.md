# Auto Vision 意图与多模态图片输入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `model=auto` 识别「上传图片→理解」并路由到 vision 模型，图片经 `contentParts` 透传上游；文生图/文生视频行为不变。

**Architecture:** 扩展 `detectRequestModality` 增加 `'vision'`；`ChatMessage.contentParts` 保留 OpenAI/Anthropic/Gemini 入站图片 part；`ModelInfo.inputModalities` + id 启发式 + `autoRoute.visionModel` 池筛选；OpenAI 兼容与 Gemini 出站编码图片；无 vision 模型返回 400 `no_vision_model`。

**Tech Stack:** TypeScript、Fastify (server)、zod、Node test runner (`node --test` + tsx)

**Spec:** `docs/superpowers/specs/2026-09-24-auto-vision-image-input-design.md`

**Notes:**

- 不推送 GitHub；仅本地 commit（用户要求勿擅自 push）。
- 每 Task 结束：`npx prettier --write <files>` → `npx eslint <files> --max-warnings=0` → 对应包测试。
- 全量验证（最后 Task）：`pnpm --filter @freemodelfinder/core test`、`pnpm --filter @freemodelfinder/server test`、`pnpm typecheck`、`pnpm build:runtime`。
- Windows PowerShell：链式命令用 `if ($?) { ... }`，不要用 `&&`。
- UI 本期不改（`visionModel` 仅 API/配置层）；用户重启网关后手动验收。

---

## File Structure

| 文件                                                                   | 职责                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`                                           | `ModelInfo.inputModalities`、`AutoRouteSettings.visionModel`、`ChatMessage.contentParts` |
| `packages/core/src/vision.ts`                                          | 启发式 `looksVisionModelId`、`withVisionInput`、`isVisionCapable`                        |
| `packages/core/src/protocols/openai.ts`                                | 入站保留 `contentParts`                                                                  |
| `packages/core/src/protocols/anthropic.ts`                             | 入站 image block → `contentParts`                                                        |
| `packages/core/src/protocols/gemini.ts`                                | 入站 inlineData/fileData → `contentParts`                                                |
| `packages/core/src/providers/openai-compatible.ts`                     | 出站 messages 含 image_url                                                               |
| `packages/core/src/providers/custom.ts`                                | 同上（与 openai-compatible 共用 helper）                                                 |
| `packages/core/src/providers/openrouter.ts`                            | `input_modalities` → `inputModalities`                                                   |
| `packages/core/src/providers/gemini.ts`                                | 出站 inlineData / fileData                                                               |
| `packages/core/src/providers/agnes.ts` / `agnes-intl.ts` 等纯文本 chat | 有 `contentParts` 图片时抛错（可选 Task，最低限度在 registry/路由层拦）                  |
| `packages/core/src/index.ts`                                           | 导出 vision helpers                                                                      |
| `packages/server/src/routes/openai.ts`                                 | `detectRequestModality` vision、auto 分支、400 错误                                      |
| `packages/server/src/server.ts`                                        | GET/PATCH `/api/auto-route` 的 `visionModel`                                             |
| `packages/core/src/__tests__/vision.test.ts`                           | 启发式/能力判定                                                                          |
| `packages/core/src/__tests__/protocols-vision.test.ts`                 | 三协议入站 + OpenAI 出站编码                                                             |
| `packages/server/src/routes/__tests__/auto-modality.test.ts`           | 扩展 vision 路由用例                                                                     |
| `packages/server/src/__tests__/auto-route-api.test.ts`                 | 扩展 visionModel 池 API                                                                  |

---

## Task 1: 类型扩展（ModelInfo / AutoRoute / ChatMessage）

**Files:**

- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: 写失败测试** `packages/core/src/__tests__/vision.test.ts`（新建）

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { looksVisionModelId, isVisionCapable, withVisionInput } from '../vision.js';
import type { ModelInfo } from '../types.js';

describe('vision helpers', () => {
  it('looksVisionModelId matches common vision ids', () => {
    assert.equal(looksVisionModelId('qwen2.5-vl-7b-instruct'), true);
    assert.equal(looksVisionModelId('google/gemini-2.0-flash-exp:free'), false);
    assert.equal(looksVisionModelId('meta/llama-3.2-11b-vision-instruct:free'), true);
    assert.equal(looksVisionModelId('gpt-4o-mini'), false);
    assert.equal(looksVisionModelId('glm-4v-flash'), true);
  });

  it('withVisionInput appends image when missing', () => {
    const m = { id: 'x', provider: 'openrouter', displayName: 'X', free: true } as ModelInfo;
    const out = withVisionInput(m);
    assert.deepEqual(out.inputModalities, ['text', 'image']);
    const already = withVisionInput({ ...m, inputModalities: ['image'] });
    assert.deepEqual(already.inputModalities, ['image']);
  });

  it('isVisionCapable uses metadata, heuristic, or forced pool ids', () => {
    const meta = {
      id: 'a',
      provider: 'openrouter',
      displayName: 'a',
      free: true,
      inputModalities: ['image'],
    } as ModelInfo;
    assert.equal(isVisionCapable(meta, []), true);
    const heuristic = {
      id: 'llava-1.5',
      provider: 'custom',
      displayName: 'b',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(heuristic, []), true);
    const forced = {
      id: 'custom:special-vision',
      provider: 'custom',
      displayName: 'c',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(forced, ['custom:special-vision']), true);
    const textOnly = {
      id: 'gpt-4o-mini',
      provider: 'openrouter',
      displayName: 'd',
      free: true,
    } as ModelInfo;
    assert.equal(isVisionCapable(textOnly, []), false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/vision.test.ts
```

Expected: FAIL（`vision.js` 不存在）

- [ ] **Step 3: 在 `types.ts` 扩展类型**

在 `ModelInfo`（~80-88）`capabilities` 后增加：

```ts
  /** Chat *input* modalities. Missing = text-only. Not the same as capabilities (output). */
  inputModalities?: ('text' | 'image')[];
```

在 `AutoRouteSettings`（~138-150）`videoModel` 后增加：

```ts
  visionModel?: string[];
```

在 `ChatMessageSchema`（~39-45）增加可选 `contentParts`：

```ts
export const ChatContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string() }),
  }),
]);

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.string(),
  contentParts: z.array(ChatContentPartSchema).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
});
```

- [ ] **Step 4: 创建 `packages/core/src/vision.ts`**

```ts
import type { ModelInfo } from './types.js';

const VISION_ID_RE =
  /vision|4v|vl|qwen2?\.?vl|glm-4v|llava|moondream|pixtral|mistral-small-vision|internvl|falcon-vision/i;

export function looksVisionModelId(modelId: string): boolean {
  return VISION_ID_RE.test(modelId);
}

export function withVisionInput(m: ModelInfo): ModelInfo {
  const cur = m.inputModalities ?? [];
  if (cur.includes('image')) return m;
  const base = cur.length ? cur : ['text'];
  return { ...m, inputModalities: [...base, 'image'] };
}

export function isVisionCapable(m: ModelInfo, forcedVisionIds: readonly string[]): boolean {
  if (forcedVisionIds.includes(m.id)) return true;
  if (m.inputModalities?.includes('image')) return true;
  if (m.inputModalities && !m.inputModalities.includes('image')) return false;
  return looksVisionModelId(m.id);
}
```

在 `packages/core/src/index.ts` 增加：

```ts
export { looksVisionModelId, withVisionInput, isVisionCapable } from './vision.js';
```

- [ ] **Step 5: 跑测试确认通过**

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/vision.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```powershell
npx prettier --write packages/core/src/types.ts packages/core/src/vision.ts packages/core/src/__tests__/vision.test.ts packages/core/src/index.ts
npx eslint "packages/core/src/types.ts" "packages/core/src/vision.ts" "packages/core/src/__tests__/vision.test.ts" "packages/core/src/index.ts" --max-warnings=0
git add packages/core/src/types.ts packages/core/src/vision.ts packages/core/src/__tests__/vision.test.ts packages/core/src/index.ts
git commit -m "feat(core): add inputModalities, visionModel config, contentParts types"
```

---

## Task 2: OpenAI 入站保留 contentParts

**Files:**

- Modify: `packages/core/src/protocols/openai.ts`
- Test: `packages/core/src/__tests__/protocols-vision.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openAIToChatRequest, type OpenAIChatCompletionRequest } from '../protocols/openai.js';

describe('openAIToChatRequest contentParts', () => {
  it('keeps image_url parts and joins text into content', () => {
    const req = {
      model: 'auto',
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text', text: '这是什么?' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    } satisfies OpenAIChatCompletionRequest;
    const out = openAIToChatRequest(req);
    assert.equal(out.messages[0]!.content, '这是什么?');
    assert.deepEqual(out.messages[0]!.contentParts, [
      { type: 'text', text: '这是什么?' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]);
  });

  it('omits contentParts for pure string messages (regression)', () => {
    const out = openAIToChatRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(out.messages[0]!.contentParts, undefined);
  });
});
```

- [ ] **Step 2: 确认失败**

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/protocols-vision.test.ts
```

Expected: FAIL（无 contentParts）

- [ ] **Step 3: 实现 `openAIToChatRequest`**

扩展 content part 类型并改写 map：

```ts
export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

// OpenAIChatCompletionRequest.messages content 改为:
// string | OpenAIContentPart[]

function extractContentParts(
  content: OpenAIChatCompletionRequest['messages'][number]['content'],
): Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  let sawImage = false;
  for (const p of content) {
    if (p.type === 'image_url' && p.image_url?.url) {
      parts.push({ type: 'image_url', image_url: { url: p.image_url.url } });
      sawImage = true;
    } else if ((p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string') {
      parts.push({ type: 'text', text: p.text });
    }
  }
  return sawImage ? parts : undefined;
}

export function openAIToChatRequest(req: OpenAIChatCompletionRequest): ChatRequest {
  const messages: ChatMessage[] = req.messages.map((m) => {
    const contentParts = extractContentParts(m.content);
    return {
      role: m.role,
      content: normalizeContent(m.content),
      contentParts,
      name: m.name,
      tool_call_id: m.tool_call_id,
    };
  });
  return { /* 不变 */ ... };
}
```

说明：仅当存在 image part 时才挂 `contentParts`；纯文本/仅 text 数组行为与旧测试一致（`contentParts: undefined`）。`JSON` 序列化时 `undefined` 字段会消失，旧调用方无感。

- [ ] **Step 4: 确认通过**

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/protocols-vision.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```powershell
npx prettier --write packages/core/src/protocols/openai.ts packages/core/src/__tests__/protocols-vision.test.ts
npx eslint "packages/core/src/protocols/openai.ts" "packages/core/src/__tests__/protocols-vision.test.ts" --max-warnings=0
git add packages/core/src/protocols/openai.ts packages/core/src/__tests__/protocols-vision.test.ts
git commit -m "feat(core): preserve image contentParts in openAIToChatRequest"
```

---

## Task 3: Anthropic / Gemini 入站保留图片 part

**Files:**

- Modify: `packages/core/src/protocols/anthropic.ts`
- Modify: `packages/core/src/protocols/gemini.ts`
- Test: `packages/core/src/__tests__/protocols-vision.test.ts`

- [ ] **Step 1: 追加失败测试到 `protocols-vision.test.ts`**

```ts
import { anthropicToChatRequest, type AnthropicMessagesRequest } from '../protocols/anthropic.js';
import { geminiToChatRequest, type GeminiHttpRequest } from '../protocols/gemini.js';

describe('anthropic/gemini inbound image parts', () => {
  it('maps anthropic image block to contentParts', () => {
    const out = anthropicToChatRequest({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image',
              source: { type: 'url', media_type: 'image/png', url: 'https://example.com/a.png' },
            },
          ],
        },
      ],
      max_tokens: 16,
    } as unknown as AnthropicMessagesRequest);
    const parts = out.messages[0]!.contentParts!;
    assert.ok(parts.some((p) => p.type === 'image_url'));
    assert.equal(out.messages[0]!.content, 'what is this');
  });

  it('maps gemini inlineData to contentParts data URL', () => {
    const out = geminiToChatRequest('gemini', {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'desc' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
        },
      ],
    } as unknown as GeminiHttpRequest);
    const parts = out.messages[0]!.contentParts!;
    const img = parts.find((p) => p.type === 'image_url');
    assert.ok(img && img.type === 'image_url');
    assert.equal(img.image_url.url, 'data:image/png;base64,AAAA');
  });
});
```

- [ ] **Step 2: 确认失败**

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/protocols-vision.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 Anthropic 入站**

在 `anthropicToChatRequest` 的 content 类型上识别 `type === 'image'`：

```ts
interface AnthropicBlock {
  type: string;
  text?: string;
  source?: { type?: string; media_type?: string; url?: string; data?: string };
}

function anthropicContentToParts(
  content: string | AnthropicBlock[],
):
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  | undefined {
  if (typeof content === 'string') return undefined;
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  let sawImage = false;
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && b.source) {
      if (b.source.type === 'url' && b.source.url) {
        parts.push({ type: 'image_url', image_url: { url: b.source.url } });
        sawImage = true;
      } else if (b.source.type === 'base64' && b.source.data && b.source.media_type) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        });
        sawImage = true;
      }
    }
  }
  return sawImage ? parts : undefined;
}
```

在 `messages.push` 处挂上 `contentParts: anthropicContentToParts(m.content)`。

- [ ] **Step 4: 实现 Gemini 入站**

扩展 `GeminiContentPart` 并在 `geminiToChatRequest`：

```ts
interface GeminiContentPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
}
```

map parts 时：

```ts
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
messages.push({
  role: c.role === 'model' ? 'assistant' : 'user',
  content: text,
  contentParts: sawImage ? parts : undefined,
});
```

- [ ] **Step 5: 确认通过 + Commit**

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/protocols-vision.test.ts
npx prettier --write packages/core/src/protocols/anthropic.ts packages/core/src/protocols/gemini.ts packages/core/src/__tests__/protocols-vision.test.ts
npx eslint "packages/core/src/protocols/anthropic.ts" "packages/core/src/protocols/gemini.ts" "packages/core/src/__tests__/protocols-vision.test.ts" --max-warnings=0
git add packages/core/src/protocols/anthropic.ts packages/core/src/protocols/gemini.ts packages/core/src/__tests__/protocols-vision.test.ts
git commit -m "feat(core): preserve anthropic/gemini inbound image parts"
```

---

## Task 4: OpenRouter input_modalities + OpenAI 出站编码

**Files:**

- Modify: `packages/core/src/providers/openrouter.ts`
- Modify: `packages/core/src/providers/openai-compatible.ts`
- Modify: `packages/core/src/providers/custom.ts`
- Test: `packages/core/src/__tests__/protocols-vision.test.ts`（出站编码部分）

- [ ] **Step 1: 追加出站失败测试**

```ts
import type { ChatRequest } from '../types.js';

// 在 protocols-vision.test.ts 或单独 describe：
// 通过导出的 toOpenAIMessagesBody 测试（见 Step 3 实现导出）

describe('openai outbound encoding', () => {
  it('serializes contentParts as OpenAI content array', async () => {
    const { toOpenAIMessages } = await import('../providers/openai-messages.js');
    const msgs = toOpenAIMessages([
      {
        role: 'user',
        content: 'see this',
        contentParts: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      },
    ]);
    assert.deepEqual(msgs[0], {
      role: 'user',
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
    });
  });

  it('keeps string content when no image parts', async () => {
    const { toOpenAIMessages } = await import('../providers/openai-messages.js');
    const msgs = toOpenAIMessages([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(msgs[0], { role: 'user', content: 'hi' });
  });
});
```

- [ ] **Step 2: 确认失败**（module 不存在）

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/protocols-vision.test.ts
```

- [ ] **Step 3: 创建 `packages/core/src/providers/openai-messages.ts`**

```ts
import type { ChatMessage } from '../types.js';

export function toOpenAIMessages(
  messages: ChatMessage[],
): Array<{ role: string; content: string | unknown[] }> {
  return messages.map((m) => {
    const hasImage = m.contentParts?.some((p) => p.type === 'image_url') ?? false;
    if (hasImage && m.contentParts) {
      return {
        role: m.role,
        content: m.contentParts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: p.image_url.url } },
        ),
      };
    }
    return { role: m.role, content: m.content };
  });
}
```

- [ ] **Step 4: 在 `openai-compatible.ts` chat/stream 使用**

`chat` 中 body 改为：

```ts
body: JSON.stringify({
  ...req,
  messages: toOpenAIMessages(req.messages),
  stream: false,
}),
```

`stream` 同理（`stream: true`）。`custom.ts` 的 chat/stream 同样替换。

- [ ] **Step 5: OpenRouter 映射 `input_modalities`**

`OpenRouterModel.architecture` 已有 `input_modalities`。在 `.map` 返回值增加：

```ts
inputModalities: (() => {
  const inputs = m.architecture?.input_modalities ?? [];
  const mapped = inputs.filter((x): x is 'text' | 'image' => x === 'text' || x === 'image');
  return mapped.length ? mapped : undefined;
})(),
```

- [ ] **Step 6: 跑测试 + Commit**

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/protocols-vision.test.ts
npx prettier --write packages/core/src/providers/openai-messages.ts packages/core/src/providers/openai-compatible.ts packages/core/src/providers/custom.ts packages/core/src/providers/openrouter.ts packages/core/src/__tests__/protocols-vision.test.ts
npx eslint "packages/core/src/providers/openai-messages.ts" "packages/core/src/providers/openai-compatible.ts" "packages/core/src/providers/custom.ts" "packages/core/src/providers/openrouter.ts" "packages/core/src/__tests__/protocols-vision.test.ts" --max-warnings=0
git add packages/core/src/providers packages/core/src/__tests__/protocols-vision.test.ts
git commit -m "feat(core): outbound image contentParts for OpenAI-compatible providers"
```

---

## Task 5: Gemini 出站图片编码 + data URL 10MB 限制

**Files:**

- Modify: `packages/core/src/providers/gemini.ts`
- Test: 追加到 `protocols-vision.test.ts` 或 `vision.test.ts`

- [ ] **Step 1: 共享 data-URL 大小校验（放 `vision.ts`）**

```ts
export const MAX_IMAGE_DATA_BYTES = 10 * 1024 * 1024;

export function assertImageDataUrlWithinLimit(url: string): void {
  if (!url.startsWith('data:')) return;
  const comma = url.indexOf(',');
  if (comma < 0) return;
  const meta = url.slice(5, comma);
  const isBase64 = meta.endsWith(';base64');
  const payload = url.slice(comma + 1);
  const approxBytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
  if (approxBytes > MAX_IMAGE_DATA_BYTES) {
    throw new Error('image data URL exceeds 10MB limit');
  }
}
```

测试：

```ts
it('rejects oversized data URLs', async () => {
  const { assertImageDataUrlWithinLimit } = await import('../vision.js');
  const big = 'data:image/png;base64,' + 'A'.repeat(14 * 1024 * 1024);
  assert.throws(() => assertImageDataUrlWithinLimit(big), /10MB/);
  assertImageDataUrlWithinLimit('data:image/png;base64,AAAA');
  assertImageDataUrlWithinLimit('https://example.com/a.png');
});
```

- [ ] **Step 2: 实现 Gemini 出站**

扩展 `GeminiContentPart` 支持 inlineData/fileData；`toGeminiContents` 中对 `m.contentParts`：

```ts
function pushImageParts(parts: GeminiContentPart[], urls: string[]) {
  for (const url of urls) {
    assertImageDataUrlWithinLimit(url);
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const meta = url.slice(5, comma);
      const mime = meta.replace(/;base64$/, '') || 'image/png';
      const data = url.slice(comma + 1);
      parts.push({ inlineData: { mimeType: mime, data } });
    } else {
      parts.push({ fileData: { fileUri: url } });
    }
  }
}
```

user/assistant 消息：若有 `contentParts`，先 push text 再 push 图片 part。

- [ ] **Step 3: 测试 + Commit**

```powershell
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/protocols-vision.test.ts src/__tests__/vision.test.ts
npx prettier --write packages/core/src/providers/gemini.ts packages/core/src/vision.ts packages/core/src/__tests__/vision.test.ts
npx eslint "packages/core/src/providers/gemini.ts" "packages/core/src/vision.ts" "packages/core/src/__tests__/vision.test.ts" --max-warnings=0
git add packages/core/src/providers/gemini.ts packages/core/src/vision.ts packages/core/src/__tests__/
git commit -m "feat(core): gemini outbound image parts and 10MB data URL cap"
```

---

## Task 6: `detectRequestModality` 返回 `vision`

**Files:**

- Modify: `packages/server/src/routes/openai.ts`（~153-188）
- Test: `packages/server/src/routes/__tests__/auto-modality.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `detectRequestModality` describe）

```ts
it('detects vision when latest user uploads an image part', () => {
  assert.equal(
    detectRequestModality([
      {
        role: 'user' as const,
        content: [{ type: 'image_url', image_url: { url: 'http://x/y.png' } } as never],
      },
    ]),
    'vision',
  );
});

it('image part wins over generation keywords in the same message', () => {
  assert.equal(
    detectRequestModality([
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: '生成一张图片' },
          { type: 'image_url', image_url: { url: 'http://x/y.png' } } as never,
        ],
      },
    ]),
    'vision',
  );
});

it('does not trigger vision from image only in history', () => {
  assert.equal(
    detectRequestModality([
      {
        role: 'user' as const,
        content: [{ type: 'image_url', image_url: { url: 'http://old.png' } } as never],
      },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: '介绍一下 OpenRouter' },
    ]),
    'text',
  );
});
```

注意：现有用例 `keeps uploaded image parts as image` **改为期望 `'vision'`**（行为变更，更新断言）。

- [ ] **Step 2: 确认失败**

```powershell
pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/routes/__tests__/auto-modality.test.ts
```

Expected: FAIL（仍返回 `'image'`）

- [ ] **Step 3: 实现**

```ts
type RequestModality = 'text' | 'image' | 'video' | 'vision';

// 在 array 分支 image 检测处：
if (part.type === 'image_url' || part.type === 'image') return 'vision';
```

其余关键词逻辑不变。

- [ ] **Step 4: 确认通过**

```powershell
pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/routes/__tests__/auto-modality.test.ts
```

Expected: PASS（含更新后的旧用例）

- [ ] **Step 5: Commit**

```powershell
npx prettier --write packages/server/src/routes/openai.ts packages/server/src/routes/__tests__/auto-modality.test.ts
npx eslint "packages/server/src/routes/openai.ts" "packages/server/src/routes/__tests__/auto-modality.test.ts" --max-warnings=0
git add packages/server/src/routes/openai.ts packages/server/src/routes/__tests__/auto-modality.test.ts
git commit -m "feat(server): detect uploaded images as vision intent"
```

---

## Task 7: auto 路由 vision 池 + 400 no_vision_model

**Files:**

- Modify: `packages/server/src/routes/openai.ts`（auto 分支 ~347-378）
- Test: `packages/server/src/routes/__tests__/auto-modality.test.ts`

- [ ] **Step 1: 写失败 HTTP 测试**

复用 `modalityRegistry` 夹具风格，新增 describe 或用例：

```ts
it('routes auto vision request to visionModel pool without generateImage', async () => {
  // autoRoute: { enabled: true, strategy: 'capability', visionModel: ['custom:vision-a'] }
  // models 含 vision-a；provider.generateImage 计数保持 0
  // POST /v1/chat/completions model=auto，messages 最新 user 含 image_url
  // 断言：status 200；imageCallCount() === 0；chat 收到的 messages 含 image part
});

it('returns 400 no_vision_model when no vision model available', async () => {
  // 无 visionModel 池；models 无 inputModalities image、id 不启发式命中
  // 断言：status 400；body.error.type === 'no_vision_model'；generate* 均为 0
});

it('discovers vision model from catalog when visionModel pool unset', async () => {
  // models: [{ id: 'openrouter:llava-x', inputModalities: ['text','image'], ... }]
  // 断言：200 且落到该模型；imageCallCount 0
});
```

实现细节：mock provider 的 `chat` 记录最后一次 `req.messages`，断言 `contentParts` 含 `image_url`。

- [ ] **Step 2: 确认失败**

```powershell
pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/routes/__tests__/auto-modality.test.ts
```

- [ ] **Step 3: 实现 auto vision 分支**

在 `if (detectedModality === 'image')` **之前**插入：

```ts
} else if (detectedModality === 'vision') {
  const forced = asModelList(ar?.visionModel);
  const picked = nextFromPool('vision', forced);
  if (picked) {
    chatReq.model = picked;
  } else {
    const { models } = await reg.listAllModels();
    const visionModels = models.filter((m) => isVisionCapable(m, forced));
    if (!visionModels.length) {
      return reply.code(400).send({
        error: {
          message:
            'No vision-capable model available. Configure autoRoute.visionModel or enable a model with image input.',
          type: 'no_vision_model',
        },
      });
    }
    const pool = visionModels.map((m) => m.id);
    const catalogPick = nextFromPool('vision', pool);
    if (!catalogPick) {
      return reply.code(400).send({
        error: {
          message:
            'No vision-capable model available. Configure autoRoute.visionModel or enable a model with image input.',
          type: 'no_vision_model',
        },
      });
    }
    chatReq.model = catalogPick;
  }
  // 不设 forcedImageModality；不进 generateImage fast-path
} else if (detectedModality === 'image') {
```

文件顶部 import：

```ts
import { isVisionCapable } from '@freemodelfinder/core';
```

确保 `forcedImageModality` 仅在 `detectedModality === 'image'` 分支为 true（现有代码已如此）。

- [ ] **Step 4: 确认通过 + Commit**

```powershell
pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/routes/__tests__/auto-modality.test.ts
npx prettier --write packages/server/src/routes/openai.ts packages/server/src/routes/__tests__/auto-modality.test.ts
npx eslint "packages/server/src/routes/openai.ts" "packages/server/src/routes/__tests__/auto-modality.test.ts" --max-warnings=0
git add packages/server/src/routes/openai.ts packages/server/src/routes/__tests__/auto-modality.test.ts
git commit -m "feat(server): route auto vision requests with no_vision_model error"
```

---

## Task 8: `/api/auto-route` 暴露 visionModel

**Files:**

- Modify: `packages/server/src/server.ts`（GET ~982-1001，POST ~1064-1090）
- Test: `packages/server/src/__tests__/auto-route-api.test.ts`

- [ ] **Step 1: 失败测试**（追加）

```ts
it('GET returns visionModel array', async () => {
  // seed autoRoute.visionModel: ['custom:v1']
  // GET /api/auto-route → body.visionModel deepEqual ['custom:v1']
});

it('POST merge keeps previous visionModel when omitted; assigns when provided', async () => {
  // POST { visionModel: ['custom:v2'] } → GET → ['custom:v2']
  // POST {} → GET 仍 ['custom:v2']
});
```

- [ ] **Step 2: 确认失败**

```powershell
pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/__tests__/auto-route-api.test.ts
```

- [ ] **Step 3: 实现**

GET 返回增加：

```ts
visionModel: asModelList(ar.visionModel),
```

POST body 类型增加 `visionModel?: string[] | string`；解构增加 `visionModel`；merge：

```ts
visionModel:
  visionModel !== undefined ? asModelList(visionModel) : asModelList(cur.visionModel),
```

- [ ] **Step 4: 通过 + Commit**

```powershell
pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/__tests__/auto-route-api.test.ts
npx prettier --write packages/server/src/server.ts packages/server/src/__tests__/auto-route-api.test.ts
npx eslint "packages/server/src/server.ts" "packages/server/src/__tests__/auto-route-api.test.ts" --max-warnings=0
git add packages/server/src/server.ts packages/server/src/__tests__/auto-route-api.test.ts
git commit -m "feat(server): expose visionModel on auto-route settings API"
```

---

## Task 9: 显式模型 + 图片时透传；无视觉 provider 明确报错

**Files:**

- Modify: `packages/server/src/routes/openai.ts`（chat 成功/错误路径，~566+）
- Test: `auto-modality.test.ts` 或新用例

- [ ] **Step 1: 失败测试**

```ts
it('explicit model with image part goes to chat with contentParts (not image gen)', async () => {
  // model: 'custom:some-text-model'（非 auto）
  // body.messages 含 image_url
  // 断言 generateImage 调用 0；chat 收到 contentParts
});

it('upstream image rejection surfaces vision_input_error', async () => {
  // provider.chat 抛 'does not support image input' 或 400
  // 断言 error.type === 'vision_input_error' 或透传 upstream 且 type 匹配设计
});
```

- [ ] **Step 2: 实现错误映射**

在 chat catch（非 stream 与 stream 各一处可选其一先做非 stream）：

```ts
if (msg.includes('does not support image input')) {
  return reply.code(400).send({
    error: { message: msg, type: 'vision_input_error' },
  });
}
```

出站纯文本 provider（agnes chat 等）在 `openai-compatible`/自身 chat 入口：

```ts
if (req.messages.some((m) => m.contentParts?.some((p) => p.type === 'image_url'))) {
  throw new Error(`Provider ${this.id} does not support image input`);
}
```

对 `OpenAICompatibleProvider.chat/stream`：**不**加此拦截（OpenAI 兼容应尝试透传）；仅对已知不支持的（`agnes.ts` chat、`agnes-intl.ts` chat）在 chat 开头加拦截。

- [ ] **Step 3: 测试 + Commit**

```powershell
pnpm --filter @freemodelfinder/core test
pnpm --filter @freemodelfinder/server test
npx prettier --write packages/server/src/routes/openai.ts packages/core/src/providers/agnes.ts packages/core/src/providers/agnes-intl.ts
npx eslint "packages/server/src/routes/openai.ts" "packages/core/src/providers/agnes.ts" "packages/core/src/providers/agnes-intl.ts" --max-warnings=0
git add packages/server/src/routes/openai.ts packages/core/src/providers/agnes.ts packages/core/src/providers/agnes-intl.ts packages/server/src/routes/__tests__/
git commit -m "fix: explicit vision input errors; block images on non-vision chat providers"
```

---

## Task 10: 全量验证 + 文生图/文生视频回归确认

**Files:** 无新文件；跑全链路

- [ ] **Step 1: 全量测试**

```powershell
pnpm --filter @freemodelfinder/core test
pnpm --filter @freemodelfinder/server test
```

Expected: core + server 全绿（含既有 auto-modality、queue-retry、registry 测试）。

- [ ] **Step 2: typecheck + build**

```powershell
pnpm typecheck
pnpm build:runtime
```

Expected: 均成功。

- [ ] **Step 3: 手动回归点核对（代码级断言已在测试覆盖）**

| 场景               | 期望                                                  |
| ------------------ | ----------------------------------------------------- |
| 无图 +「画一只猫」 | 仍 `image` → generateImage                            |
| 无图 +「生成视频」 | 仍 `video` → generateVideo                            |
| 有图 + auto        | vision 池/发现 → chat + contentParts，generateImage=0 |
| 无 vision 模型     | 400 `no_vision_model`                                 |

- [ ] **Step 4: 若有未提交改动，commit**

```powershell
git status --short
# 若有遗漏：
git add -u
git commit -m "test: vision routing regression green"
```

- [ ] **Step 5: 提醒用户（不推送）**

向用户报告：本地已提交；请**重启网关**后用 Dashboard/客户端上传图测「这是什么」，以及纯文本文生图/文生视频。用户说「推送」前不 push。

---

## Spec 覆盖对照

| Spec 要求                               | Task                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RequestModality` + vision              | Task 6                                                                                                                                                                                                    |
| 仅最新非空 user                         | Task 6（沿用现循环 + 测试）                                                                                                                                                                               |
| auto vision 池 + 目录发现 + 独立 cursor | Task 7                                                                                                                                                                                                    |
| 400 no_vision_model 信封                | Task 7                                                                                                                                                                                                    |
| `inputModalities` + 启发式 + 强制池 id  | Task 1                                                                                                                                                                                                    |
| `visionModel` 配置 + API                | Task 1 + Task 8                                                                                                                                                                                           |
| `ChatMessage.contentParts`              | Task 1 + Task 2                                                                                                                                                                                           |
| OpenAI 入/出站                          | Task 2 + Task 4                                                                                                                                                                                           |
| Anthropic/Gemini 入站                   | Task 3                                                                                                                                                                                                    |
| Gemini 出站 + 10MB                      | Task 5                                                                                                                                                                                                    |
| 无视觉 provider 报错                    | Task 9                                                                                                                                                                                                    |
| 不改文生图/视频行为                     | Task 6 仅改 image part 分支；Task 10 回归                                                                                                                                                                 |
| call-logger 截断 URL                    | **最小实现**：日志仍用 `content` 文本；完整 URL 不进 base64 日志——Task 10 前如需可加 `imageUrls` 截断字段，**YAGNI 默认不加**（spec 允许仅记 truncated metadata；若实现则 Task 4 顺带在 call 记录处可选） |

## 类型一致性检查

- `contentParts` / `ChatContentPartSchema` / `isVisionCapable` / `withVisionInput` / `looksVisionModelId` / `toOpenAIMessages` / `assertImageDataUrlWithinLimit` / `visionModel` / `no_vision_model` / `vision_input_error` / `nextFromPool('vision', …)` 全计划同名。
- `forcedImageModality` 不在 vision 分支赋值。

## 自检结论

- Spec 各节均有 Task；无 TBD/占位代码块。
- call-logger 细化标为 YAGNI 可选，避免过度设计。
