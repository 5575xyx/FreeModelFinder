# 模型别名（Model Aliases）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许为模型配置对外别名（如 `my-model`），外部调用方只见别名，网关内部路由到真实 id；`/v1/models` 用别名替换原始 id，响应统一回显别名，原始 id 继续可用。

**Architecture:** 别名表存于 `AppConfig.modelAliases`（`Record<别名, 真实id>`）。`ProviderRegistry` 新增 `resolveAlias()`（正向查表）、`toClientFacingModel()`（反向查表），并在 `resolveModel()` 顶部递归解析别名——一处挂点覆盖三协议 + 图片/视频/探活 + CLI。路由层在 `preflight` 之前把 `chatReq.model` 归一化为真实 id，使冷却表按真实 id 精确匹配。

**Tech Stack:** TypeScript（Node 22 / Fastify / React 19 / Next.js 16）、Node 内置测试运行器（core/server）、Vitest + msw + Testing Library（ui）。

---

## 关键设计决策（实现前必读）

1. **别名的目标值 = 复合 id**（如 `opencode:mimo-v2.6-flash-free`），与响应中的 `finalModel` 形态一致。设置页下拉框数据源用 `/api/auto-route/model-options`（已返回复合 id）。
2. **`toClientFacingModel` 按「去前缀裸名」匹配**。因为 `/v1/models` 的 `m.id` 对 openrouter 是裸名、对 zen 是复合名，而 `finalModel` 一律是复合名。只按裸名比较才能同时覆盖两种形态。实现为私有辅助函数 `stripProviderPrefix()`。
3. **UI 永远发真实 id，不发别名**。`/v1/models` 返回 `id: 别名` + `alias_of: 真实id`；UI 的 `modelValue()` 用 `alias_of ?? id` 拼请求值，只在 `<option>` 标签上显示别名。这样 UI 请求路径完全不受别名影响，别名纯粹是对外 + 显示。
4. **别名不得含 `:`**，否则会与 gemini 路由的 `lastIndexOf(':')` 拆分、`provider:model` 前缀解析冲突。校验时拒绝。
5. **冷却/配额统计仍按真实 id**，因为 `chatReq.model` 在 `preflight` 之前已归一化，`resolveModel` 返回的也是真实 id。

---

## File Structure

| 文件                                                                     | 职责                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `packages/core/src/types.ts`                                             | `AppConfig.modelAliases?: Record<string,string>` 类型声明                  |
| `packages/core/src/config/aliases.ts` **(新建)**                         | `validateModelAliases()` 别名表校验（纯函数，可单测）                      |
| `packages/core/src/index.ts`                                             | 导出 `validateModelAliases` / `AliasValidationResult`                      |
| `packages/core/src/registry.ts`                                          | `resolveAlias()` / `toClientFacingModel()` / `resolveModel()` 顶部别名钩子 |
| `packages/core/src/registry/__tests__/registry.test.ts`                  | 别名解析与反查测试                                                         |
| `packages/core/src/config/__tests__/aliases.test.ts` **(新建)**          | 校验函数测试                                                               |
| `packages/server/src/routes/openai.ts`                                   | 路由归一化 + `/v1/models` 别名替换 + 响应回显                              |
| `packages/server/src/routes/anthropic.ts`                                | 路由归一化 + 响应回显                                                      |
| `packages/server/src/routes/gemini.ts`                                   | 路由归一化（Gemini 响应无 model 字段，无需回显）                           |
| `packages/server/src/server.ts`                                          | `GET/POST /api/model-aliases` 端点                                         |
| `packages/server/src/__tests__/model-aliases.test.ts` **(新建)**         | 端到端：列表替换 + 三协议路由 + 回显 + 端点                                |
| `packages/ui/app/lib/models.ts`                                          | `ModelItem.alias_of` + `modelValue()` 用真实 id                            |
| `packages/ui/app/components/TesterView.tsx`                              | `<option>` 标签显示「别名 (真实id)」                                       |
| `packages/ui/app/components/ModelAliasesSection.tsx` **(新建)**          | 设置页别名编辑区                                                           |
| `packages/ui/app/components/SettingsView.tsx`                            | 挂载 `ModelAliasesSection`                                                 |
| `packages/ui/app/i18n.tsx`                                               | zh/en 双字典新增 11 个键                                                   |
| `packages/ui/app/components/__tests__/model-aliases.test.tsx` **(新建)** | UI 渲染 + 保存                                                             |
| `packages/ui/app/lib/__tests__/models.test.ts` **(新建)**                | `modelValue()` 用 `alias_of`                                               |
| `packages/ui/test/server.ts`                                             | 新增 `/api/model-aliases` 默认 msw handler                                 |

---

## Task 1: 核心类型 + 校验函数

**Files:**

