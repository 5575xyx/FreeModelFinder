# P1-C3：Zen agent 形变、强制思考与 stale-reasoning 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@freemodelfinder/zen` 中落地三组纯函数：①把已编码的上游请求体改造成「agent 形」（强制 `stream:true` + 注入 5 个核心工具 + chat 补 `stream_options`），free 模型在 key 通道同样形变；②按配置强制思考强度（三协议）；③检测并剥离过期的 Responses `reasoning` 引用，供 P1-D 的重试编排调用。

**Architecture:** 全部落在 `packages/zen/src/protocol/`，输入/输出都是 `Record<string, unknown>` 的上游 body（由 P1-C1 的 `prepareRequest` 产出）。P1-D 的上游状态机负责调用它们；本阶段只提供纯函数 + 测试，不改 `gateway/`。

**Tech Stack:** TypeScript、Node.js 内置 test runner（`node --test` + `tsx`）。

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-zen-integration-design.md`（「路由与通道状态机」「错误处理」节）
**参考实现（磁盘上，逐字段对照）:** `E:\AImoney\opencode2api\opencode2api\internal\protocol\request.go`（`ForcedEffort`）与 `internal/gateway/upstream.go`（`prepareAnonymousBody`/`shapeKeyBody`/`isStaleReasoningReference`/`stripStaleReasoningInputs`）

---

## 执行约定

与 P1-C1/C2 相同：给出精确接口、测试用例、关键算法；逐字段映射对照磁盘 Go 源。

**范围外**：真正的重试编排（`doUpstreamTiers`/匿名与 key 池轮换）属 **P1-D**；`ForcedEffort` 的调用时机也由 P1-D 决定（本阶段只提供函数）。`SystemOne` 协议不在范围内。

## 文件结构（P1-C3）

| 文件                                  | 职责                                                      | 任务 |
| ------------------------------------- | --------------------------------------------------------- | ---- |
| `packages/zen/src/protocol/agent.ts`  | `prepareAnonymousBody` / `shapeKeyBody` / 核心工具注入    | F1   |
| `packages/zen/src/protocol/effort.ts` | `resolveEffort` / `applyForcedEffort`（三协议）           | F2   |
| `packages/zen/src/protocol/stale.ts`  | `isStaleReasoningReference` / `stripStaleReasoningInputs` | F3   |
| `packages/zen/src/index.ts`           | barrel 追加                                               | F4   |

---

### Task F1: agent 形变

**Files:**

- Create: `packages/zen/src/protocol/agent.ts`
- Test: `packages/zen/src/__tests__/protocol-agent.test.ts`（新建）

参考：`internal/gateway/upstream.go` 的 `prepareAnonymousBody` / `ensureAnonymousChatUsage` / `ensureAnonymousTools` / `anonymousCoreTools` / `anonymousToolset` / `anonymousTool` / `shapeKeyBody`。

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/protocol-agent.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CORE_AGENT_TOOLS, prepareAnonymousBody, shapeKeyBody } from '../protocol/agent.js';

describe('zen agent shaping', () => {
  it('forces stream and injects the core toolset for chat', () => {
    const body = prepareAnonymousBody(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      'chat',
    );
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    const tools = body.tools as Array<Record<string, unknown>>;
    const names = tools.map((t) => (t.function as Record<string, unknown>).name);
    assert.deepEqual(names, [...CORE_AGENT_TOOLS]);
  });

  it('does not duplicate tools the client already declared', () => {
    const body = prepareAnonymousBody(
      {
        model: 'm',
        messages: [],
        tools: [{ type: 'function', function: { name: 'bash', description: 'x', parameters: {} } }],
      },
      'chat',
    );
    const tools = body.tools as Array<Record<string, unknown>>;
    const bashCount = tools.filter(
      (t) => (t.function as Record<string, unknown>).name === 'bash',
    ).length;
    assert.equal(bashCount, 1);
    assert.equal(tools.length, CORE_AGENT_TOOLS.length);
  });

  it('uses anthropic tool shape for the anthropic protocol', () => {
    const body = prepareAnonymousBody({ model: 'm', messages: [] }, 'anthropic');
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.ok(tools.every((t) => typeof t.name === 'string' && 'input_schema' in t));
  });

  it('shapeKeyBody only shapes free models and reports whether it changed', () => {
    const free = { model: 'm', messages: [] };
    const shaped = shapeKeyBody(free, 'chat', true);
    assert.equal(shaped.changed, true);
    assert.equal((shaped.body as Record<string, unknown>).stream, true);

    const paid = { model: 'm', messages: [] };
    const untouched = shapeKeyBody(paid, 'chat', false);
    assert.equal(untouched.changed, false);
    assert.equal(untouched.body, paid);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

新建 `packages/zen/src/protocol/agent.ts`（对照 Go 逐字段实现）：

```ts
import type { ZenProtocol } from './types.js';

