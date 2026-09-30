# auto 路由：结构化档位 + 会话粘性 fallback 链 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用结构化档位查表替换 id 正则打分，用「会话粘性 + 有序 fallback 链（同厂最多 2 席）」替换 round-robin，并加上发送前上下文预检。

**Architecture:** 两个新纯函数模块（`model-tier.ts` 解析档位/代际、`context-estimate.ts` 估算 token）+ `auto-router.ts` 扩展粘性表 + `registry.ts` 的 `pickFromScoredPool` 重写为 `buildFallbackChain` + `resolveModel` 增加可选 `opts`（预检输入、会话指纹、选型回调）+ `openai.ts` 接线。设计文档：`docs/superpowers/specs/2026-09-30-auto-route-sticky-fallback-design.md`。

**Tech Stack:** TypeScript、Node 内置 test runner（`node --test` + `tsx`）、tsup 构建、ESLint（`--max-warnings=0`）、Prettier。

---

## 全局约束（每个 Task 都适用）

1. **新代码一律不写注释**（仓库硬规则）。
2. core 改动后，server 测试前必须先 `pnpm --filter @freemodelfinder/core build`（server 加载 core `dist`）。
3. PowerShell 串联用 `; if ($?) { ... }`，**禁止 `&&`**。无 `rg`，用 grep 工具。
4. 跳过 `format:check`（CRLF 基线）、`test:pack`、`audit:prod`、`verify:release`；改动文件逐个 `npx prettier --write`。
5. **不 push**。每个 Task 结束只 `git commit`。用户明确说「推送」前不得 push。
6. 单测命令：
   - core：`pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/<file>.test.ts`
   - core registry：`pnpm --filter @freemodelfinder/core exec node --import tsx --test src/registry/__tests__/<file>.test.ts`
   - server：`pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/__tests__/<file>.test.ts`
7. **`resetAutoPoolCursor` 保留原名不改**（47 处调用点），实现改为清空粘性表。语义变为「重置 auto 路由状态」。

---

## File Structure

| 文件                                             | 职责                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `packages/core/src/model-tier.ts` **新建**       | `parseModelProfile(id)` → `{tier, generation}`；`TIER_SCORES` 分数表               |
| `packages/core/src/context-estimate.ts` **新建** | `estimateInputTokens(req)` 字符/3 估算                                             |
| `packages/core/src/session-key.ts` **新建**      | `sessionKeyOf(messages)` 首条 user 消息指纹                                        |
| `packages/core/src/router/auto-router.ts` 修改   | `heuristicCapabilityScore` 改查表；新增粘性表读写与清理                            |
| `packages/core/src/registry.ts` 修改             | `buildFallbackChain` 替代 `pickFromScoredPool`；`resolveModel` 加 `opts`           |
| `packages/core/src/index.ts` 修改                | 导出三个新模块的公共符号                                                           |
| `packages/server/src/routes/openai.ts` 修改      | 传 `opts`、`onPick` 回调、响应附加 `fmf_auto_route.pool/sticky`、failover 更新粘性 |

---

### Task 1: 结构化档位解析 `model-tier.ts`

**Files:**

- Create: `packages/core/src/model-tier.ts`
- Test: `packages/core/src/__tests__/model-tier.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelProfile, TIER_SCORES } from '../model-tier.js';

describe('parseModelProfile', () => {
  it('small markers win over flagship markers', () => {
    assert.equal(parseModelProfile('cpa:gpt-4o-mini').tier, 'small');
    assert.equal(parseModelProfile('glm-4-flash').tier, 'small');
    assert.equal(parseModelProfile('glm-4.5-flash').tier, 'small');
    assert.equal(parseModelProfile('claude-3.5-haiku').tier, 'small');
    assert.equal(parseModelProfile('inclusionai/ling-3.0-flash-sante:free').tier, 'small');
  });

  it('tiny markers rank below small', () => {
    assert.equal(parseModelProfile('qwen2.5-3b-instruct').tier, 'tiny');
    assert.equal(parseModelProfile('tiny-1b').tier, 'tiny');
    assert.equal(parseModelProfile('nano-2b').tier, 'tiny');
  });

  it('minor markers capture 7b-10b and named small tiers', () => {
    assert.equal(parseModelProfile('llama-3.1-8b-instruct').tier, 'minor');
    assert.equal(parseModelProfile('qwen2.5-small').tier, 'minor');
    assert.equal(parseModelProfile('some-nano-model').tier, 'minor');
  });

  it('flagship markers still apply when no size marker present', () => {
    assert.equal(parseModelProfile('cpa:gpt-4o').tier, 'flagship');
    assert.equal(parseModelProfile('cpa:gpt-5.5').tier, 'flagship');
    assert.equal(parseModelProfile('claude-3-opus').tier, 'flagship');
    assert.equal(parseModelProfile('llama-3.1-70b-instruct').tier, 'flagship');
    assert.equal(parseModelProfile('deepseek-v3').tier, 'flagship');
    assert.equal(parseModelProfile('glm-4.5').tier, 'flagship');
  });

  it('large markers capture gpt-4 class and 30b-40b', () => {
    assert.equal(parseModelProfile('cpa:gpt-4').tier, 'large');
    assert.equal(parseModelProfile('glm-4-flash-air'.replace('-flash', '')).tier, 'large');
    assert.equal(parseModelProfile('meta/llama-3.3-40b').tier, 'large');
    assert.equal(parseModelProfile('claude-3-sonnet').tier, 'large');
  });

  it('parameter counts need word boundaries so 140b is not 40b', () => {
    assert.equal(parseModelProfile('mystery-140b').tier, 'standard');
    assert.equal(parseModelProfile('mystery-140b').tier, TIER_SCORES.standard);
    assert.equal(parseModelProfile('mystery-40b').tier, 'large');
    assert.equal(parseModelProfile('mystery-10b').tier, 'minor');
    assert.equal(parseModelProfile('mystery-20b').tier, 'small');
    assert.equal(parseModelProfile('mystery-405b').tier, 'flagship');
  });

  it('unknown ids fall back to standard', () => {
    assert.equal(parseModelProfile('mystery-model').tier, 'standard');
    assert.equal(TIER_SCORES.standard, 50);
  });

  it('parses numeric generations and leaves unparseable ones null', () => {
    assert.equal(parseModelProfile('cpa:gpt-5.5').generation, 5.5);
    assert.equal(parseModelProfile('cpa:gpt-4o').generation, 4);
    assert.equal(parseModelProfile('claude-3.5-sonnet').generation, 3.5);
    assert.equal(parseModelProfile('deepseek-v3').generation, 3);
    assert.equal(parseModelProfile('gemini-2.5-flash').generation, 2.5);
    assert.equal(parseModelProfile('mystery-model').generation, null);
  });

  it('tier score table matches the frozen value domain', () => {
    assert.deepEqual(TIER_SCORES, {
      flagship: 95,
      large: 80,
      standard: 50,
      small: 65,
      minor: 45,
      tiny: 30,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/model-tier.test.ts`