- Modify: `packages/core/src/types.ts:363-372`（`AppConfig` 加字段）
- Create: `packages/core/src/config/aliases.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/config/__tests__/aliases.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/config/__tests__/aliases.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateModelAliases } from '../aliases.js';

describe('validateModelAliases', () => {
  const known = new Set(['openrouter:gpt-4o-mini']);

  it('accepts a well-formed map and trims both sides', () => {
    const res = validateModelAliases({ ' my-model ': ' openrouter:gpt-4o-mini ' }, known);
    assert.equal(res.ok, true);
    assert.deepEqual(res.aliases, { 'my-model': 'openrouter:gpt-4o-mini' });
  });

  it('accepts an empty map', () => {
    const res = validateModelAliases({}, known);
    assert.equal(res.ok, true);
    assert.deepEqual(res.aliases, {});
  });

  it('rejects a non-object payload', () => {
    assert.equal(validateModelAliases(null, known).ok, false);
    assert.equal(validateModelAliases(['a'], known).ok, false);
    assert.equal(validateModelAliases('a', known).ok, false);
  });

  it('rejects an empty alias name', () => {
    const res = validateModelAliases({ '   ': 'openrouter:gpt-4o-mini' }, known);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /empty/i);
  });

  it('rejects an alias containing a colon', () => {
    const res = validateModelAliases({ 'my:model': 'openrouter:gpt-4o-mini' }, known);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /:/);
  });

  it('rejects the reserved names auto and default', () => {
    assert.equal(validateModelAliases({ auto: 'openrouter:gpt-4o-mini' }, known).ok, false);
    assert.equal(validateModelAliases({ default: 'openrouter:gpt-4o-mini' }, known).ok, false);
  });

  it('rejects an alias that collides with a known model id', () => {
    const res = validateModelAliases({ 'openrouter:gpt-4o-mini': 'openrouter:gpt-4o-mini' }, known);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /conflict/i);
  });

  it('rejects a missing or blank target', () => {
    assert.equal(validateModelAliases({ 'my-model': '' }, known).ok, false);
    assert.equal(validateModelAliases({ 'my-model': '   ' }, known).ok, false);
    assert.equal(validateModelAliases({ 'my-model': 42 }, known).ok, false);
  });

  it('allows a target that is not in the catalog today', () => {
    const res = validateModelAliases({ 'my-model': 'opencode:not-yet-listed' }, known);
    assert.equal(res.ok, true);
    assert.deepEqual(res.aliases, { 'my-model': 'opencode:not-yet-listed' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --test --experimental-strip-types src/config/__tests__/aliases.test.ts`

Expected: FAIL —— `Cannot find module '../aliases.js'`

- [ ] **Step 3: 给 AppConfig 加字段**

在 `packages/core/src/types.ts` 的 `AppConfig`（363-372 行）中，`credentials?` 之后新增一行：

```ts
export interface AppConfig {
  version: number;
  port: number;
  defaultModel?: string;
  providers: Partial<Record<ProviderId, ProviderSettings>>;
  gateway?: GatewaySettings;
  autoRoute?: AutoRouteSettings;
  onboarding?: OnboardingState;
  credentials?: Partial<Record<CredentialPlatform, CredentialPoolConfig>>;
  /** External alias -> real model id (composed form, e.g. "opencode:mimo-v2.6-flash-free"). */
  modelAliases?: Record<string, string>;
}
```

- [ ] **Step 4: 新建校验函数**

创建 `packages/core/src/config/aliases.ts`：

```ts
export interface AliasValidationResult {
  ok: boolean;
  error?: string;
  aliases?: Record<string, string>;
}

/**
 * Validate a model-alias map before persisting it. Alias names are external
 * identifiers, so they must stay free of ':' (which the gemini route splits on
 * and the "provider:model" prefix parser consumes), must not shadow the
 * reserved routing keywords, and must not collide with a real model id.
 *
 * Targets are deliberately NOT required to exist in the catalog: the model
 * list refreshes continuously, so an alias may be configured before its
 * target appears. A missing target surfaces as a normal resolve error.
 */
export function validateModelAliases(input: unknown, knownIds: Set<string>): AliasValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'modelAliases must be an object' };
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const alias = rawKey.trim();
    if (!alias) return { ok: false, error: 'alias name must not be empty' };
    if (alias.includes(':')) {
      return { ok: false, error: `alias "${alias}" must not contain ":"` };
    }
    if (alias === 'auto' || alias === 'default') {
      return { ok: false, error: `alias "${alias}" is a reserved routing keyword` };
    }
    if (knownIds.has(alias)) {
      return { ok: false, error: `alias "${alias}" conflicts with an existing model id` };
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      return { ok: false, error: `alias "${alias}" must point to a model id` };
    }
    out[alias] = rawValue.trim();
  }
  return { ok: true, aliases: out };
}
```

- [ ] **Step 5: 从 core index 导出**

在 `packages/core/src/index.ts` 的 `export { asModelList } from './config/model-list.js';`（第 5 行）之后新增：

```ts
export { validateModelAliases, type AliasValidationResult } from './config/aliases.js';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/core exec node --test --experimental-strip-types src/config/__tests__/aliases.test.ts`