export const CORE_AGENT_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function anonymousTool(protocol: ZenProtocol, name: string): Record<string, unknown> {
  const description = `Agent tool ${name}`;
  const parameters = { type: 'object', properties: {} };
  if (protocol === 'anthropic') {
    return { name, description, input_schema: parameters };
  }
  return { type: 'function', function: { name, description, parameters } };
}

function toolName(protocol: ZenProtocol, item: unknown): string {
  const entry = asRecord(item);
  if (!entry) return '';
  if (protocol === 'chat') return String(asRecord(entry['function'])?.['name'] ?? '');
  return String(entry['name'] ?? '');
}

function ensureTools(payload: Record<string, unknown>, protocol: ZenProtocol): boolean {
  const raw = payload['tools'];
  if (raw === undefined) {
    payload['tools'] = CORE_AGENT_TOOLS.map((name) => anonymousTool(protocol, name));
    return true;
  }
  if (!Array.isArray(raw)) return false;
  const present = new Set(raw.map((item) => toolName(protocol, item)));
  const missing = CORE_AGENT_TOOLS.filter((name) => !present.has(name));
  if (missing.length === 0) return false;
  payload['tools'] = [...raw, ...missing.map((name) => anonymousTool(protocol, name))];
  return true;
}

function ensureChatUsage(payload: Record<string, unknown>, protocol: ZenProtocol): boolean {
  if (protocol !== 'chat') return false;
  const options = asRecord(payload['stream_options']);
  if (!options) {
    payload['stream_options'] = { include_usage: true };
    return true;
  }
  if (options['include_usage'] === true) return false;
  options['include_usage'] = true;
  return true;
}

export function prepareAnonymousBody(
  body: Record<string, unknown>,
  protocol: ZenProtocol,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...body };
  let changed = false;
  if (payload['stream'] !== true) {
    payload['stream'] = true;
    changed = true;
  }
  if (ensureChatUsage(payload, protocol)) changed = true;
  if (ensureTools(payload, protocol)) changed = true;
  return changed ? payload : body;
}

export function shapeKeyBody(
  body: Record<string, unknown>,
  protocol: ZenProtocol,
  isFree: boolean,
): { body: Record<string, unknown>; changed: boolean } {
  if (!isFree) return { body, changed: false };
  const shaped = prepareAnonymousBody(body, protocol);
  return { body: shaped, changed: shaped !== body };
}
```

> Go 的 `prepareAnonymousBody` 对 `systemone` 直接返回；zen 无该协议，故省略。`toolName` 对 responses 协议也是扁平 `name`（Go 的 responses tools 是扁平形）。请对照 Go 确认 responses 工具名的读取方式。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/agent.ts packages/zen/src/__tests__/protocol-agent.test.ts
git commit -m "feat(zen): agent 形变与核心工具注入"
```

---

### Task F2: 强制思考强度（`ForcedEffort`）

**Files:**

- Create: `packages/zen/src/protocol/effort.ts`
- Test: `packages/zen/src/__tests__/protocol-effort.test.ts`（新建）

参考：`internal/protocol/request.go` 的 `ForcedEffort` / `clientEffortExplicit` / `applyAnthropicForcedEffort` / `validForcedEffort`。

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/protocol-effort.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyForcedEffort, resolveEffort } from '../protocol/effort.js';