Expected: FAIL — Cannot find module `../model-tier.js`

- [ ] **Step 3: 最小实现**

```ts
export type ModelTier = 'flagship' | 'large' | 'standard' | 'small' | 'minor' | 'tiny';

export interface ModelProfile {
  tier: ModelTier;
  generation: number | null;
}

export const TIER_SCORES: Record<ModelTier, number> = {
  flagship: 95,
  large: 80,
  standard: 50,
  small: 65,
  minor: 45,
  tiny: 30,
};

const TINY_PATTERNS = [/tiny/i, /\b(?:1|2|3)b\b/i];

const MINOR_PATTERNS = [/small/i, /nano/i, /\b(?:7|8|9|10)b\b/i];

const SMALL_PATTERNS = [
  /mini/i,
  /flash/i,
  /haiku/i,
  /lite/i,
  /air/i,
  /mixtral/i,
  /command-r/i,
  /\b(?:13|14|20)b\b/i,
];

const FLAGSHIP_PATTERNS = [
  /opus/i,
  /gpt-5/i,
  /gpt-4o/i,
  /deepseek-r1/i,
  /deepseek-v3/i,
  /glm-4\.5/i,
  /qwen-max/i,
  /gemini-2\.5-pro/i,
  /claude-3\.5/i,
  /\b(?:65|70|72|80|405)b\b/i,
];

const LARGE_PATTERNS = [
  /gpt-4/i,
  /glm-4/i,
  /gemini-2\.0/i,
  /deepseek-v2/i,
  /qwen-plus/i,
  /sonnet/i,
  /\b(?:30|32|34|40)b\b/i,
];

const GENERATION_PATTERNS = [
  /gpt-(\d+(?:\.\d+)?)/i,
  /claude-(\d+(?:\.\d+)?)/i,
  /glm-(\d+(?:\.\d+)?)/i,
  /gemini-(\d+(?:\.\d+)?)/i,
  /deepseek-v(\d+(?:\.\d+)?)/i,
  /qwen[-_]?(\d+)/i,
  /llama-(\d+(?:\.\d+)?)/i,
];

function firstMatch(patterns: RegExp[], id: string): boolean {
  return patterns.some((p) => p.test(id));
}

export function parseModelProfile(id: string): ModelProfile {
  let tier: ModelTier = 'standard';
  if (firstMatch(TINY_PATTERNS, id)) tier = 'tiny';
  else if (firstMatch(MINOR_PATTERNS, id)) tier = 'minor';
  else if (firstMatch(SMALL_PATTERNS, id)) tier = 'small';
  else if (firstMatch(FLAGSHIP_PATTERNS, id)) tier = 'flagship';
  else if (firstMatch(LARGE_PATTERNS, id)) tier = 'large';

  let generation: number | null = null;
  for (const p of GENERATION_PATTERNS) {
    const m = id.match(p);
    if (m?.[1]) {
      generation = Number.parseFloat(m[1]);
      break;
    }
  }
  return { tier, generation };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/model-tier.test.ts`
Expected: PASS，全部用例通过

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/model-tier.ts packages/core/src/__tests__/model-tier.test.ts
git commit -m "feat(core): 结构化档位解析替代模型 id 正则打分"
```

---

### Task 2: `scoreModel` capability 改为查表

**Files:**

- Modify: `packages/core/src/router/auto-router.ts:120-136`
- Test: `packages/core/src/router/__tests__/score-model.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `describe('scoreModel')` 内，S1–S10 保持不动）

```ts
it('S11: gpt-4o-mini scores as a small model, not flagship', () => {
  const m = makeModel('cpa:gpt-4o-mini', 'custom');
  assert.equal(scoreModel(m, 'capability'), 65);
});

it('S12: glm-4-flash scores as a small model', () => {
  const m = makeModel('glm-4-flash', 'zhipu');
  assert.equal(scoreModel(m, 'capability'), 65);
});

it('S13: flagship ids keep 95', () => {
  assert.equal(scoreModel(makeModel('cpa:gpt-5.5', 'custom'), 'capability'), 95);
  assert.equal(scoreModel(makeModel('cpa:gpt-4o', 'custom'), 'capability'), 95);
  assert.equal(scoreModel(makeModel('llama-3.1-70b', 'openrouter'), 'capability'), 95);
});

it('S14: speed and rate-limit strategies are untouched by tier parsing', () => {
  assert.equal(scoreModel(makeModel('gemini-2.0-flash', 'gemini'), 'speed'), 85);
  assert.equal(scoreModel(makeModel('claude-3-opus', 'openrouter'), 'speed'), 35);
  assert.equal(scoreModel(makeModel('anything', 'siliconflow'), 'rate-limit'), 70);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/router/__tests__/score-model.test.ts`
Expected: S11 FAIL — actual 95, expected 65（S1–S10、S14 仍通过）

- [ ] **Step 3: 实现——把 `heuristicCapabilityScore` 函数体替换为**

```ts
function heuristicCapabilityScore(m: ModelInfo): number {
  const { tier } = parseModelProfile(m.id);
  let score = TIER_SCORES[tier];
  if (m.contextWindow && m.contextWindow >= 128_000) score += 5;
  return score;
}
```

并在文件顶部 import：

```ts
import { parseModelProfile, TIER_SCORES } from '../model-tier.js';
```