Expected: PASS —— 9 个子测试全绿

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/config/aliases.ts packages/core/src/index.ts packages/core/src/config/__tests__/aliases.test.ts
git commit -m "feat(core): 模型别名配置类型与校验函数"
```

---

## Task 2: Registry 别名解析与反查

**Files:**

- Modify: `packages/core/src/registry.ts`
- Test: `packages/core/src/registry/__tests__/registry.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/registry/__tests__/registry.test.ts` 的 `configWithProviders` 辅助函数（11-17 行）之后，新增一个别名专用构造函数：

```ts
function configWithAliases(aliases: Record<string, string>): AppConfig {
  const config = configWithProviders({
    openrouter: { enabled: true, credentials: { apiKey: 'k' } },
  });
  config.modelAliases = aliases;
  return config;
}
```

然后在该文件末尾追加测试：

```ts
describe('ProviderRegistry model aliases', () => {
  it('resolves an alias to its real provider and bare model id', () => {
    const registry = new ProviderRegistry(
      configWithAliases({ 'my-model': 'openrouter:gpt-4o-mini' }),
    );
    const resolved = registry.resolveModel('my-model');
    assert.equal(resolved.provider.id, 'openrouter');
    assert.equal(resolved.modelId, 'gpt-4o-mini');
  });

  it('resolves an alias whose target is a bare id through the openrouter fallback', () => {
    const registry = new ProviderRegistry(configWithAliases({ 'my-model': 'gpt-4o-mini' }));
    const resolved = registry.resolveModel('my-model');
    assert.equal(resolved.provider.id, 'openrouter');
    assert.equal(resolved.modelId, 'gpt-4o-mini');
  });

  it('keeps the original id working when an alias also points at it', () => {
    const registry = new ProviderRegistry(
      configWithAliases({ 'my-model': 'openrouter:gpt-4o-mini' }),
    );
    const resolved = registry.resolveModel('openrouter:gpt-4o-mini');
    assert.equal(resolved.provider.id, 'openrouter');
    assert.equal(resolved.modelId, 'gpt-4o-mini');
  });

  it('resolveAlias returns the target, or the input when there is no alias', () => {
    const registry = new ProviderRegistry(
      configWithAliases({ 'my-model': 'openrouter:gpt-4o-mini' }),
    );
    assert.equal(registry.resolveAlias('my-model'), 'openrouter:gpt-4o-mini');
    assert.equal(registry.resolveAlias('openrouter:gpt-4o-mini'), 'openrouter:gpt-4o-mini');
    assert.equal(registry.resolveAlias('unknown'), 'unknown');
  });

  it('toClientFacingModel maps a composed id back to its alias', () => {
    const registry = new ProviderRegistry(
      configWithAliases({ 'my-model': 'openrouter:gpt-4o-mini' }),
    );
    assert.equal(registry.toClientFacingModel('openrouter:gpt-4o-mini'), 'my-model');
  });

  it('toClientFacingModel matches a bare catalog id against a composed alias target', () => {
    const registry = new ProviderRegistry(configWithAliases({ 'my-model': 'gpt-4o-mini' }));
    assert.equal(registry.toClientFacingModel('openrouter:gpt-4o-mini'), 'my-model');
    assert.equal(registry.toClientFacingModel('gpt-4o-mini'), 'my-model');
  });

  it('toClientFacingModel returns the input untouched when no alias points at it', () => {
    const registry = new ProviderRegistry(
      configWithAliases({ 'my-model': 'openrouter:gpt-4o-mini' }),
    );
    assert.equal(registry.toClientFacingModel('openrouter:other-model'), 'openrouter:other-model');
    assert.equal(registry.toClientFacingModel('gpt-4o-mini'), 'gpt-4o-mini');
  });

  it('does not resolve auto or default through an alias named that way', () => {
    const registry = new ProviderRegistry(configWithAliases({}));
    assert.throws(() => registry.resolveModel('auto'), /no provider is configured/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/core exec node --test --experimental-strip-types src/registry/__tests__/registry.test.ts`

Expected: FAIL —— `registry.resolveAlias is not a function`

- [ ] **Step 3: 实现 registry 方法**

在 `packages/core/src/registry.ts` 的 `getAutoRouter()` 方法（137-139 行）之后、`drainNotices()` 之前，新增：

```ts
  /**
   * Forward alias lookup: external name -> real model id. Returns the input
   * untouched when no alias matches. Route handlers call this BEFORE preflight
   * so cooldown tables stay keyed by the real model id.
   */
  resolveAlias(modelId: string): string {
    return this.config.modelAliases?.[modelId] ?? modelId;
  }

  /**
   * Reverse lookup used for the client-facing name in /v1/models and in
   * response payloads. Matching is done on the provider-stripped id because
   * the catalog stores bare ids for OpenAI-compatible providers but composed
   * ids for OpenCode/Cline, while response payloads are always composed.
   */
  toClientFacingModel(realId: string): string {
    const aliases = this.config.modelAliases;
    if (!aliases) return realId;
    const bare = stripProviderPrefix(realId);
    for (const [alias, target] of Object.entries(aliases)) {
      if (stripProviderPrefix(target) === bare) return alias;
    }
    return realId;
  }
```

- [ ] **Step 4: 加模块级辅助函数**

在 `packages/core/src/registry.ts` 的 `export interface RegistryOptions`（77-79 行）之前新增：

```ts
/** Drop a leading "provider:" segment so composed and bare ids compare equal. */
function stripProviderPrefix(id: string): string {
  const sep = id.indexOf(':');
  return sep > 0 ? id.slice(sep + 1) : id;
}
```

- [ ] **Step 5: 在 resolveModel 顶部挂钩别名递归**

在 `packages/core/src/registry.ts` 的 `resolveModel` 方法体开头，紧接 `): { provider: BaseProvider; modelId: string; sticky?: boolean } {` 之后、`if (modelId === 'auto' || modelId === 'default') {` 之前，插入：

```ts
const aliased = this.config.modelAliases?.[modelId];
if (aliased && aliased !== modelId) {
  return this.resolveModel(aliased, opts);
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/core exec node --test --experimental-strip-types src/registry/__tests__/registry.test.ts`

Expected: PASS

- [ ] **Step 7: 跑全量 core 测试确保无回归**

Run: `pnpm --filter @freemodelfinder/core test`

Expected: 全部 pass，fail 0

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/registry.ts packages/core/src/registry/__tests__/registry.test.ts
git commit -m "feat(core): registry 解析别名并反查对外名称"
```

---

## Task 3: /v1/models 别名替换

**Files:**

- Modify: `packages/server/src/routes/openai.ts:479-492`

- [ ] **Step 1: 写失败测试**

创建 `packages/server/src/__tests__/model-aliases.test.ts`（本任务只写 `/v1/models` 部分，后续任务继续追加）：

```ts
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig, type ChatResponse } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const CHAT_REPLY: ChatResponse = {
  id: 'alias-reply',
  model: 'plain',
  created: 1_700_000_000,
  content: 'ok',
  finish_reason: 'stop',
};

function baseConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {
      custom: {
        enabled: true,
        credentials: {
          apiKey: '',
          extra: {
            sources: [
              {
                id: 'fx',
                label: 'FX',
                baseUrl: 'https://fx.invalid/v1',
                apiKey: 'k',
                models: [
                  { id: 'plain', displayName: 'Plain' },
                  { id: 'fast', displayName: 'Fast' },
                ],
              },
            ],
          },
        },
      },
    },
    gateway: { requireAuth: false },
    autoRoute: { enabled: false, strategy: 'capability' },
  };
}

async function appWith(config: AppConfig): Promise<FastifyInstance> {
  const registry = new ProviderRegistry(config);
  registry.listAllModels = async () => ({
    models: [
      { id: 'custom:fx:plain', provider: 'custom', displayName: 'Plain', free: true },
      { id: 'custom:fx:fast', provider: 'custom', displayName: 'Fast', free: true },
    ],
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  registry.resolveModel = (model) => {
    const bare = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
    const id = bare.split(':').pop() ?? bare;
    return {
      provider: {
        id: 'custom',
        chat: async () => ({ ...CHAT_REPLY, model: id }),
        stream: async function* () {
          yield { id: 'alias-stream', model: id, created: 1, delta: 'ok', finish_reason: 'stop' };
        },
      } as never,
      modelId: id,
    };
  };
  const { app } = await createServer({ registry, watchIntervalMs: 60 * 60 * 1000 });
  apps.push(app);
  return app;
}

describe('/v1/models alias replacement', () => {
  it('replaces an aliased model id with the alias and adds alias_of', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };

    const aliased = body.data.find((m) => m.id === 'my-model');
    assert.ok(aliased, 'alias must appear in the list');
    assert.equal(aliased.alias_of, 'custom:fx:fast');
    assert.equal(
      body.data.some((m) => m.id === 'custom:fx:fast'),
      false,
      'the original id must be replaced, not duplicated',
    );
  });

  it('leaves a model without an alias untouched and without alias_of', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    const plain = body.data.find((m) => m.id === 'custom:fx:plain');
    assert.ok(plain);
    assert.equal(plain.alias_of, undefined);
  });

  it('returns real ids unchanged when no alias is configured', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = res.json() as { data: Array<{ id: string; alias_of?: string }> };
    assert.deepEqual(body.data.map((m) => m.id).sort(), ['custom:fx:fast', 'custom:fx:plain']);
    assert.equal(
      body.data.every((m) => m.alias_of === undefined),
      true,
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/server exec node --test --experimental-strip-types src/__tests__/model-aliases.test.ts`

Expected: FAIL —— 第一个用例报 `aliased` 为 undefined

- [ ] **Step 3: 实现 /v1/models 别名替换**

在 `packages/server/src/routes/openai.ts` 的 `/v1/models` 路由中，把 479-492 行的 `data: models.map((m) => ({ ... }))` 整块替换为：

```ts
      data: models.map((m) => {
        const clientFacingId = reg.toClientFacingModel(m.id);
        const aliased = clientFacingId !== m.id;
        return {
          id: clientFacingId,
          ...(aliased ? { alias_of: m.id } : {}),
          object: 'model',
          owned_by: m.provider,
          created: Math.floor(Date.now() / 1000),
          display_name: m.displayName,
          context_window: m.contextWindow,
          provider: m.provider,
          free: m.free,
          description: m.description,
          capabilities: m.capabilities,
          capability_score: scoreModel(m, 'capability', router.getProfile(m.id)),
          quota: reg.getModelQuota(m.provider, m.id),
        };
      }),
```

注意：`capability_score` 与 `quota` 仍用真实 `m.id` 计算，只有对外的 `id` 字段被替换。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/server exec node --test --experimental-strip-types src/__tests__/model-aliases.test.ts`

Expected: PASS —— 3 个子测试全绿

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/openai.ts packages/server/src/__tests__/model-aliases.test.ts
git commit -m "feat(server): /v1/models 用别名替换模型 id 并附带 alias_of"
```

---

## Task 4: 三协议路由归一化 + 响应回显别名

**Files:**

- Modify: `packages/server/src/routes/openai.ts`
- Modify: `packages/server/src/routes/anthropic.ts`
- Modify: `packages/server/src/routes/gemini.ts`
- Test: `packages/server/src/__tests__/model-aliases.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/__tests__/model-aliases.test.ts` 末尾追加：

```ts
describe('alias routing and response echo', () => {
  it('routes an aliased model id to the real provider in all three protocols', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    for (const request of [
      {
        url: '/v1/chat/completions',
        payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }] },
      },
      {
        url: '/v1/messages',
        payload: { model: 'my-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      },
      {
        url: '/v1beta/models/my-model:generateContent',
        payload: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      },
    ]) {
      const res = await app.inject({ method: 'POST', ...request });
      assert.equal(res.statusCode, 200, `${request.url} should succeed`);
      assert.match(res.body, /ok/);
    }
  });

  it('echoes the alias as the response model for OpenAI non-streaming', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    const body = res.json() as { model: string };
    assert.equal(body.model, 'my-model');
  });

  it('echoes the alias as the response model for OpenAI streaming chunks', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"model":"my-model"/);
  });

  it('echoes the alias as the response model for Anthropic non-streaming', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'my-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    });
    const body = res.json() as { model: string };
    assert.equal(body.model, 'my-model');
  });

  it('echoes the alias in the Anthropic message_start frame', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'my-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"model":"my-model"/);
  });

  it('keeps echoing the composed real id when the request used the original id', async () => {
    const config = baseConfig();
    config.modelAliases = { 'my-model': 'custom:fx:fast' };
    const app = await appWith(config);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'custom:fx:fast', messages: [{ role: 'user', content: 'hi' }] },
    });
    const body = res.json() as { model: string };
    assert.equal(body.model, 'my-model');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/server exec node --test --experimental-strip-types src/__tests__/model-aliases.test.ts`

Expected: FAIL —— 回显类用例返回 `custom:fx:fast` 而非 `my-model`

- [ ] **Step 3: openai.ts 路由入口归一化**

在 `packages/server/src/routes/openai.ts` 的 chat 路由中，`const requestedModel = String(body.model);`（540 行）之后立刻插入：

```ts
// Resolve an external alias to its real id BEFORE preflight so cooldown
// lookups and markRateLimited stay keyed by the real model.
chatReq.model = reg.resolveAlias(chatReq.model);
```

- [ ] **Step 4: openai.ts 非流式回显**

把 794 行的 `payload.model = finalModel;` 替换为：

```ts
payload.model = reg.toClientFacingModel(finalModel);
```

- [ ] **Step 5: openai.ts 流式回显**

在 `packages/server/src/routes/openai.ts` 的流式循环中，`const payload = streamChunkToOpenAI(chunk);`（937 行）之后、`if (body.model === 'auto') {` 之前插入：

```ts
// Echo the alias (when one is configured) instead of the
// upstream's bare model id, without touching the
// non-aliased path that clients already rely on.
const chunkComposed = `${provider.id}:${realModelId}`;
const chunkClientFacing = reg.toClientFacingModel(chunkComposed);
if (chunkClientFacing !== chunkComposed) {
  (payload as Record<string, unknown>).model = chunkClientFacing;
}
```

- [ ] **Step 6: anthropic.ts 归一化 + 回显**

在 `packages/server/src/routes/anthropic.ts` 中：

（a）`const chatReq = anthropicToChatRequest(body);`（88 行）之后插入：

```ts
// Resolve an external alias before preflight keeps cooldowns keyed by
// the real model id.
chatReq.model = reg.resolveAlias(chatReq.model);
```

（b）94 行的 `payload.model = finalModel;` 替换为：

```ts
payload.model = reg.toClientFacingModel(finalModel);
```

（c）125-136 行的 `message_start` 帧中，`model: `${provider.id}:${modelId}`,` 替换为：

```ts
          model: reg.toClientFacingModel(`${provider.id}:${modelId}`),
```

- [ ] **Step 7: gemini.ts 归一化（两处）**

在 `packages/server/src/routes/gemini.ts` 中：

（a）`handleGenerate` 内，`const chatReq = geminiToChatRequest(model, req.body, false);`（36 行）之后插入：

```ts
chatReq.model = reg.resolveAlias(chatReq.model);
```

（b）`handleStream` 内，`const chatReq = geminiToChatRequest(model, req.body, true);`（102 行）之后插入同样的单行。

Gemini 响应体不含 `model` 字段，故无需回显改动。

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/server exec node --test --experimental-strip-types src/__tests__/model-aliases.test.ts`

Expected: PASS —— 9 个子测试全绿

- [ ] **Step 9: 跑全量 server 测试确保无回归**

Run: `pnpm --filter @freemodelfinder/server test`

Expected: 全部 pass，fail 0

- [ ] **Step 10: 提交**

```bash
git add packages/server/src/routes/openai.ts packages/server/src/routes/anthropic.ts packages/server/src/routes/gemini.ts packages/server/src/__tests__/model-aliases.test.ts
git commit -m "feat(server): 三协议按别名路由并回显别名"
```

---

## Task 5: 管理端点 GET/POST /api/model-aliases

**Files:**

- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/__tests__/model-aliases.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/__tests__/model-aliases.test.ts` 末尾追加：

```ts
describe('/api/model-aliases', () => {
  it('returns an empty map when nothing is configured', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({ method: 'GET', url: '/api/model-aliases' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { modelAliases: {} });
  });

  it('persists a valid alias map', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      payload: { modelAliases: { 'my-model': 'custom:fx:fast' } },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, modelAliases: { 'my-model': 'custom:fx:fast' } });

    const get = await app.inject({ method: 'GET', url: '/api/model-aliases' });
    assert.deepEqual(get.json(), { modelAliases: { 'my-model': 'custom:fx:fast' } });
  });

  it('replaces the whole map so an omitted alias is deleted', async () => {
    const config = baseConfig();
    config.modelAliases = { 'old-alias': 'custom:fx:fast' };
    const app = await appWith(config);

    await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      payload: { modelAliases: { 'new-alias': 'custom:fx:plain' } },
    });
    const get = await app.inject({ method: 'GET', url: '/api/model-aliases' });
    assert.deepEqual(get.json(), { modelAliases: { 'new-alias': 'custom:fx:plain' } });
  });

  it('rejects an alias containing a colon', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      payload: { modelAliases: { 'my:model': 'custom:fx:fast' } },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { error: string }).error, /:/);
  });

  it('rejects the reserved alias name auto', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      payload: { modelAliases: { auto: 'custom:fx:fast' } },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects an alias that collides with a real model id', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      payload: { modelAliases: { 'custom:fx:fast': 'custom:fx:plain' } },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects a non-object payload', async () => {
    const app = await appWith(baseConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-aliases',
      payload: { modelAliases: ['nope'] },
    });
    assert.equal(res.statusCode, 400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/server exec node --test --experimental-strip-types src/__tests__/model-aliases.test.ts`

Expected: FAIL —— `404`，端点尚未注册

- [ ] **Step 3: 补 import**

在 `packages/server/src/server.ts` 的 `@freemodelfinder/core` import 块中，`asModelList,`（第 11 行）之后加入 `bareModelId,`，并在 `validateModelAliases,` 之后加入。修改后该块的相关部分为：

```ts
import {
  CallLogger,
  ClineLoginAdapter,
  DeviceAuthManager,
  ProviderIdSchema,
  ProviderRegistry,
  asModelList,
  bareModelId,
  composeModelId,
  getCredentialRuntime,
  isVisionCapable,
  loadConfig,
  redact,
  updateConfig,
  validateModelAliases,
  type CredentialAccountEntry,
  type GatewayKeyEntry,
} from '@freemodelfinder/core';
```

- [ ] **Step 4: 注册端点**

在 `packages/server/src/server.ts` 中，`POST /api/auto-route/clear-cooldown` 端点（1579-1588 行）之后新增：

```ts
app.get('/api/model-aliases', async () => {
  return { modelAliases: getRegistry().getConfig().modelAliases ?? {} };
});

app.post<{ Body: { modelAliases?: unknown } }>('/api/model-aliases', async (req, reply) => {
  const reg = getRegistry();
  const { models } = await reg.listAllModels();
  const knownIds = new Set<string>();
  for (const m of models) {
    knownIds.add(m.id);
    knownIds.add(bareModelId(m.provider, m.id));
  }
  const result = validateModelAliases(req.body?.modelAliases, knownIds);
  if (!result.ok) {
    return reply.code(400).send({ error: result.error });
  }
  const aliases = result.aliases ?? {};
  const next = await updateConfig((cfg) => {
    cfg.modelAliases = aliases;
    return cfg;
  });
  reg.updateConfig(next, { preserveModels: true });
  return { ok: true, modelAliases: next.modelAliases };
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/server exec node --test --experimental-strip-types src/__tests__/model-aliases.test.ts`

Expected: PASS —— 16 个子测试全绿

- [ ] **Step 6: 跑全量 server 测试**

Run: `pnpm --filter @freemodelfinder/server test`

Expected: 全部 pass，fail 0

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/server.ts packages/server/src/__tests__/model-aliases.test.ts
git commit -m "feat(server): 新增模型别名管理端点"
```

---

## Task 6: UI 模型值与显示

**Files:**

- Modify: `packages/ui/app/lib/models.ts`
- Modify: `packages/ui/app/components/TesterView.tsx:171-175`
- Create: `packages/ui/app/lib/__tests__/models.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/ui/app/lib/__tests__/models.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { modelValue } from '../models';

describe('modelValue', () => {
  it('composes provider:id when the model has no alias', () => {
    expect(modelValue({ provider: 'openrouter', id: 'gpt-4o-mini' })).toBe(
      'openrouter:gpt-4o-mini',
    );
  });

  it('uses alias_of as the request value so the UI never sends an alias', () => {
    expect(
      modelValue({ provider: 'opencode', id: 'my-model', alias_of: 'opencode:mimo-v2.6' }),
    ).toBe('opencode:mimo-v2.6');
  });

  it('does not double-prefix when alias_of already carries the provider', () => {
    expect(modelValue({ provider: 'opencode', id: 'my-model', alias_of: 'opencode:mimo' })).toBe(
      'opencode:mimo',
    );
  });

  it('keeps the custom provider prefixing', () => {
    expect(modelValue({ provider: 'custom', id: 'fx:fast', alias_of: 'custom:fx:fast' })).toBe(
      'custom:custom:fx:fast',
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/lib/__tests__/models.test.ts`

Expected: FAIL —— 「uses alias_of as the request value」断言不通过

- [ ] **Step 3: 给 ModelItem 加字段并改 modelValue**

在 `packages/ui/app/lib/models.ts` 的 `ModelItem` 类型（1-12 行）中，`provider: string;` 之后新增：

```ts
  /** Present only when the gateway replaced this entry's id with an alias. */
  alias_of?: string;
```

然后把 `modelValue`（57-60 行）替换为：

```ts
export function modelValue(
  model: Pick<ModelItem, 'provider' | 'id'> & { alias_of?: string },
): string {
  // The UI always dispatches the REAL model id, never the alias: aliases are an
  // external-facing surface, and the UI already knows the real id via alias_of.
  const realId = model.alias_of ?? model.id;
  if (model.provider === 'custom') return `${model.provider}:${realId}`;
  return realId.startsWith(`${model.provider}:`) ? realId : `${model.provider}:${realId}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/lib/__tests__/models.test.ts`

Expected: PASS —— 4 个子测试全绿

- [ ] **Step 5: TesterView 显示「别名 (真实id)」**

在 `packages/ui/app/components/TesterView.tsx` 的模型下拉列表（171-175 行）中，把

```tsx
{
  models.map((item) => (
    <option key={modelValue(item)} value={modelValue(item)}>
      {item.provider} · {item.display_name ?? item.id}
    </option>
  ));
}
```

替换为：

```tsx
{
  models.map((item) => (
    <option key={modelValue(item)} value={modelValue(item)}>
      {item.alias_of
        ? `${item.id} (${item.alias_of})`
        : `${item.provider} · ${item.display_name ?? item.id}`}
    </option>
  ));
}
```

- [ ] **Step 6: 跑全量 ui 测试确保无回归**

Run: `pnpm --filter @freemodelfinder/ui test`

Expected: 全部 pass

- [ ] **Step 7: 提交**

```bash
git add packages/ui/app/lib/models.ts packages/ui/app/components/TesterView.tsx packages/ui/app/lib/__tests__/models.test.ts
git commit -m "feat(ui): 模型选择器用真实 id 请求并显示别名"
```

---

## Task 7: 设置页别名编辑区 + i18n

**Files:**

- Create: `packages/ui/app/components/ModelAliasesSection.tsx`
- Modify: `packages/ui/app/components/SettingsView.tsx`
- Modify: `packages/ui/app/i18n.tsx`
- Modify: `packages/ui/test/server.ts`
- Create: `packages/ui/app/components/__tests__/model-aliases.test.tsx`

- [ ] **Step 1: 加 msw 默认 handler**

在 `packages/ui/test/server.ts` 的 `defaultHandlers` 数组（53-142 行）中，`http.get(`${gateway}/api/cline/accounts`, ...)`（119 行）之前插入：

```ts
  http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
  http.post(`${gateway}/api/model-aliases`, () =>
    HttpResponse.json({ ok: true, modelAliases: {} }),
  ),
```

- [ ] **Step 2: 写失败测试**

创建 `packages/ui/app/components/__tests__/model-aliases.test.tsx`：

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ModelAliasesSection } from '../ModelAliasesSection';
import { gateway, server } from '../../../test/server';

describe('ModelAliasesSection', () => {
  it('renders existing aliases returned by the gateway', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { 'my-model': 'custom:fx:fast' } }),
      ),
    );
    render(<ModelAliasesSection />);

    await userEvent.click(await screen.findByRole('button', { name: /模型别名/ }));
    await waitFor(() => expect(screen.getByDisplayValue('my-model')).toBeTruthy());
    expect((screen.getByDisplayValue('my-model') as HTMLInputElement).value).toBe('my-model');
  });

  it('adds a row, fills it and posts the whole map', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
      http.post(`${gateway}/api/model-aliases`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true, modelAliases: {} });
      }),
    );
    const user = userEvent.setup();
    render(<ModelAliasesSection />);

    await user.click(await screen.findByRole('button', { name: /模型别名/ }));
    await user.click(await screen.findByRole('button', { name: '添加别名' }));

    await user.type(await screen.findByPlaceholderText('别名（如 my-model）'), 'my-model');
    await user.selectOptions(await screen.findByRole('combobox'), 'custom:fx:fast');
    await user.click(screen.getByRole('button', { name: '保存别名' }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toEqual({ modelAliases: { 'my-model': 'custom:fx:fast' } });
  });

  it('surfaces the server validation error inline', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
      http.post(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ error: 'alias "x" is reserved' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<ModelAliasesSection />);

    await user.click(await screen.findByRole('button', { name: /模型别名/ }));
    await user.click(await screen.findByRole('button', { name: '添加别名' }));
    await user.type(await screen.findByPlaceholderText('别名（如 my-model）'), 'x');
    await user.click(screen.getByRole('button', { name: '保存别名' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('reserved');
  });

  it('removes a row without saving', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { 'my-model': 'custom:fx:fast' } }),
      ),
    );
    const user = userEvent.setup();
    render(<ModelAliasesSection />);

    await user.click(await screen.findByRole('button', { name: /模型别名/ }));
    await user.click(await screen.findByRole('button', { name: '删除别名' }));

    await waitFor(() => expect(screen.queryByDisplayValue('my-model')).toBeNull());
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/components/__tests__/model-aliases.test.tsx`

Expected: FAIL —— `Cannot find module '../ModelAliasesSection'`

- [ ] **Step 4: 创建 ModelAliasesSection 组件**

创建 `packages/ui/app/components/ModelAliasesSection.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { classNames, GATEWAY, withUiHeaders } from '../lib/utils';
import { useI18n } from '../i18n';

type AliasRow = { alias: string; target: string };
type ModelOption = { id: string; provider: string; displayName?: string };

export function ModelAliasesSection() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [aliasRes, modelRes] = await Promise.all([
        fetch(`${GATEWAY}/api/model-aliases`, withUiHeaders()),
        fetch(`${GATEWAY}/api/auto-route/model-options`, withUiHeaders()),
      ]);
      if (cancelled) return;
      const aliasJson = (await aliasRes.json().catch(() => ({}))) as {
        modelAliases?: Record<string, string>;
      };
      const modelJson = (await modelRes.json().catch(() => ({}))) as { models?: ModelOption[] };
      setRows(
        Object.entries(aliasJson.modelAliases ?? {}).map(([alias, target]) => ({ alias, target })),
      );
      setModels(modelJson.models ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: AliasRow[]) => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const modelAliases: Record<string, string> = {};
      for (const row of next) {
        const alias = row.alias.trim();
        if (alias) modelAliases[alias] = row.target;
      }
      const res = await fetch(
        `${GATEWAY}/api/model-aliases`,
        withUiHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelAliases }),
        }),
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `save failed ${res.status}`);
        return;
      }
      setRows(next.filter((row) => row.alias.trim()));
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section
      aria-label={t('settings.aria.aliases')}
      className="space-y-3 rounded-lg border border-border/60 bg-section-c p-3"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {t('settings.section.aliases')}
          </h2>
          <span className="text-xs text-muted-foreground">
            {t('settings.section.aliases.desc')}
          </span>
        </div>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={classNames(
            'text-muted-foreground transition-transform',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-xs text-muted-foreground">{t('settings.aliases.hint')}</p>
          {rows.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('settings.aliases.empty')}</p>
          )}
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={row.alias}
                aria-label={t('settings.aliases.aliasLabel')}
                placeholder={t('settings.aliases.aliasPlaceholder')}
                onChange={(e) =>
                  setRows((cur) =>
                    cur.map((r, i) => (i === index ? { ...r, alias: e.target.value } : r)),
                  )
                }
                className="h-9 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring"
              />
              <select
                value={row.target}
                aria-label={t('settings.aliases.targetLabel')}
                onChange={(e) =>
                  setRows((cur) =>
                    cur.map((r, i) => (i === index ? { ...r, target: e.target.value } : r)),
                  )
                }
                className="h-9 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring"
              >
                <option value="">{t('settings.aliases.targetPlaceholder')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id} ({m.id})
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={t('settings.aliases.remove')}
                onClick={() => setRows((cur) => cur.filter((_, i) => i !== index))}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRows((cur) => [...cur, { alias: '', target: '' }])}
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              <Plus size={14} />
              {t('settings.aliases.add')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(rows)}
              className="inline-flex h-9 items-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-85 disabled:opacity-50"
            >
              {t('settings.aliases.save')}
            </button>
            {saved && <span className="text-xs text-success">{t('settings.aliases.saved')}</span>}
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: 加 i18n 键（zh 与 en 必须成对）**