describe('zen forced effort', () => {
  it('applies effort to a chat body when the client did not set one', () => {
    const body: Record<string, unknown> = { model: 'm', messages: [] };
    applyForcedEffort(body, 'chat', 'high');
    assert.equal(body.reasoning_effort, 'high');
  });

  it('lets an explicit client effort win', () => {
    const body: Record<string, unknown> = { model: 'm', messages: [], reasoning_effort: 'low' };
    applyForcedEffort(body, 'chat', 'high');
    assert.equal(body.reasoning_effort, 'low');
  });

  it('applies effort to a responses body', () => {
    const body: Record<string, unknown> = { model: 'm', input: [] };
    applyForcedEffort(body, 'responses', 'medium');
    assert.deepEqual(body.reasoning, { effort: 'medium' });
  });

  it('none removes the effort', () => {
    const body: Record<string, unknown> = { model: 'm', messages: [], reasoning_effort: 'high' };
    applyForcedEffort(body, 'chat', 'none');
    assert.equal('reasoning_effort' in body, false);
  });

  it('resolveEffort prefers the per-model override', () => {
    assert.equal(resolveEffort('m', 'low', { m: 'max' }), 'max');
    assert.equal(resolveEffort('other', 'low', { m: 'max' }), 'low');
    assert.equal(resolveEffort('other', undefined, {}), undefined);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

新建 `packages/zen/src/protocol/effort.ts`。要求：

- `resolveEffort(model, defaultEffort, effortByModel)`：per-model 覆盖优先；
- `applyForcedEffort(body, protocol, effort)`：客户端显式设置的强度优先（不覆盖）；`none` 移除思考配置；`chat` → `reasoning_effort`；`responses` → `reasoning.effort`；`anthropic` → 对照 Go 的 `applyAnthropicForcedEffort`（`output_config.effort` 与/或 `thinking.budget_tokens` 的档位映射）。

> anthropic 的映射较复杂（`output_config.effort` 与 `thinking.budget_tokens` 双向），**必须对照 Go 源逐行移植**并在报告中列出对照行号。`clientEffortExplicit` 的三协议判定也要对照 Go。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/effort.ts packages/zen/src/__tests__/protocol-effort.test.ts
git commit -m "feat(zen): 强制思考强度（三协议）"
```

---

### Task F3: stale reasoning 检测与剥离

**Files:**

- Create: `packages/zen/src/protocol/stale.ts`
- Test: `packages/zen/src/__tests__/protocol-stale.test.ts`（新建）

参考：`internal/gateway/upstream.go` 的 `isStaleReasoningReference` / `stripStaleReasoningInputs`。

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/protocol-stale.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isStaleReasoningReference, stripStaleReasoningInputs } from '../protocol/stale.js';

describe('zen stale reasoning', () => {
  it('detects a stale reasoning reference error', () => {
    assert.equal(
      isStaleReasoningReference(
        JSON.stringify({
          error: { message: "Referenced reasoning item 'rs_1' was not found or has expired" },
        }),
      ),
      true,
    );
  });

  it('does not treat an unrelated reasoning validation error as stale', () => {
    assert.equal(
      isStaleReasoningReference(JSON.stringify({ error: { message: 'unknown reasoning field' } })),
      false,
    );
    assert.equal(isStaleReasoningReference('plain text'), false);
  });

  it('strips previous_response_id and reasoning input items', () => {
    const { body, changed } = stripStaleReasoningInputs({
      model: 'm',
      previous_response_id: 'resp_1',
      input: [
        { type: 'reasoning', id: 'rs_1' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    assert.equal(changed, true);
    assert.equal('previous_response_id' in body, false);
    assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: 'hi' }]);
  });

  it('reports no change when there is nothing to strip', () => {
    const { changed } = stripStaleReasoningInputs({ model: 'm', input: [{ type: 'message' }] });
    assert.equal(changed, false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

新建 `packages/zen/src/protocol/stale.ts`（对照 Go 逐行实现）：

- `isStaleReasoningReference(bodyText)`：小写后须同时包含 `reasoning item`/`reasoning reference` 之一，且包含 `not found`/`expir`/`does not exist`/`no longer` 之一；否则 false；
- `stripStaleReasoningInputs(body): { body, changed }`：删除 `previous_response_id`；从 `input` 数组过滤 `type:'reasoning'` 项；返回是否变化（不变则返回原对象）。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/protocol/stale.ts packages/zen/src/__tests__/protocol-stale.test.ts
git commit -m "feat(zen): stale reasoning 检测与剥离"
```

---

### Task F4: barrel 与整合验证

**Files:**

- Modify: `packages/zen/src/index.ts`
- Test: 无新增（跑全量）

- [ ] **Step 1: 更新 barrel**

`packages/zen/src/index.ts` 追加：

```ts
export * from './protocol/agent.js';
export * from './protocol/effort.js';
export * from './protocol/stale.js';
```

若出现同名符号歧义（例如 `asRecord` 等内部函数未导出则不冲突），改为显式具名导出并报告。

- [ ] **Step 2: 全量验证**

Run: `pnpm --filter @freemodelfinder/zen test && pnpm --filter @freemodelfinder/zen typecheck && pnpm --filter @freemodelfinder/zen build`
Expected: 全部通过。

- [ ] **Step 3: 提交**

```bash
git add packages/zen/src/index.ts
git commit -m "feat(zen): P1-C3 模块导出"
```

---

## 验收清单（P1-C3）

- [ ] `pnpm --filter @freemodelfinder/zen test` 全绿
- [ ] `pnpm build:runtime`、`pnpm typecheck`、`pnpm lint` 通过
- [ ] 仅本计划列出的文件被提交

## 后续

- **P1-D**：key/匿名/代理池 + 上游状态机（调用本阶段的 `prepareAnonymousBody`/`shapeKeyBody`/`applyForcedEffort`/`stripStaleReasoningInputs`）+ 刷新编排（承接 P1-B 登记的延后清单）。
- **P1-E**：core provider / UI / CLI / Docker / `verify-release` 接入；消费 `raw`/`rawProtocol`。

## 自查记录

1. **Spec 覆盖**：spec「路由与通道状态机」的匿名 body 形变（F1）、「强制思考强度」（F2）、「错误处理」的 stale reasoning 重放（F3，重试编排属 P1-D）。
2. **占位符扫描**：F2 anthropic 分支与 `clientEffortExplicit` 以磁盘 Go 源为权威（已显式说明）；F1/F3 给出完整代码。
3. **类型一致性**：三个模块的输入/输出均为 `Record<string, unknown>`（P1-C1 `prepareRequest` 的产物），不引入新类型；`ZenProtocol` 复用 `protocol/types.ts`。