`heuristicSpeedScore`、`heuristicRpmScore`、`scoreModel` 分派逻辑一律不动。

- [ ] **Step 4: 跑测试确认通过（含 S1–S10 回归）**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/router/__tests__/score-model.test.ts`
Expected: PASS，S1–S14 全通过

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/router/auto-router.ts packages/core/src/router/__tests__/score-model.test.ts
git commit -m "feat(core): capability 分数改由档位表得出"
```

---

### Task 3: token 估算

**Files:**

- Create: `packages/core/src/context-estimate.ts`
- Test: `packages/core/src/__tests__/context-estimate.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateInputTokens } from '../context-estimate.js';

describe('estimateInputTokens', () => {
  it('counts message content at three characters per token', () => {
    const n = estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(300) }] });
    assert.equal(n, 100);
  });

  it('includes tool definitions', () => {
    const a = estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] });
    const b = estimateInputTokens({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { a: 1 } } }],
    });
    assert.ok(b > a);
  });

  it('includes contentParts text and tool_calls payloads', () => {
    const withParts = estimateInputTokens({
      messages: [
        {
          role: 'user',
          content: '',
          contentParts: [{ type: 'text', text: 'y'.repeat(300) }],
        },
      ],
    });
    assert.equal(withParts, 100);

    const withCalls = estimateInputTokens({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c0', type: 'function', function: { name: 'f', arguments: 'z'.repeat(600) } },
          ],
        },
      ],
    });
    assert.equal(withCalls, 200);
  });

  it('rounds up and never returns a negative', () => {
    assert.equal(estimateInputTokens({ messages: [{ role: 'user', content: 'x' }] }), 1);
    assert.equal(estimateInputTokens({ messages: [] }), 0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/context-estimate.test.ts`
Expected: FAIL — Cannot find module `../context-estimate.js`

- [ ] **Step 3: 实现**

```ts
import type { ChatRequest, ChatMessage } from './types.js';

const CHARS_PER_TOKEN = 3;

function partText(parts: ChatMessage['contentParts']): number {
  if (!parts) return 0;
  let chars = 0;
  for (const p of parts) {
    if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') {
      chars += p.text.length;
    }
  }
  return chars;
}

function messageChars(m: ChatMessage): number {
  let chars = (m.content ?? '').length + partText(m.contentParts);
  for (const call of m.tool_calls ?? []) {
    chars += (call.function?.name ?? '').length + (call.function?.arguments ?? '').length;
  }
  return chars;
}

export function estimateInputTokens(req: Pick<ChatRequest, 'messages' | 'tools'>): number {
  let chars = 0;
  for (const m of req.messages) chars += messageChars(m);
  if (req.tools?.length) chars += JSON.stringify(req.tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
```

若 `ToolCall.function` 字段在 `types.ts` 中的可选性与上面访问方式不符（`noUncheckedIndexedAccess`），按实际 schema 调整为安全访问，行为不变：**只要有文本就计入，缺失字段按 0 处理**。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/context-estimate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/context-estimate.ts packages/core/src/__tests__/context-estimate.test.ts
git commit -m "feat(core): 上下文输入 token 估算"
```

---

### Task 4: 会话指纹 + 粘性表

**Files:**

- Create: `packages/core/src/session-key.ts`
- Modify: `packages/core/src/router/auto-router.ts`（类内新增方法与字段）
- Test: `packages/core/src/__tests__/session-key.test.ts`
- Test: `packages/core/src/router/__tests__/sticky.test.ts`（新建）

- [ ] **Step 1: 写会话指纹失败测试**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sessionKeyOf } from '../session-key.js';

const user = (text: string) => ({ role: 'user' as const, content: text });

describe('sessionKeyOf', () => {
  it('is stable across later turns of the same conversation', () => {
    const first = sessionKeyOf([user('hello')]);
    const later = sessionKeyOf([user('hello'), { role: 'assistant', content: 'hi' }, user('next')]);
    assert.equal(first, later);
  });

  it('differs for different conversations', () => {
    assert.notEqual(sessionKeyOf([user('hello')]), sessionKeyOf([user('hello2')]));
  });

  it('ignores image parts so multimodal turns keep the same key', () => {
    const text = sessionKeyOf([user('describe')]);
    const withImage = sessionKeyOf([
      {
        role: 'user',
        content: 'describe',
        contentParts: [{ type: 'image_url', image_url: { url: 'u' } }],
      },
    ]);
    assert.equal(text, withImage);
  });

  it('returns a stable key when no user message exists', () => {
    assert.equal(
      sessionKeyOf([{ role: 'assistant', content: 'only' }]),
      sessionKeyOf([{ role: 'assistant', content: 'only' }]),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/session-key.test.ts`
Expected: FAIL — Cannot find module `../session-key.js`

- [ ] **Step 3: 实现 session-key.ts**

```ts
import { createHash } from 'node:crypto';
import type { ChatMessage } from './types.js';

export function sessionKeyOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user') ?? messages[0];
  if (!first) return 'empty';
  const material = `${first.role}:${first.content ?? ''}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}
```

- [ ] **Step 4: 跑会话指纹测试确认通过**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/__tests__/session-key.test.ts`
Expected: PASS

- [ ] **Step 5: 写粘性表失败测试**

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AutoRouter, resetStickyStore } from '../auto-router.js';
import type { AppConfig } from '../../types.js';

function router(): AutoRouter {
  const config: AppConfig = {
    version: 1,
    port: 11435,
    providers: { openrouter: { enabled: true, credentials: { apiKey: 'k' } } },
    autoRoute: { enabled: true, strategy: 'capability' },
  };
  return new AutoRouter(config);
}