在 `packages/ui/app/i18n.tsx` 的 `zh` 字典中，`'settings.aria.autoRoute'` 所在行附近新增：

```ts
  'settings.section.aliases': '模型别名',
  'settings.section.aliases.desc': '为模型设置对外名称',
  'settings.aria.aliases': '模型别名设置',
  'settings.aliases.hint': '别名不能包含冒号；设置后原始 id 仍然可用。',
  'settings.aliases.empty': '还没有配置别名',
  'settings.aliases.aliasLabel': '别名',
  'settings.aliases.aliasPlaceholder': '别名（如 my-model）',
  'settings.aliases.targetLabel': '真实模型',
  'settings.aliases.targetPlaceholder': '选择真实模型',
  'settings.aliases.add': '添加别名',
  'settings.aliases.remove': '删除别名',
  'settings.aliases.save': '保存别名',
  'settings.aliases.saved': '已保存',
```

在 `en` 字典的对应位置新增：

```ts
  'settings.section.aliases': 'Model Aliases',
  'settings.section.aliases.desc': 'Give models an external name',
  'settings.aria.aliases': 'Model alias settings',
  'settings.aliases.hint': 'Aliases cannot contain ":"; the original id keeps working.',
  'settings.aliases.empty': 'No aliases configured yet',
  'settings.aliases.aliasLabel': 'Alias',
  'settings.aliases.aliasPlaceholder': 'Alias (e.g. my-model)',
  'settings.aliases.targetLabel': 'Real model',
  'settings.aliases.targetPlaceholder': 'Pick a real model',
  'settings.aliases.add': 'Add alias',
  'settings.aliases.remove': 'Remove alias',
  'settings.aliases.save': 'Save aliases',
  'settings.aliases.saved': 'Saved',
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/ui exec vitest run app/components/__tests__/model-aliases.test.tsx`