describe('AutoRouter sticky store', () => {
  beforeEach(() => resetStickyStore());

  it('stores and returns a sticky pick until it expires', () => {
    const r = router();
    assert.equal(r.getSticky('s1'), null);
    r.setSticky('s1', 'openrouter', 'big-70b');
    assert.deepEqual(r.getSticky('s1'), { provider: 'openrouter', modelId: 'big-70b' });
  });

  it('clears a single key and all keys', () => {
    const r = router();
    r.setSticky('s1', 'openrouter', 'a');
    r.setSticky('s2', 'openrouter', 'b');
    assert.equal(r.clearSticky('s1'), true);
    assert.equal(r.getSticky('s1'), null);
    assert.notEqual(r.getSticky('s2'), null);
    resetStickyStore();
    assert.equal(r.getSticky('s2'), null);
  });

  it('drops expired entries on read', () => {
    const r = router();
    r.setSticky('s1', 'openrouter', 'a', -1);
    assert.equal(r.getSticky('s1'), null);
  });

  it('evicts oldest entry beyond the capacity cap', () => {
    const r = router();
    for (let i = 0; i < 1001; i++) r.setSticky(`k${i}`, 'openrouter', `m${i}`);
    assert.equal(r.getSticky('k0'), null);
    assert.notEqual(r.getSticky('k1000'), null);
  });
});
```

若 `AutoRouter` 构造签名与上面不符（需 registry/config 形状不同），按 `auto-router.ts` 现有测试（`router/__tests__/` 下任一文件）的构造方式调整 `router()` 帮助函数，断言保持不变。

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/router/__tests__/sticky.test.ts`
Expected: FAIL — `resetStickyStore` 未导出

- [ ] **Step 7: 实现粘性表**

在 `auto-router.ts` 文件级（`AutoRouter` 类外）加：

```ts
const STICKY_TTL_MS = 5 * 60 * 1000;
const STICKY_CAPACITY = 1000;

interface StickyEntry {
  provider: ProviderId;
  modelId: string;
  expiresAt: number;
}

const stickyStore = new Map<string, StickyEntry>();

export function resetStickyStore(): void {
  stickyStore.clear();
}
```

在 `AutoRouter` 类内加：

```ts
  getSticky(sessionKey: string): { provider: ProviderId; modelId: string } | null {
    const entry = stickyStore.get(sessionKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      stickyStore.delete(sessionKey);
      return null;
    }
    return { provider: entry.provider, modelId: entry.modelId };
  }

  setSticky(sessionKey: string, provider: ProviderId, modelId: string, ttlMs = STICKY_TTL_MS): void {
    stickyStore.delete(sessionKey);
    stickyStore.set(sessionKey, { provider, modelId, expiresAt: Date.now() + ttlMs });
    while (stickyStore.size > STICKY_CAPACITY) {
      const oldest = stickyStore.keys().next().value;
      if (oldest === undefined) break;
      stickyStore.delete(oldest);
    }
  }

  clearSticky(sessionKey: string): boolean {
    return stickyStore.delete(sessionKey);
  }
```

把现有的 `resetAutoPoolCursor` 语义扩展——`registry.ts` 中改为：

```ts
export function resetAutoPoolCursor(): void {
  resetStickyStore();
}
```

并删除 `let autoPoolCursor = 0;`（该变量在 Task 5 中一并移除使用点；若此时 `noUnusedLocals` 报错，先保留 `autoPoolCursor` 声明与 `resetAutoPoolCursor` 内的 `autoPoolCursor = 0;`，Task 5 删除）。

`auto-router.ts` 需 import `ProviderId`（已有则跳过）。

- [ ] **Step 8: 跑粘性测试确认通过**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/router/__tests__/sticky.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```powershell
git add packages/core/src/session-key.ts packages/core/src/__tests__/session-key.test.ts packages/core/src/router/__tests__/sticky.test.ts packages/core/src/router/auto-router.ts packages/core/src/registry.ts
git commit -m "feat(core): 会话指纹与 auto 粘性表"
```

---

### Task 5: fallback 链 + 预检 + 粘性接入 `registry.ts`

**Files:**

- Modify: `packages/core/src/registry.ts:67-71`（游标）、`registry.ts:342-369`（resolveModel auto 分支）、`registry.ts:476-508`（pickFromScoredPool）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/registry/__tests__/registry.test.ts:315-461`

- [ ] **Step 1: 改写受影响的旧测试（RED）**

在 `registry.test.ts` 中：

1. **删除** `it('round-robins across the scored pool for auto', ...)`（379–386 行）
2. **删除** `it('wraps the pool cursor around after the pool size', ...)`（434–443 行）
3. **保留** `skips cooling-down members`、`falls back to the first catalog model when the whole pool is cooling`、`recomputes the pool when strategy changes`、`default resolves defaultModel first`、`auto throws when no provider catalog is available` 原样
4. 在该 `describe` 末尾**追加**以下用例（`catalogRegistry`/`prime`/`fill` 复用现有帮助函数）：

```ts
it('keeps the same model for the same session across requests', async () => {
  resetAutoPoolCursor();
  const registry = catalogRegistry([smallModel, bigModel, midModel]);
  await fill(registry);
  const opts = { sessionKey: 'sess-a' };
  const a = registry.resolveModel('auto', opts).modelId;
  const b = registry.resolveModel('auto', opts).modelId;
  assert.equal(a, b);
  assert.equal(registry.resolveModel('auto', opts).sticky, true);
});

it('re-picks when the sticky model cools down', async () => {
  resetAutoPoolCursor();
  const registry = catalogRegistry([smallModel, bigModel, midModel]);
  await fill(registry);
  const opts = { sessionKey: 'sess-b' };
  const first = registry.resolveModel('auto', opts).modelId;
  const router = registry.getAutoRouter();
  router.markRateLimited(first, 'openrouter', {
    isRateLimit: true,
    resetAt: Date.now() + 60_000,
    message: 'rpm',
  });
  router.clearProviderCooldown('openrouter');
  const second = registry.resolveModel('auto', opts).modelId;
  assert.notEqual(second, first);
  assert.equal(router.getSticky('sess-b')?.modelId, second);
});

it('serves a fresh pick without a session key', async () => {
  resetAutoPoolCursor();
  const registry = catalogRegistry([smallModel, bigModel, midModel]);
  await fill(registry);
  const pick = registry.resolveModel('auto');
  assert.equal(pick.modelId, 'big-70b');
  assert.equal(pick.sticky, undefined);
});