Expected: PASS —— 4 个子测试全绿

- [ ] **Step 7: 挂载到 SettingsView**

在 `packages/ui/app/components/SettingsView.tsx` 顶部 import 区新增：

```tsx
import { ModelAliasesSection } from './ModelAliasesSection';
```

在 autoRoute `<section>` 的闭合 `</section>` 之后、gateway `<section>`（约 2013 行）之前插入：

```tsx
<ModelAliasesSection />
```

- [ ] **Step 8: 跑全量 ui 测试**

Run: `pnpm --filter @freemodelfinder/ui test`

Expected: 全部 pass，i18n 键集一致性测试通过

- [ ] **Step 9: 提交**

```bash
git add packages/ui/app/components/ModelAliasesSection.tsx packages/ui/app/components/SettingsView.tsx packages/ui/app/i18n.tsx packages/ui/test/server.ts packages/ui/app/components/__tests__/model-aliases.test.tsx
git commit -m "feat(ui): 设置页新增模型别名编辑区"
```

---

## Task 8: 全量校验

**Files:** 无新增改动

- [ ] **Step 1: 构建运行时**

Run: `pnpm build:runtime`

Expected: zen → core → server 三个 tsup 构建全部成功，无 TS 错误

- [ ] **Step 2: 全量类型检查**