it('caps a single provider at two seats on the fallback chain', async () => {
  resetAutoPoolCursor();
  const flood: ModelInfo[] = [];
  for (let i = 0; i < 6; i++) {
    flood.push({ id: `custom-gpt-5.${i}`, provider: 'custom', displayName: 'C', free: true });
  }
  flood.push({ id: 'big-70b', provider: 'openrouter', displayName: 'O', free: true });
  const registry = catalogRegistry([...flood]);
  await fill(registry);
  const chain = (
    registry as unknown as { buildFallbackChain(i?: number): ModelInfo[] }
  ).buildFallbackChain();
  const customSeats = chain.filter((m) => m.provider === 'custom').length;
  assert.ok(customSeats <= 2, `custom seats = ${customSeats}`);
  assert.ok(chain.some((m) => m.provider === 'openrouter'));
  assert.ok(chain.length >= 3);
});

it('orders equal scores by generation then id', async () => {
  resetAutoPoolCursor();
  const registry = catalogRegistry([
    { id: 'gpt-4o', provider: 'custom', displayName: 'a', free: true },
    { id: 'gpt-5.5', provider: 'custom', displayName: 'b', free: true },
  ]);
  await fill(registry);
  const chain = (
    registry as unknown as { buildFallbackChain(i?: number): ModelInfo[] }
  ).buildFallbackChain();
  assert.equal(chain[0]?.id, 'gpt-5.5');
  assert.equal(chain[1]?.id, 'gpt-4o');
});

it('drops candidates whose window cannot hold the prompt', async () => {
  resetAutoPoolCursor();
  const registry = catalogRegistry([
    { id: 'small-8k', provider: 'openrouter', displayName: 'S', free: true, contextWindow: 8192 },
    { id: 'huge-1m', provider: 'zhipu', displayName: 'H', free: true, contextWindow: 1_000_000 },
  ]);
  await fill(registry);
  const chain = (
    registry as unknown as { buildFallbackChain(i?: number): ModelInfo[] }
  ).buildFallbackChain(6000);
  assert.deepEqual(
    chain.map((m) => m.id),
    ['huge-1m'],
  );
});

it('falls back to the largest window when every candidate fails the precheck', async () => {
  resetAutoPoolCursor();
  const registry = catalogRegistry([
    { id: 'a-8k', provider: 'openrouter', displayName: 'A', free: true, contextWindow: 8192 },
    { id: 'b-16k', provider: 'zhipu', displayName: 'B', free: true, contextWindow: 16384 },
  ]);
  await fill(registry);
  const chain = (
    registry as unknown as { buildFallbackChain(i?: number): ModelInfo[] }
  ).buildFallbackChain(999_999);
  assert.ok(chain.length >= 1);
  assert.equal(chain[0]?.id, 'b-16k');
});
```

其中 `router0` 帮助函数定义在 `describe` 顶部（若不需要可删除该行断言，改为 `assert.equal(registry.resolveModel('auto').sticky, undefined)` 重复即可）；`buildFallbackChain(inputTokens?: number)` 的第二个签名以 Task 5 Step 3 的实现为准，若实现为对象参数则把上面 `buildFallbackChain(6000)` 改为 `buildFallbackChain({ inputTokens: 6000 })`，断言不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --import tsx --test src/registry/__tests__/registry.test.ts`
Expected: FAIL — `resolveModel` 第二参数不被接受、`buildFallbackChain` 不存在

- [ ] **Step 3: 实现**

**(a) `registry.ts` 替换整个 `pickFromScoredPool`（476–508 行，含其上的 JSDoc）为：**

```ts
  private buildFallbackChain(inputTokens?: number): ModelInfo[] {
    const cached = this.modelsCache?.models;
    if (!cached || cached.length === 0) return [];
    const strategy = this.autoRouter.getStrategy();
    const cooling = (m: ModelInfo): boolean => {
      if (this.autoRouter.isProviderRateLimited(m.provider)) return true;
      if (
        this.autoRouter.isRateLimited(bareModelId(m.provider, m.id)) ||
        this.autoRouter.isRateLimited(composeModelId(m.provider, m.id))
      ) {
        return true;
      }
      return false;
    };
    const alive = cached.filter((m) => !cooling(m));
    const poolable = (m: ModelInfo): boolean => {
      if (inputTokens === undefined) return true;
      if (!m.contextWindow || m.contextWindow <= 0) return true;
      return inputTokens <= m.contextWindow * 0.95;
    };
    let eligible = alive.filter(poolable);
    if (eligible.length === 0 && alive.length > 0) eligible = alive;
    if (eligible.length === 0) return [];
    const scored = eligible
      .map((m) => ({
        m,
        s: scoreModel(m, strategy, this.autoRouter.getProfile(m.id)),
        g: parseModelProfile(m.id).generation,
      }))
      .sort(
        (a, b) => b.s - a.s || (b.g ?? Number.NEGATIVE_INFINITY) - (a.g ?? Number.NEGATIVE_INFINITY) || a.m.id.localeCompare(b.m.id),
      );
    const seats = new Map<ProviderId, number>();
    const chain: ModelInfo[] = [];
    for (const row of scored) {
      const used = seats.get(row.m.provider) ?? 0;
      if (used >= 2) continue;
      seats.set(row.m.provider, used + 1);
      chain.push(row.m);
      if (chain.length >= 5) break;
    }
    return chain;
  }
```

**(b) `resolveModel` 签名与 auto 分支改为：**

```ts
  resolveModel(
    modelId: string,
    opts?: { inputTokens?: number; sessionKey?: string; onPick?: (info: { sticky: boolean; pool: string[] }) => void },
  ): { provider: BaseProvider; modelId: string; sticky?: boolean } {
    if (modelId === 'auto' || modelId === 'default') {
      if (modelId === 'default') {
        const preferred = this.config.defaultModel;
        if (preferred && preferred !== 'auto' && preferred !== 'default') {
          return this.resolveModel(preferred, opts);
        }
      }
      const enabled = this.listEnabledProviders();
      if (enabled.length === 0) {
        throw new Error('no provider is configured; add an API key in Settings first');
      }
      if (modelId === 'auto') {
        const picked = this.pickAutoModel(opts);
        if (picked) return picked;
      }
      const cached = this.modelsCache?.models;
      if (cached && cached.length > 0) {
        const first = cached[0]!;
        return {
          provider: this.getProvider(first.provider),
          modelId: bareModelId(first.provider, first.id),
        };
      }
      throw new Error(
        'no model available for `auto`; wait for /v1/models to load or set a default model',
      );
    }
```