Run: `pnpm typecheck`

Expected: 5 个包全部 Done，退出码 0

- [ ] **Step 3: 全量测试**

Run: `pnpm test:coverage`

Expected: core / server / cli / ui 全部通过，且各包覆盖率阈值达标（core 85% lines、server 80% lines、cli 80% lines）

- [ ] **Step 4: Lint**

Run: `pnpm lint`

Expected: 无 error、无 warning（`--max-warnings=0`）

- [ ] **Step 5: 格式化**

Run: `pnpm exec prettier --check "packages/core/src/config/aliases.ts" "packages/core/src/registry.ts" "packages/core/src/types.ts" "packages/core/src/index.ts" "packages/server/src/routes/openai.ts" "packages/server/src/routes/anthropic.ts" "packages/server/src/routes/gemini.ts" "packages/server/src/server.ts" "packages/ui/app/lib/models.ts" "packages/ui/app/components/TesterView.tsx" "packages/ui/app/components/ModelAliasesSection.tsx" "packages/ui/app/components/SettingsView.tsx" "packages/ui/app/i18n.tsx"`

Expected: 全部 `unchanged`。若有 warn，执行 `prettier --write` 后重跑。

- [ ] **Step 6: 提交格式化结果（若有）**

```bash
git add -u
git commit -m "style: prettier 格式化模型别名改动"
```

若 Step 5 无改动，跳过本步。

---

## 完成标准

- [ ] `GET /v1/models` 中，有别名的模型 `id` 为别名且带 `alias_of`；无别名的模型 `id` 为原始 id 且无 `alias_of`
- [ ] 三个协议都能用别名调用成功，响应 `model` 字段回显别名
- [ ] 用原始 id 调用仍然成功；此时响应回显别名（有别名时）
- [ ] 冷却/配额统计按真实 id 记录，别名不污染统计
- [ ] `POST /api/model-aliases` 拒绝含 `:`、保留字、与真实 id 冲突的别名（400）
- [ ] 设置页可增删改别名并持久化；模型选择器显示「别名 (真实id)」且请求仍发真实 id
- [ ] `pnpm build:runtime`、`pnpm typecheck`、`pnpm test:coverage`、`pnpm lint` 全绿

---

## Self-Review

**1. Spec 覆盖检查**

| Spec 章节                    | 对应任务                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| 第 1 节 配置与类型           | Task 1（`modelAliases` 字段）、Task 1（校验规则）                                                       |
| 第 2 节 解析链路             | Task 2（`resolveModel` 钩子、`resolveAlias`）、Task 4（三路由 `preflight` 前归一化）                    |
| 第 3 节 呈现层               | Task 3（`/v1/models` 替换 + `alias_of`）、Task 4（非流式/流式/`message_start` 回显）、Task 6（UI 显示） |
| 第 4 节 管理 API / UI / 测试 | Task 5（端点）、Task 7（设置区 + i18n）、全部任务的测试步骤                                             |

诊断元数据保留真实 id —— spec 要求不变更 `SwitchNotice`/`fmf_auto_route.picked`，本计划未触碰这些字段，符合。

**2. 占位符扫描** —— 无 TBD/TODO，所有代码步骤均给出完整代码。

**3. 类型一致性**

- `validateModelAliases` 返回 `{ ok, error?, aliases? }` —— Task 1 定义，Task 5 消费（`result.error` / `result.aliases`），一致
- `resolveAlias` / `toClientFacingModel` 签名一致（Task 2 定义，Task 3/4/5 调用）
- `alias_of` 字段名在 Task 3（服务端产出）、Task 6（`ModelItem` 消费）、Task 4 测试（断言）三处一致
- `stripProviderPrefix` 为 registry.ts 模块级私有函数，仅 Task 2 内部使用