（其后 `const sep = modelId.indexOf(':');` 起的原有逻辑不变。）

**(c) 新增 `pickAutoModel`（放在 `buildFallbackChain` 之后）：**

```ts
  private pickAutoModel(
    opts?: { inputTokens?: number; sessionKey?: string; onPick?: (info: { sticky: boolean; pool: string[] }) => void },
  ): { provider: BaseProvider; modelId: string; sticky?: boolean } | null {
    const chain = this.buildFallbackChain(opts?.inputTokens);
    if (chain.length === 0) return null;
    const pool = chain.map((m) => composeModelId(m.provider, m.id));
    const key = opts?.sessionKey;
    if (key) {
      const sticky = this.autoRouter.getSticky(key);
      if (sticky) {
        const hit = chain.find((m) => m.provider === sticky.provider && bareModelId(m.provider, m.id) === sticky.modelId);
        if (hit) {
          opts?.onPick?.({ sticky: true, pool });
          return {
            provider: this.getProvider(hit.provider),
            modelId: bareModelId(hit.provider, hit.id),
            sticky: true,
          };
        }
        this.autoRouter.clearSticky(key);
      }
    }
    const head = chain[0]!;
    if (key) this.autoRouter.setSticky(key, head.provider, bareModelId(head.provider, head.id));
    opts?.onPick?.({ sticky: false, pool });
    return {
      provider: this.getProvider(head.provider),
      modelId: bareModelId(head.provider, head.id),
      sticky: false,
    };
  }
```

**(d) 清理游标**：删除 `let autoPoolCursor = 0;`、`resetAutoPoolCursor` 中的 `autoPoolCursor = 0;`（保留 `resetStickyStore()` 调用）。若 `registry.test.ts` 等仍 import `resetAutoPoolCursor`，函数保留导出。

**(e) `index.ts` 追加导出：**

```ts
export { parseModelProfile, TIER_SCORES, type ModelTier, type ModelProfile } from './model-tier.js';
export { estimateInputTokens } from './context-estimate.js';
export { sessionKeyOf } from './session-key.js';
export { resetStickyStore } from './router/auto-router.js';
```

- [ ] **Step 4: 跑 core 全量测试**

Run: `pnpm --filter @freemodelfinder/core build; if ($?) { pnpm --filter @freemodelfinder/core test }`
Expected: PASS（registry、score-model、model-tier、context-estimate、session-key、sticky 全绿）

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/registry.ts packages/core/src/index.ts packages/core/src/registry/__tests__/registry.test.ts
git commit -m "feat(core): auto 改为结构化 fallback 链与会话粘性"
```

---

### Task 6: server 接线（预检、粘性、可观测）

**Files:**

- Modify: `packages/server/src/routes/openai.ts`（约 177–260 `dispatchWithAutoRoute`、约 841–866 流式 resolve、约 946/988 重试与 failover、约 779–784 与 901–906 响应字段）
- Test: `packages/server/src/__tests__/auto-sticky.test.ts` **新建**

- [ ] **Step 1: 写失败 e2e 测试**

参照 `packages/server/src/__tests__/context-overflow-failover.test.ts` 的 `appWithPool` 构造方式与 import 结构（先读该文件，复用同样的 helper 写法、`resetAutoPoolCursor()` 调用时机、以及 `buildApp`/注入 fake provider 的方式）。新文件骨架：

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetAutoPoolCursor } from '@freemodelfinder/core';

describe('auto sticky and precheck', () => {
  beforeEach(() => resetAutoPoolCursor());

  it('returns the same model for the same opening user message', async () => {
    const { app, pool } = await appWithPool([
      {
        id: 'big-70b',
        provider: 'openrouter',
        displayName: 'B',
        free: true,
        contextWindow: 200_000,
      },
      { id: 'tiny-3b', provider: 'zhipu', displayName: 'T', free: true, contextWindow: 32_000 },
    ]);
    const body = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello sticky world' }],
    };
    const first = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body });
    const second = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(pool.calls[0]?.model, pool.calls[1]?.model);
    const parsed = JSON.parse(second.body) as { fmf_auto_route?: { sticky?: boolean } };
    assert.equal(parsed.fmf_auto_route?.sticky, true);
  });

  it('reports a pool and sticky flag on auto picks', async () => {
    const { app } = await appWithPool([
      {
        id: 'big-70b',
        provider: 'openrouter',
        displayName: 'B',
        free: true,
        contextWindow: 200_000,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    const parsed = JSON.parse(res.body) as {
      fmf_auto_route?: { picked?: string; pool?: string[]; sticky?: boolean };
    };
    assert.ok(parsed.fmf_auto_route?.pool?.length);
    assert.equal(typeof parsed.fmf_auto_route?.sticky, 'boolean');
  });

  it('skips a model whose window cannot hold the prompt', async () => {
    const { app, pool } = await appWithPool([
      { id: 'small-8k', provider: 'openrouter', displayName: 'S', free: true, contextWindow: 8192 },
      { id: 'huge-1m', provider: 'zhipu', displayName: 'H', free: true, contextWindow: 1_000_000 },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(40_000) }] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(pool.calls.at(-1)?.model, 'huge-1m');
  });

  it('still fails over on context_length_exceeded when the precheck cannot see it', async () => {
    const { app, pool } = await appWithPool(
      [
        { id: 'blind-8k', provider: 'openrouter', displayName: 'B', free: true },
        { id: 'healthy', provider: 'zhipu', displayName: 'H', free: true, contextWindow: 200_000 },
      ],
      {
        'openrouter:blind-8k': () => {
          throw Object.assign(
            new Error(
              'custom stream failed 400: {"error":{"message":"input exceeds the context limit; set truncation to auto to permit history truncation","type":"invalid_request_error","param":"","code":"context_length_exceeded"}}',
            ),
          );
        },
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(pool.calls.some((c) => c.model === 'healthy'));
  });
});
```

`appWithPool` 的第二个参数（按 provider:model 覆盖行为的 map）若现有 helper 不支持，按 `context-overflow-failover.test.ts` 里已有的覆盖方式改写第 4 个用例的错误注入写法，断言不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/__tests__/auto-sticky.test.ts`
Expected: FAIL — `fmf_auto_route.pool`/`sticky` 为 undefined；或 precheck 未生效导致第 3 用例选中 `small-8k`

- [ ] **Step 3: 实现接线**

**(a) 构造 opts 并传入 resolveModel。** 在流式路径 `const router = reg.getAutoRouter();`（约 841 行）之后、`const resolved = reg.resolveModel(chatReq.model);`（853）之前插入：

```ts
let stickyHit = false;
let routePool: string[] = [];
const routeOpts = {
  inputTokens: estimateInputTokens(chatReq),
  sessionKey: sessionKeyOf(chatReq.messages),
  onPick: (info: { sticky: boolean; pool: string[] }) => {
    stickyHit = info.sticky;
    routePool = info.pool;
  },
};
```

把 853、946、988 三处 `reg.resolveModel(chatReq.model)` 改为 `reg.resolveModel(chatReq.model, routeOpts)`。

顶部 import：

```ts
import { estimateInputTokens, sessionKeyOf } from '@freemodelfinder/core';
```

**(b) `dispatchWithAutoRoute`（非流式/通用路径，177 起）。** 在 `const seq = newFailoverSeq();` 之后插入同样的三个变量与 `routeOpts`，把 210 行 `reg.resolveModel(chatReq.model)` 改为 `reg.resolveModel(chatReq.model, routeOpts)`；把 `stickyHit`/`routePool` 纳入返回值 `{ finalModel, finalProviderId, response, notices }` → 增加 `sticky: stickyHit, pool: routePool`，并在调用处（约 771 `const { response, notices, finalModel } = result;`）解构出来。

**(c) 响应字段。** 非流式（780 附近）改为：

```ts
if (body.model === 'auto') {
  (payload as Record<string, unknown>).fmf_auto_route = {
    picked: finalModel,
    strategy: reg.getAutoRouter().getStrategy(),
    sticky: result.sticky,
    pool: result.pool,
  };
}
```

流式（902 附近）改为：

```ts
if (body.model === 'auto') {
  (payload as Record<string, unknown>).fmf_auto_route = {
    picked: `${provider.id}:${realModelId}`,
    strategy: router.getStrategy(),
    sticky: stickyHit,
    pool: routePool,
  };
}
```

**(d) failover 后更新粘性。** 在 986 行 `chatReq.model = composeModelId(next.provider, next.id);` 之后插入：

```ts
router.setSticky(routeOpts.sessionKey, next.provider, next.id);
```

- [ ] **Step 4: 跑 server 相关测试**

Run: `pnpm --filter @freemodelfinder/core build; if ($?) { pnpm --filter @freemodelfinder/server exec node --import tsx --import ./src/__tests__/setup.mjs --test src/__tests__/auto-sticky.test.ts src/__tests__/context-overflow-failover.test.ts src/routes/__tests__/auto-modality.test.ts }`
Expected: PASS（`auto-modality.test.ts:320` 的 `fmf_auto_route` 断言若只校验 `picked`/`strategy` 则仍通过；若用 `deepEqual` 校验全对象则按新字段补全期望值）

- [ ] **Step 5: Commit**

```powershell
git add packages/server/src/routes/openai.ts packages/server/src/__tests__/auto-sticky.test.ts
git commit -m "feat(server): auto 接入预检、粘性与路由可观测"
```

---

### Task 7: 全量验证与收尾

- [ ] **Step 1: 逐文件 prettier**

```powershell
npx prettier --write packages/core/src/model-tier.ts packages/core/src/context-estimate.ts packages/core/src/session-key.ts packages/core/src/router/auto-router.ts packages/core/src/registry.ts packages/core/src/index.ts packages/core/src/__tests__/model-tier.test.ts packages/core/src/__tests__/context-estimate.test.ts packages/core/src/__tests__/session-key.test.ts packages/core/src/router/__tests__/score-model.test.ts packages/core/src/router/__tests__/sticky.test.ts packages/core/src/registry/__tests__/registry.test.ts packages/server/src/routes/openai.ts packages/server/src/__tests__/auto-sticky.test.ts
```

- [ ] **Step 2: CI 同序验证（跳过 format:check/test:pack/audit:prod/verify:release）**

```powershell
pnpm lint; if ($?) { pnpm build:runtime }; if ($?) { pnpm typecheck }; if ($?) { pnpm test:coverage }
```

Expected: lint 0 warnings；typecheck 5 包通过；coverage 阈值（core 85%/74%、server 80%/75%、cli 80%）全达标

- [ ] **Step 3: 修正设计文档中与实现不符的两处**

> **执行期状态**：原列 3 处，其中 2 处已在执行中提前完成，**本步只剩第 1 条**。
>
> - ~~§1 `claude-3.5-sonnet` 行~~ → 已完成（commit `73a2be7`：改为 95 并注明判定顺序原因）
> - ~~§4 `tool_calls` 只计 `arguments` 不计 `name`~~ → 已完成（commit `e124160`，含风险 4「多模态 text 双计」记录）
> - 执行期另补的文档修正（均已完成）：§1 模式表 `\bmini\b`/`\blite\b`、移除 `air`、记录超大参数量落 standard 的立场（`1b91e87`）、§1 补记下划线归一化（`100cc84`）

`docs/superpowers/specs/2026-09-30-auto-route-sticky-fallback-design.md`：

1. §5 的 `pool: [...]` —— 现状 `fmf_auto_route` 只有 `{picked, strategy}`，本次新增 `pool` 与 `sticky`，把描述改为「在既有 `{picked, strategy}` 上新增 `pool`（候选链）与 `sticky`（是否命中粘性）」。
2. ~~§1 表格里 `claude-3.5-sonnet | 95 | 80` 一行与实现不符~~ —— 已完成（`73a2be7`）。

```powershell
npx prettier --write docs/superpowers/specs/2026-09-30-auto-route-sticky-fallback-design.md
git add docs/superpowers/specs/2026-09-30-auto-route-sticky-fallback-design.md
git commit -m "docs: 修正 spec 与实现的两处偏差"
```

- [ ] **Step 4: 最终检查**

```powershell
git status --short; git log --oneline -6
```

Expected: 工作树干净；本计划产生约 6–7 个 commit；**不 push**（等用户明确指示）

---

## Self-Review 结论

1. **Spec coverage**
   - §1 结构化档位解析 → Task 1、2 ✅
   - §2 候选链（过滤/预检/排序/同厂2席/取5）→ Task 5 Step 3(a) ✅
   - §3 会话粘性（指纹、TTL 5min、FIFO 1000、健康校验、failover 更新）→ Task 4、5、6(d) ✅；FIFO 上限由 `setSticky` 的 while 循环实现 ✅
   - §4 上下文预检（0.95、窗口未知不动、剔空放宽）→ Task 3、5 ✅
   - §5 可观测 `sticky`/`pool` → Task 6 ✅
   - 「不做的事」：未引入分类器/随机/持久化，speed/rate-limit 未动，模态池未动，无新配置项 ✅
   - 测试面：model-tier、score-model、registry 改写、server e2e 全覆盖 ✅
2. **Placeholder scan** — 无 TBD/TODO；Task 6 Step 1 与 Task 5 Step 1 各有一处「若现有 helper 形状不同则按现有写法调整、断言不变」，属环境适配而非空缺，已给出回退写法。
3. **Type consistency** — `resolveModel(modelId, opts?)` 返回 `{provider, modelId, sticky?}` 在 Task 5 定义、Task 6 消费一致；`onPick(info)` 的 `{sticky, pool}` 两侧字段名一致；`buildFallbackChain(inputTokens?: number)` 的调用方式已在 Task 5 Step 1 注明两种可能并给出等价写法。

---

## 执行期偏差记录（实现时对计划的必要修正）

计划在执行中被逐任务审查，以下偏离均为**计划自身的 bug 或已批准设计的必然结果**，非实现自由发挥：

1. **Task 1 · `air` 标记** — 计划的 SMALL 模式含 `/air/i`，与计划自带测试（`glm-4-air`→large）矛盾。经用户裁决：**从设计删除 air**（免费池无该模型）。同时 `/mini/i`、`/lite/i` 补词边界（修 `gemini` 含子串 `mini` 把 `gemini-2.5-pro` 判成 small 的真 bug）。
2. **Task 1 · qwen/llama 代际正则** — 计划漏了 `(?:\.\d+)?`，补上（`qwen2.5-7b`→2.5）；llama 分隔符补 `[-_]?` 对齐 qwen。
3. **Task 1 · 归一化与冻结** — `parseModelProfile` 入口加 `id.replace(/_/g,'-')`（`\b` 不跨下划线）；`TIER_SCORES` 加 `Object.freeze`。
4. **Task 3 · `tool_calls` 只计 `arguments`** — 计划实现伪代码计 `name`+`arguments`，但计划测试断言 `200` 只能由 `arguments` 单独得出；以测试为硬规格，只计 `arguments`（差 1 token 无影响）。
5. **Task 5 · B1 `skips cooling-down members` 用例改写** — 计划说「保留原样」，但该用例断言两次无 key 选型不同，是 round-robin 语义，已被本设计取代；改写为断言两次均为链首 `mid-14b`。
6. **Task 5 · B2 无 key 返回省略 `sticky`** — 计划测试断言无 key 时 `sticky === undefined`，计划实现却返回 `false`；以测试为准，无 key 分支返回 `{provider, modelId}`（不含 `sticky`）。
7. **Task 5 · B3 预检用例输入 `6000`→`8000`** — 计划算术错误：`6000 ≤ 8192×0.95` 时 `small-8k` 本不该被剔除；改 `8000` 才表达「窗口不足被剔除」。
8. **Task 5 · B4 全剔空回退按 contextWindow 降序** — 计划实现全剔空后仍按 score 排序，与设计 §2-1-d「放宽到 contextWindow 最大的前几个」冲突；实现新增 `relaxed` 主键按窗口降序，非 relaxed 路径不变。
9. **Task 5/6 · `rankCandidates` 排序统一** — 计划未涉及：发现初始主选按 `score→generation→id`、而失败切换 `rankCandidates` 按 `score→id`，两者不一致会让切换跳过候选。给 `rankCandidates` 也加 generation 次级键（与 `buildFallbackChain` 一致）。已同步设计 §2「链的作用域」说明：2 席/取 5 只约束初始链与 `pool`，失败切换走全池。
10. **Task 6 · round-robin 遗留测试更新** — `model-unavailable-failover.test.ts` 5 处 `seenModels()` 期望改为 generation 降序、1 处（`does not consume a pool pick`）重写为「错误记录不再尝试别的模型」；`auto-modality.test.ts` 的 `notEqual`（round-robin）改为 `equal`（粘性）并改名。均为 round-robin 语义被本设计取代的必然结果。
11. **Task 6 · 非 auto 请求不构造 `routeOpts`** — 计划的接线对每个请求都跑 `estimateInputTokens`/`sessionKeyOf`；改为仅 `auto`/`default` 时构造（`isAutoRequest`/`routeIsAuto` 门控），避免热路径白算。
12. **Task 6 · 模态重写请求不上报空 `pool`** — 计划无条件给 `fmf_auto_route` 加 `sticky`/`pool`，但模态重写（vision/image/text-tier）不改走 `pickAutoModel` → `pool` 恒为 `[]`，可观测失真。改为仅在文本池非空（`pool.length > 0`）时才附 `sticky`/`pool`，模态请求保持 `{picked, strategy}`。
13. **Task 6 · `auto-sticky` 第 4 用例修假绿** — 计划 fixture 里 `blind-8k`(50) 低于 `healthy`(50+5=55)，链首是 `healthy`，注入的 `context_length_exceeded` 永不触发（断言恒真）。改用 `gpt-5-blind`(flagship 95) 作链首，断言 `seenModels() === ['gpt-5-blind','healthy']` 真实覆盖 B1 兜底。
