# Auto-Route 多选模型 + 每档轮询 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** autoRoute 5 个模型配置改为多选下拉（选项来自本地已添加模型，不打厂商），同档多模型时按请求独立轮询。

**Architecture:** core 将 `AutoRouteSettings` 字段改为 `string[]` 并提供 `asModelList` 兼容旧字符串；server 在 `openai.ts` 模态路由处用模块级 `Map` 游标轮询，新增只读本地的 `GET /api/auto-route/model-options`；UI 用多选下拉替换 5 个文本框，变更即 `saveAutoRoute`。

**Tech Stack:** TypeScript、Fastify (server)、Next.js 16 + React (ui)、Node `node --test` (core/server)、Vitest (ui)

**Spec:** `docs/superpowers/specs/2026-09-23-auto-route-multi-model-round-robin-design.md`

**Notes:**

- 不推送 GitHub；仅本地 commit。
- 每 Task 结束：`npx prettier --write <files>` → `npx eslint <files> --max-warnings=0` → 对应 `pnpm --filter ... test`。
- 全部完成后：`pnpm build:runtime` → `pnpm typecheck`。
- 旧 `imageModel: 'custom:img-model'` 测试 fixture 在类型改为 `string[]` 后需改成数组（见 Task 1/3）。

---

## File Structure

| 文件                                                           | 职责                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/core/src/types.ts`                                   | `AutoRouteSettings` 字段 → `string[]`                                    |
| `packages/core/src/config/model-list.ts`                       | `asModelList` 纯函数                                                     |
| `packages/core/src/index.ts`                                   | re-export `asModelList`                                                  |
| `packages/core/src/__tests__/model-list.test.ts`               | asModelList 单测                                                         |
| `packages/server/src/server.ts`                                | GET/POST `/api/auto-route` 数组读写；`GET /api/auto-route/model-options` |
| `packages/server/src/routes/openai.ts`                         | 每档轮询游标 `nextFromPool`                                              |
| `packages/server/src/__tests__/auto-route-round-robin.test.ts` | 轮询 + 旧字符串兼容（新建）                                              |
| `packages/server/src/__tests__/model-options.test.ts`          | model-options 本地源 + 不打厂商（新建）                                  |
| `packages/server/src/routes/__tests__/auto-modality.test.ts`   | 既有 imageModel fixture → 数组                                           |
| `packages/ui/app/components/SettingsView.tsx`                  | `AutoRouteInfo` 类型 + 5 处多选下拉 + 拉 model-options                   |
| `packages/ui/app/components/ModelMultiSelect.tsx`              | 可复用多选下拉组件（新建）                                               |
| `packages/ui/app/i18n.tsx`                                     | 下拉相关文案                                                             |
| `packages/ui/test/server.ts`                                   | msw 增加 `model-options` / auto-route 数组 payload                       |
| `packages/ui/app/components/__tests__/settings.test.tsx`       | 多选 UI 测试                                                             |

---

## Task 1: core — 类型 + `asModelList`

**Files:**

- Modify: `packages/core/src/types.ts:138-150`
- Create: `packages/core/src/config/model-list.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/__tests__/model-list.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/__tests__/model-list.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asModelList } from '../config/model-list.js';

describe('asModelList', () => {
  it('wraps non-empty string', () => {
    assert.deepEqual(asModelList('custom:a:b'), ['custom:a:b']);
  });

  it('returns [] for empty string / null / undefined / number', () => {
    assert.deepEqual(asModelList(''), []);
    assert.deepEqual(asModelList(null), []);
    assert.deepEqual(asModelList(undefined), []);
    assert.deepEqual(asModelList(42), []);
  });

  it('filters empty entries and dedupes arrays', () => {
    assert.deepEqual(asModelList(['a', '', 'b', 'a']), ['a', 'b']);
  });

  it('accepts readonly arrays', () => {
    assert.deepEqual(asModelList(['x'] as const), ['x']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter @freemodelfinder/core test
```

Expected: FAIL — 找不到 `../config/model-list.js` 或 `asModelList` 未定义。

- [ ] **Step 3: 实现 `asModelList` + 改类型**

创建 `packages/core/src/config/model-list.ts`：

```ts
export function asModelList(value: unknown): string[] {
  if (typeof value === 'string') {
    const v = value.trim();
    return v ? [v] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) out.push(item.trim());
    }
    return Array.from(new Set(out));
  }
  return [];
}
```

修改 `packages/core/src/types.ts` 中 `AutoRouteSettings`：

```ts
export interface AutoRouteSettings {
  enabled: boolean;
  strategy: AutoRouteStrategy;
  profiles?: ModelRoutingProfile[];
  fallbackChain?: string[];
  imageModel?: string[];
  videoModel?: string[];
  textTiers?: {
    simple?: string[];
    medium?: string[];
    complex?: string[];
  };
}
```

修改 `packages/core/src/index.ts`，在现有 export 旁追加：

```ts
export { asModelList } from './config/model-list.js';
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
pnpm --filter @freemodelfinder/core test
```

Expected: PASS（含原有 core 测试）。

- [ ] **Step 5: 格式化 + lint + 提交**

```powershell
npx prettier --write "packages/core/src/types.ts" "packages/core/src/config/model-list.ts" "packages/core/src/index.ts" "packages/core/src/__tests__/model-list.test.ts"
npx eslint "packages/core/src/types.ts" "packages/core/src/config/model-list.ts" "packages/core/src/index.ts" "packages/core/src/__tests__/model-list.test.ts" --max-warnings=0
git add packages/core/src/types.ts packages/core/src/config/model-list.ts packages/core/src/index.ts packages/core/src/__tests__/model-list.test.ts
git commit -m "feat(core): autoRoute model fields as string[] with asModelList"
```

---

## Task 2: server — GET/POST `/api/auto-route` 数组读写

**Files:**

- Modify: `packages/server/src/server.ts`（GET ~981-997，POST ~999-1037）
- Test file 将在 Task 4 统一覆盖；本 Task 先保证 `typecheck`/既有测试不因类型挂掉。

- [ ] **Step 1: 确认 import**

`packages/server/src/server.ts` 顶部从 `@freemodelfinder/core` 的 import 增加 `asModelList`（与 `loadSnapshot` 等并列；若 `loadSnapshot` 未 import，model-options 任务再加）。

- [ ] **Step 2: 改 GET 返回**

将 GET `/api/auto-route` 的 body 改为：

```ts
app.get('/api/auto-route', async () => {
  const cfg = getRegistry().getConfig();
  const ar = cfg.autoRoute ?? { enabled: false, strategy: 'capability' as const };
  const router = getRegistry().getAutoRouter();
  return {
    enabled: !!ar.enabled,
    strategy: ar.strategy,
    profiles: ar.profiles ?? [],
    fallbackChain: ar.fallbackChain ?? [],
    imageModel: asModelList(ar.imageModel),
    videoModel: asModelList(ar.videoModel),
    textTiers: {
      simple: asModelList(ar.textTiers?.simple),
      medium: asModelList(ar.textTiers?.medium),
      complex: asModelList(ar.textTiers?.complex),
    },
    cooldowns: router.listCooldowns(),
    rememberedPreference: router.getRememberedPreference(),
    recentNotices: getRegistry().peekNotices(),
  };
});
```

- [ ] **Step 3: 改 POST Body 与合并逻辑**

```ts
app.post<{
  Body: {
    enabled?: boolean;
    strategy?: 'capability' | 'speed' | 'rate-limit';
    fallbackChain?: string[];
    profiles?: unknown;
    imageModel?: string[] | string;
    videoModel?: string[] | string;
    textTiers?: {
      simple?: string[] | string;
      medium?: string[] | string;
      complex?: string[] | string;
    };
  };
}>('/api/auto-route', async (req, reply) => {
  const { enabled, strategy, fallbackChain, profiles, imageModel, videoModel, textTiers } =
    req.body ?? {};
  if (strategy && !['capability', 'speed', 'rate-limit'].includes(strategy)) {
    return reply.code(400).send({ error: 'invalid strategy' });
  }
  const next = await updateConfig((cfg) => {
    const cur = cfg.autoRoute ?? { enabled: false, strategy: 'capability' as const };
    const prevTiers = cur.textTiers;
    cfg.autoRoute = {
      enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
      strategy: strategy ?? cur.strategy,
      fallbackChain: Array.isArray(fallbackChain) ? fallbackChain : cur.fallbackChain,
      profiles: Array.isArray(profiles) ? (profiles as never) : cur.profiles,
      imageModel: imageModel !== undefined ? asModelList(imageModel) : cur.imageModel,
      videoModel: videoModel !== undefined ? asModelList(videoModel) : cur.videoModel,
      textTiers: textTiers
        ? {
            simple:
              textTiers.simple !== undefined
                ? asModelList(textTiers.simple)
                : asModelList(prevTiers?.simple),
            medium:
              textTiers.medium !== undefined
                ? asModelList(textTiers.medium)
                : asModelList(prevTiers?.medium),
            complex:
              textTiers.complex !== undefined
                ? asModelList(textTiers.complex)
                : asModelList(prevTiers?.complex),
          }
        : prevTiers
          ? {
              simple: asModelList(prevTiers.simple),
              medium: asModelList(prevTiers.medium),
              complex: asModelList(prevTiers.complex),
            }
          : prevTiers,
    };
    return cfg;
  });
  getRegistry().updateConfig(next, { preserveModels: true });
  return { ok: true, autoRoute: next.autoRoute };
});
```

约定：

- body **缺省字段**（`undefined`）→ 保留旧值。
- body **显式 `[]`** → 清空该字段（`asModelList([]) === []`）。
- 单字符串 body（兼容旧客户端）→ `asModelList` 转数组。

- [ ] **Step 4: 修既有测试里的字符串 fixture**

`packages/server/src/routes/__tests__/auto-modality.test.ts` 中：

```ts
// 改前
imageModel: 'custom:img-model',
// 改后
imageModel: ['custom:img-model'],
```

共 2 处（~169、~198）。

- [ ] **Step 5: 跑 server 测试**

```powershell
pnpm --filter @freemodelfinder/server test
```

Expected: PASS。

- [ ] **Step 6: 格式化 + lint + 提交**

```powershell
npx prettier --write "packages/server/src/server.ts" "packages/server/src/routes/__tests__/auto-modality.test.ts"
npx eslint "packages/server/src/server.ts" "packages/server/src/routes/__tests__/auto-modality.test.ts" --max-warnings=0
git add packages/server/src/server.ts packages/server/src/routes/__tests__/auto-modality.test.ts
git commit -m "feat(server): auto-route API accepts string[] model pools"
```

---

## Task 3: server — 每档独立轮询

**Files:**

- Modify: `packages/server/src/routes/openai.ts`（modality 路由 ~309-335）
- Create: `packages/server/src/__tests__/auto-route-round-robin.test.ts`
- Modify: `packages/server/src/routes/openai.ts` import 增加 `asModelList`

- [ ] **Step 1: 写失败测试**

创建 `packages/server/src/__tests__/auto-route-round-robin.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ProviderRegistry,
  type AppConfig,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
} from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

function textMsg(content: string) {
  return { role: 'user' as const, content };
}

function rrConfig(autoRoute: AppConfig['autoRoute']): AppConfig {
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
                id: 'fixture',
                label: 'Fixture',
                baseUrl: 'https://fixture.invalid/v1',
                apiKey: 'k',
                models: [{ id: 'img-a' }, { id: 'img-b' }, { id: 'plain' }],
              },
            ],
          },
        },
      },
    },
    gateway: { requireAuth: false },
    autoRoute,
  };
}

/** 记录 resolveModel 收到的完整 model id，并返回固定 provider。 */
function rrRegistry(autoRoute: AppConfig['autoRoute']) {
  const seen: string[] = [];
  const registry = new ProviderRegistry(rrConfig(autoRoute));
  const response: ChatResponse = {
    id: 'r',
    model: 'fixture-model',
    created: 1,
    content: 'ok',
    finish_reason: 'stop',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const provider = {
    id: 'custom',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      return { ...response, model: req.model };
    },
    async *stream(req: ChatRequest) {
      yield {
        id: 's',
        model: req.model,
        created: 1,
        delta: 'ok',
        finish_reason: 'stop' as const,
      };
    },
    async generateImage(req: { model: string }) {
      return { created: 1, data: [{ url: `https://example.invalid/${req.model}.png` }] };
    },
  };
  registry.resolveModel = (modelId: string) => {
    seen.push(modelId);
    return { provider: provider as never, modelId };
  };
  registry.listAllModels = async () => ({
    models: [
      {
        id: 'fixture:plain',
        provider: 'custom',
        displayName: 'Plain',
        free: true,
      } satisfies ModelInfo,
    ],
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  return { registry, seen };
}

async function withApp(
  autoRoute: AppConfig['autoRoute'],
  fn: (app: FastifyInstance, seen: string[]) => Promise<void>,
): Promise<void> {
  const { registry, seen } = rrRegistry(autoRoute);
  const { app } = await createServer({
    registry,
    watchIntervalMs: 60 * 60 * 1000,
  });
  try {
    await fn(app, seen);
  } finally {
    await app.close();
  }
}

async function postImage(app: FastifyInstance): Promise<unknown> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      model: 'auto',
      messages: [textMsg('生成小猫图片')],
      stream: false,
    },
  });
  assert.equal(res.statusCode, 200);
  return res.json();
}

describe('auto-route multi-model round robin', () => {
  it('round-robins imageModel pool across consecutive requests', async () => {
    // 游标是模块级内存：用足够长的不同序列断言循环出现两种 id。
    await withApp(
      {
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:fixture:img-a', 'custom:fixture:img-b'],
      },
      async (app, seen) => {
        seen.length = 0;
        const models: string[] = [];
        for (let i = 0; i < 4; i++) {
          const body = (await postImage(app)) as { model?: string };
          models.push(body.model ?? '');
        }
        // 每档独立：连续 4 次应出现 a,b,a,b（或从游标中途开始的等价循环）
        const unique = new Set(models);
        assert.equal(unique.size, 2, `expected 2 distinct models, got ${models.join(',')}`);
        assert.ok(models.includes('custom:fixture:img-a'));
        assert.ok(models.includes('custom:fixture:img-b'));
        // 相邻两次不同 → 确实在轮询
        for (let i = 1; i < models.length; i++) {
          assert.notEqual(models[i], models[i - 1]);
        }
      },
    );
  });

  it('keeps single-element pool stable', async () => {
    await withApp(
      {
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:fixture:only'],
      },
      async (app) => {
        const a = (await postImage(app)) as { model?: string };
        const b = (await postImage(app)) as { model?: string };
        assert.equal(a.model, 'custom:fixture:only');
        assert.equal(b.model, 'custom:fixture:only');
      },
    );
  });

  it('accepts legacy string imageModel in config file', async () => {
    await withApp(
      {
        enabled: false,
        strategy: 'capability',
        // 旧磁盘格式：运行时 asModelList 兼容
        imageModel: 'custom:fixture:legacy' as unknown as string[],
      },
      async (app) => {
        const body = (await postImage(app)) as { model?: string };
        assert.equal(body.model, 'custom:fixture:legacy');
      },
    );
  });

  it('does not consume image cursor when text tier is used', async () => {
    await withApp(
      {
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:fixture:img-a', 'custom:fixture:img-b'],
        textTiers: { simple: ['custom:fixture:s0', 'custom:fixture:s1'] },
      },
      async (app) => {
        // 两次简单文本：只推进 simple 游标
        const t1 = (
          await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            payload: {
              model: 'auto',
              messages: [textMsg('hi')],
              stream: false,
            },
          })
        ).json() as { model?: string };
        const t2 = (
          await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            payload: {
              model: 'auto',
              messages: [textMsg('hello')],
              stream: false,
            },
          })
        ).json() as { model?: string };
        assert.notEqual(t1.model, t2.model);

        // 图片游标应仍从池起点开始（与 simple 游标隔离）
        // 注意：image 游标可能因测试顺序已有偏移，这里只断言 image 两次请求仍在 image 池内且轮询。
        const i1 = (await postImage(app)) as { model?: string };
        const i2 = (await postImage(app)) as { model?: string };
        assert.ok(i1.model === 'custom:fixture:img-a' || i1.model === 'custom:fixture:img-b');
        assert.ok(i2.model === 'custom:fixture:img-a' || i2.model === 'custom:fixture:img-b');
        assert.notEqual(i1.model, i2.model);
      },
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter @freemodelfinder/server test
```

Expected: 新文件 FAIL — 多模型时 `body.model` 目前仍是数组被强转或仍取旧单字符串逻辑（`ar.imageModel` 为数组时 truthy 分支直接赋值数组导致异常/非预期）。

- [ ] **Step 3: 实现轮询**

修改 `packages/server/src/routes/openai.ts`：

1. import 增加 `asModelList`。

2. 在 `classifyTextComplexity` / `findImageModelId` 附近（模块级）加入：

```ts
const modalityCursor = new Map<string, number>();

function nextFromPool(slot: string, pool: string[]): string | undefined {
  if (!pool.length) return undefined;
  const cursor = modalityCursor.get(slot) ?? 0;
  const pick = pool[cursor % pool.length]!;
  modalityCursor.set(slot, (cursor + 1) % pool.length);
  return pick;
}
```

3. 将 auto 模态分支改为：

```ts
let forcedImageModality = false;
if (chatReq.model === 'auto' || chatReq.model === 'default') {
  const cfg = reg.getConfig();
  const ar = cfg.autoRoute;
  const detectedModality = detectRequestModality(body.messages);
  if (detectedModality === 'image') {
    const pool = asModelList(ar?.imageModel);
    const picked = nextFromPool('image', pool);
    if (picked) {
      chatReq.model = picked;
      forcedImageModality = true;
    } else {
      const discovered = await findImageModelId(reg);
      if (discovered) {
        chatReq.model = discovered;
        forcedImageModality = true;
      }
      // 未发现则保持 auto → 原文本链路
    }
  } else if (detectedModality === 'video') {
    const pool = asModelList(ar?.videoModel);
    const picked = nextFromPool('video', pool);
    if (picked) chatReq.model = picked;
  } else if (detectedModality === 'text' && ar?.textTiers) {
    const prompt = chatReq.messages.map((m) => m.content).join('\n');
    const tier = classifyTextComplexity(prompt);
    const pool = asModelList(ar.textTiers[tier]);
    const picked = nextFromPool(`text:${tier}`, pool);
    if (picked) chatReq.model = picked;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
pnpm --filter @freemodelfinder/server test
```

Expected: PASS（含 round-robin 新测试与既有 auto-modality）。

- [ ] **Step 5: 格式化 + lint + 提交**

```powershell
npx prettier --write "packages/server/src/routes/openai.ts" "packages/server/src/__tests__/auto-route-round-robin.test.ts"
npx eslint "packages/server/src/routes/openai.ts" "packages/server/src/__tests__/auto-route-round-robin.test.ts" --max-warnings=0
git add packages/server/src/routes/openai.ts packages/server/src/__tests__/auto-route-round-robin.test.ts
git commit -m "feat(server): round-robin auto-route model pools per modality slot"
```

---

## Task 4: server — `GET /api/auto-route/model-options`（只读本地）

**Files:**

- Modify: `packages/server/src/server.ts`（紧邻 `/api/auto-route` GET）
- Modify: `packages/core/src/registry.ts`（增加 `peekLocalModels`）
- Create: `packages/server/src/__tests__/model-options.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/server/src/__tests__/model-options.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderRegistry, type AppConfig } from '@freemodelfinder/core';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';

function configWithCustomModels(): AppConfig {
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
                id: 'fixture',
                label: 'Fixture',
                baseUrl: 'https://fixture.invalid/v1',
                apiKey: 'k',
                models: [
                  { id: 'plain-chat', displayName: 'Plain' },
                  { id: 'sora-image', displayName: 'Img' },
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

async function withApp(
  fn: (app: FastifyInstance, registry: ProviderRegistry) => Promise<void>,
): Promise<void> {
  const registry = new ProviderRegistry(configWithCustomModels());
  let listAllCalls = 0;
  const original = registry.listAllModels.bind(registry);
  registry.listAllModels = async (force?: boolean) => {
    listAllCalls += 1;
    if (force) listAllCalls += 1000; // force 调用视为违规
    return original(force);
  };
  const { app } = await createServer({
    registry,
    watchIntervalMs: 60 * 60 * 1000,
  });
  try {
    await fn(app, registry);
    assert.equal(listAllCalls, 0, 'model-options must not call listAllModels');
  } finally {
    await app.close();
  }
}

describe('GET /api/auto-route/model-options', () => {
  it('returns merged local catalog without calling providers', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        models: Array<{ id: string; provider: string; displayName?: string }>;
      };
      const ids = body.models.map((m) => m.id);
      // 自定义源：composed id = custom:<sourceId>:<modelId>
      assert.ok(ids.includes('custom:fixture:plain-chat'), ids.join(','));
      assert.ok(ids.includes('custom:fixture:sora-image'), ids.join(','));
      // id 有 provider 字段
      const plain = body.models.find((m) => m.id === 'custom:fixture:plain-chat');
      assert.equal(plain?.provider, 'custom');
    });
  });

  it('dedupes and omits empty ids', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auto-route/model-options',
      });
      const body = res.json() as { models: Array<{ id: string }> };
      const ids = body.models.map((m) => m.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.every((id) => id.length > 0));
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter @freemodelfinder/server test
```

Expected: FAIL — 404（路由不存在）或若误实现则可能触发 `listAllCalls` 断言。

- [ ] **Step 3: registry 增加 `peekLocalModels`**

在 `packages/core/src/registry.ts` 的 `listAllModels` 方法旁添加：

```ts
/**
 * Local-only model catalog for UI pickers.
 * Uses in-memory cache when fresh; otherwise reads snapshot from disk.
 * Never calls provider listModels().
 */
async peekLocalModels(): Promise<ModelInfo[]> {
  const ttl = 5 * 60 * 1000;
  if (this.modelsCache && Date.now() - this.cacheAt < ttl) {
    return this.modelsCache.models;
  }
  const snapshot = await this.loadModelSnapshot();
  return snapshot.models.map((m) => ({
    id: m.id,
    provider: m.provider,
    displayName: m.displayName,
    free: m.free,
  }));
}
```

确认 `ModelInfo` 在 `registry.ts` 已 import（已有）。

- [ ] **Step 4: 实现 model-options 路由**

在 `packages/server/src/server.ts` 的 GET `/api/auto-route` **之后**插入：

```ts
app.get('/api/auto-route/model-options', async () => {
  const reg = getRegistry();
  const local = await reg.peekLocalModels();
  const cfg = reg.getConfig();
  const custom = cfg.providers.custom;
  const extra = (custom?.credentials?.extra ?? {}) as {
    sources?: Array<{
      id: string;
      label?: string;
      models?: Array<{ id: string; displayName?: string; contextWindow?: number }>;
    }>;
  };
  const sources = Array.isArray(extra.sources) ? extra.sources : [];

  const byId = new Map<
    string,
    { id: string; provider: string; displayName?: string; capabilities?: string[] }
  >();
  const push = (entry: {
    id: string;
    provider: string;
    displayName?: string;
    capabilities?: string[];
  }) => {
    if (!entry.id) return;
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  };

  for (const m of local) {
    push({
      id: `${m.provider}:${m.id}`,
      provider: m.provider,
      displayName: m.displayName,
      capabilities: m.capabilities,
    });
  }
  for (const src of sources) {
    const srcId = String(src.id ?? '');
    if (!srcId) continue;
    for (const m of src.models ?? []) {
      const bare = typeof m?.id === 'string' ? m.id.trim() : '';
      if (!bare) continue;
      const composed =
        bare.includes(':') && bare.startsWith('custom:') ? bare : `custom:${srcId}:${bare}`;
      push({
        id: composed,
        provider: 'custom',
        displayName: m.displayName?.trim() || bare,
      });
    }
  }

  return { models: [...byId.values()] };
});
```

说明：

- 快照/缓存条目 id 形如 `provider:modelId`（`modelValue` 同构）。
- 自定义源 composed id 与 `custom.ts` `listModels` 的 `custom:<sourceId>:<modelId>` 一致。
- **不**调用 `listAllModels` / provider `listModels`。

- [ ] **Step 5: 若 core 有改动，先 build runtime 再测**

```powershell
pnpm build:runtime
pnpm --filter @freemodelfinder/server test
```

Expected: PASS。

- [ ] **Step 6: 格式化 + lint + 提交**

```powershell
npx prettier --write "packages/core/src/registry.ts" "packages/server/src/server.ts" "packages/server/src/__tests__/model-options.test.ts"
npx eslint "packages/core/src/registry.ts" "packages/server/src/server.ts" "packages/server/src/__tests__/model-options.test.ts" --max-warnings=0
git add packages/core/src/registry.ts packages/server/src/server.ts packages/server/src/__tests__/model-options.test.ts
git commit -m "feat(server): local-only auto-route model-options endpoint"
```

---

## Task 5: ui — `ModelMultiSelect` 组件 + i18n

**Files:**

- Create: `packages/ui/app/components/ModelMultiSelect.tsx`
- Modify: `packages/ui/app/i18n.tsx`（zh ~247-259，en ~709-721）

- [ ] **Step 1: i18n 键**

在 zh 段 `settings.autoRoute.modality.imageModelPh` 附近增加（en 段同步）：

```ts
// zh
'settings.autoRoute.multi.selected': '已选 {count} 个模型',
'settings.autoRoute.multi.empty': '暂无可选模型（本地目录为空）',
'settings.autoRoute.multi.open': '选择模型',
'settings.autoRoute.multi.hint': '多选后请求将按列表轮询；空选=未配置该档。',
'settings.autoRoute.multi.legacyOnly': '已选但不在列表中',

// en
'settings.autoRoute.multi.selected': '{count} model(s) selected',
'settings.autoRoute.multi.empty': 'No local models available',
'settings.autoRoute.multi.open': 'Pick models',
'settings.autoRoute.multi.hint': 'Multiple models round-robin per request; empty = unset.',
'settings.autoRoute.multi.legacyOnly': 'Selected but not in catalog',
```

`Ph` 占位键可保留（不再渲染 input 时可删；本计划 UI 不再用 Ph，则删除 5 个 `*Ph` 键前先 grep 无引用再删）。

- [ ] **Step 2: 创建组件**

创建 `packages/ui/app/components/ModelMultiSelect.tsx`：

```tsx
'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { classNames } from '../lib/utils';
import { useI18n } from '../i18n';

export type ModelOption = {
  id: string;
  provider: string;
  displayName?: string;
  capabilities?: string[];
};

type Props = {
  label: string;
  options: ModelOption[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** 过滤：默认全部；由父组件按档位传入 */
  filter?: 'image' | 'video' | 'text';
};

function bareId(id: string): string {
  const parts = id.split(':');
  return parts[parts.length - 1] ?? id;
}

export function matchesFilter(opt: ModelOption, filter: Props['filter']): boolean {
  const caps = opt.capabilities ?? [];
  const bare = bareId(opt.id);
  if (filter === 'image') {
    return caps.includes('image') || /image/i.test(bare);
  }
  if (filter === 'video') {
    return caps.includes('video') || /video/i.test(bare);
  }
  // text: 有 text 能力、无 capabilities、或裸 id 不像纯 image/video 专用
  if (caps.includes('text') || caps.length === 0) return true;
  if (caps.includes('image') || caps.includes('video')) {
    // 同时具备 image/video 但仍可能是多模态文本模型 → 仅当裸 id 明确 image/video 时排除
    if (/image/i.test(bare) && !caps.includes('text')) return false;
    if (/video/i.test(bare) && !caps.includes('text')) return false;
    return true;
  }
  return !/image/i.test(bare) && !/video/i.test(bare);
}

export function ModelMultiSelect({
  label,
  options,
  value,
  onChange,
  disabled,
  filter = 'text',
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const visible = useMemo(() => options.filter((o) => matchesFilter(o, filter)), [options, filter]);

  const visibleIds = useMemo(() => new Set(visible.map((o) => o.id)), [visible]);
  const missing = value.filter((id) => !visibleIds.has(id));

  function toggle(id: string) {
    if (disabled) return;
    const set = new Set(value);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange(Array.from(set));
  }

  const count = value.length;

  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">{label}</label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md border border-input bg-surface px-3 py-1.5 text-left text-xs text-foreground shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <span className={classNames(count === 0 && 'text-muted-foreground/60')}>
          {count === 0
            ? t('settings.autoRoute.multi.open')
            : t('settings.autoRoute.multi.selected', { count })}
        </span>
        <ChevronDown
          size={12}
          className={classNames('text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="rounded-md border border-border bg-surface-muted/40 p-1 shadow-sm">
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            {t('settings.autoRoute.multi.hint')}
          </p>
          {visible.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t('settings.autoRoute.multi.empty')}
            </p>
          )}
          <ul className="max-h-40 overflow-y-auto">
            {visible.map((opt) => {
              const checked = value.includes(opt.id);
              return (
                <li key={opt.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-surface-muted">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(opt.id)}
                      disabled={disabled}
                      className="h-3.5 w-3.5 rounded border-border"
                    />
                    <span className="truncate font-mono">{opt.id}</span>
                    {opt.displayName && (
                      <span className="truncate text-muted-foreground">{opt.displayName}</span>
                    )}
                    {checked && <Check size={12} className="ml-auto text-success" />}
                  </label>
                </li>
              );
            })}
          </ul>
          {missing.map((id) => (
            <label
              key={id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-warning hover:bg-surface-muted"
            >
              <input
                type="checkbox"
                checked
                onChange={() => toggle(id)}
                disabled={disabled}
                className="h-3.5 w-3.5 rounded border-border"
              />
              <span className="truncate font-mono">{id}</span>
              <span className="text-[10px]">{t('settings.autoRoute.multi.legacyOnly')}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
```

类名使用现有 token：`text-success`（成功勾选）、`text-warning`（离线已选）；不要用不存在的 `text-ok`。

- [ ] **Step 3: lint 组件（暂不接线）**

```powershell
npx prettier --write "packages/ui/app/components/ModelMultiSelect.tsx" "packages/ui/app/i18n.tsx"
npx eslint "packages/ui/app/components/ModelMultiSelect.tsx" "packages/ui/app/i18n.tsx" --max-warnings=0
pnpm --filter @freemodelfinder/ui test
```

Expected: PASS（组件尚未被渲染，既有测试不受影响；i18n 仅新增键）。

- [ ] **Step 4: 提交**

```powershell
git add packages/ui/app/components/ModelMultiSelect.tsx packages/ui/app/i18n.tsx
git commit -m "feat(ui): ModelMultiSelect component and i18n keys"
```

---

## Task 6: ui — SettingsView 接线（类型 + 拉取 + 5 处替换）

**Files:**

- Modify: `packages/ui/app/components/SettingsView.tsx`（AutoRouteInfo ~174-190；modality 区 ~1243-1332；useEffect 增加 model-options）
- Modify: `packages/ui/test/server.ts`（auto-route payload + model-options handler）

- [ ] **Step 1: 更新 msw fixtures**

`packages/ui/test/server.ts`：

1. 扩展 auto-route GET 默认 payload：

```ts
http.get(`${gateway}/api/auto-route`, () =>
  HttpResponse.json({
    enabled: false,
    strategy: 'capability',
    fallbackChain: [],
    imageModel: [],
    videoModel: [],
    textTiers: { simple: [], medium: [], complex: [] },
    cooldowns: [],
    recentNotices: [],
  }),
),
http.get(`${gateway}/api/auto-route/model-options`, () =>
  HttpResponse.json({
    models: [
      {
        id: 'openrouter:fixture-model',
        provider: 'openrouter',
        displayName: 'Fixture Model',
        capabilities: ['text'],
      },
      {
        id: 'custom:fixture:plain-chat',
        provider: 'custom',
        displayName: 'Plain',
      },
      {
        id: 'custom:fixture:sora-image',
        provider: 'custom',
        displayName: 'Img',
        capabilities: ['image'],
      },
      {
        id: 'custom:fixture:clip-video',
        provider: 'custom',
        displayName: 'Vid',
        capabilities: ['video'],
      },
    ],
  }),
),
```

2. 确认 `defaultHandlers` 数组包含上述两条。

- [ ] **Step 2: SettingsView 类型与状态**

`AutoRouteInfo` 改为：

```ts
type AutoRouteInfo = {
  enabled: boolean;
  strategy: 'capability' | 'speed' | 'rate-limit';
  fallbackChain?: string[];
  imageModel?: string[];
  videoModel?: string[];
  textTiers?: { simple?: string[]; medium?: string[]; complex?: string[] };
  cooldowns?: { model: string; provider: string; resetAt: number }[];
  rememberedPreference?: string | null;
  recentNotices?: {...}; // 不变
};
```

在 `autoRoute` state 旁增加：

```ts
const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
```

import：`import { ModelMultiSelect, type ModelOption } from './ModelMultiSelect';`

在现有 auto-route `useEffect` 中（或独立 effect）拉取：

```ts
useEffect(() => {
  fetch(`${GATEWAY}/api/auto-route/model-options`, withUiHeaders())
    .then((r) => r.json())
    .then((d) => setModelOptions(Array.isArray(d?.models) ? d.models : []))
    .catch(() => setModelOptions([]));
}, []);
```

- [ ] **Step 3: 替换 image/video 两个 input**

将 ~1243-1284 的两个 `<input type="text">` 换成：

```tsx
<ModelMultiSelect
  label={t('settings.autoRoute.modality.imageModel')}
  options={modelOptions}
  filter="image"
  value={autoRoute?.imageModel ?? []}
  onChange={(next) => {
    if (autoRoute) void saveAutoRoute({ imageModel: next });
  }}
  disabled={autoRouteBusy}
/>
<ModelMultiSelect
  label={t('settings.autoRoute.modality.videoModel')}
  options={modelOptions}
  filter="video"
  value={autoRoute?.videoModel ?? []}
  onChange={(next) => {
    if (autoRoute) void saveAutoRoute({ videoModel: next });
  }}
  disabled={autoRouteBusy}
/>
```

- [ ] **Step 4: 替换文本三档 input**

在 tiers map 中把 `<input type="text" ...>` 换成：

```tsx
<ModelMultiSelect
  label={
    <>
      <span>{tier.icon}</span> {tier.label}
    </>
    // 若 Props.label 仅接受 string，则 label={tier.label}，icon 保留在外层 label
  }
  options={modelOptions}
  filter="text"
  value={autoRoute?.textTiers?.[tier.key] ?? []}
  onChange={(next) => {
    if (autoRoute) {
      void saveAutoRoute({
        textTiers: {
          ...autoRoute.textTiers,
          [tier.key]: next,
        },
      });
    }
  }}
  disabled={autoRouteBusy}
/>
```

**简化：** `ModelMultiSelect.label` 保持 `string`，外层已有 icon+label 的 `<label>` 结构则去掉组件内 label，或组件 `label={tier.label}` 且不在外层重复。以最小 diff 为准：组件 `label` 用 `tier.label`，删除原 input 的 placeholder。

- [ ] **Step 5: 本地 typecheck + ui 测试**

```powershell
pnpm build:runtime
pnpm --filter @freemodelfinder/ui test
npx eslint "packages/ui/app/components/SettingsView.tsx" "packages/ui/test/server.ts" --max-warnings=0
npx prettier --write "packages/ui/app/components/SettingsView.tsx" "packages/ui/test/server.ts"
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add packages/ui/app/components/SettingsView.tsx packages/ui/test/server.ts
git commit -m "feat(ui): auto-route multi-select picks from local model-options"
```

---

## Task 7: ui — 多选行为测试

**Files:**

- Modify: `packages/ui/app/components/__tests__/settings.test.tsx`
- Modify: `packages/ui/test/server.ts`（若需按需覆盖 auto-route POST 记录）

- [ ] **Step 1: 写失败测试**

在 `settings.test.tsx` 追加（msw 按需 `server.use`）：

```tsx
it('auto-route image multi-select saves array payload', async () => {
  const posts: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
    http.get(`${gateway}/api/auto-route`, () =>
      HttpResponse.json({
        enabled: false,
        strategy: 'capability',
        fallbackChain: [],
        imageModel: [],
        videoModel: [],
        textTiers: { simple: [], medium: [], complex: [] },
        cooldowns: [],
        recentNotices: [],
      }),
    ),
    http.get(`${gateway}/api/auto-route/model-options`, () =>
      HttpResponse.json({
        models: [
          {
            id: 'custom:fixture:sora-image',
            provider: 'custom',
            displayName: 'Img',
            capabilities: ['image'],
          },
          {
            id: 'openrouter:fixture-model',
            provider: 'openrouter',
            displayName: 'Text',
            capabilities: ['text'],
          },
        ],
      }),
    ),
    http.post(`${gateway}/api/auto-route`, async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        ok: true,
        autoRoute: { enabled: false, strategy: 'capability' },
      });
    }),
  );

  const user = userEvent.setup();
  render(<SettingsView />);

  // 打开图片档下拉
  const triggers = await screen.findAllByRole('button', { name: /选择模型|已选/ });
  // 第一个 trigger 是图片档（DOM 顺序）
  await user.click(triggers[0]!);

  const checkbox = await screen.findByLabelText(/custom:fixture:sora-image/);
  await user.click(checkbox);

  await waitFor(() => expect(posts.length).toBeGreaterThan(0));
  expect(posts[0]).toMatchObject({ imageModel: ['custom:fixture:sora-image'] });
  // 能力过滤：文本模型不应出现在图片档列表（打开状态下）
  expect(screen.queryByLabelText(/openrouter:fixture-model/)).toBeNull();
});

it('clearing all image models posts empty array', async () => {
  const posts: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
    http.get(`${gateway}/api/auto-route`, () =>
      HttpResponse.json({
        enabled: false,
        strategy: 'capability',
        imageModel: ['custom:fixture:sora-image'],
        videoModel: [],
        textTiers: { simple: [], medium: [], complex: [] },
        cooldowns: [],
        recentNotices: [],
      }),
    ),
    http.get(`${gateway}/api/auto-route/model-options`, () =>
      HttpResponse.json({
        models: [
          {
            id: 'custom:fixture:sora-image',
            provider: 'custom',
            capabilities: ['image'],
          },
        ],
      }),
    ),
    http.post(`${gateway}/api/auto-route`, async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true });
    }),
  );

  const user = userEvent.setup();
  render(<SettingsView />);
  const triggers = await screen.findAllByRole('button', { name: /选择模型|已选/ });
  await user.click(triggers[0]!);
  const checkbox = await screen.findByLabelText(/custom:fixture:sora-image/);
  await user.click(checkbox);
  await waitFor(() => expect(posts.length).toBeGreaterThan(0));
  expect(posts[0]).toMatchObject({ imageModel: [] });
});
```

- [ ] **Step 2: 跑 ui 测试确认失败**

```powershell
pnpm --filter @freemodelfinder/ui test
```

Expected: 新用例 FAIL（尚未接线或 locator 不对时先修 locator/组件 aria）。

为可测性：`ModelMultiSelect` 触发 button 的 accessible name 建议含 label（如 `aria-label={label}`），checkbox label 用 `aria-label={opt.id}` 或 wrap label 文本含完整 id——以测试 locator 为准在组件上补 `aria-label={opt.id}`。

- [ ] **Step 3: 修组件 a11y 使测试过**

在 checkbox 的 `<input>` 上加 `aria-label={opt.id}`；触发 button 加 `aria-label={`${label}`}` 或 `aria-label={label}`。

- [ ] **Step 4: 全绿 + 提交**

```powershell
pnpm --filter @freemodelfinder/ui test
npx prettier --write "packages/ui/app/components/__tests__/settings.test.tsx" "packages/ui/app/components/ModelMultiSelect.tsx"
npx eslint "packages/ui/app/components/__tests__/settings.test.tsx" "packages/ui/app/components/ModelMultiSelect.tsx" --max-warnings=0
git add packages/ui/app/components/__tests__/settings.test.tsx packages/ui/app/components/ModelMultiSelect.tsx
git commit -m "test(ui): auto-route multi-select save and capability filter"
```

---

## Task 8: 全量验证

**Files:** 无新文件（验证）

- [ ] **Step 1: runtime 构建 + typecheck**

```powershell
pnpm build:runtime
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 2: 全包测试**

```powershell
pnpm --filter @freemodelfinder/core test
pnpm --filter @freemodelfinder/server test
pnpm --filter @freemodelfinder/ui test
```

Expected: 全 PASS（覆盖率阈值在 `pnpm test:coverage` 强制；本地至少跑单包 test）。

- [ ] **Step 3: lint 改动面**

```powershell
npx eslint "packages/core/src/**/*.ts" "packages/server/src/**/*.ts" "packages/ui/app/**/*.{ts,tsx}" --max-warnings=0
```

Expected: PASS（零警告）。

- [ ] **Step 4: 最终提交（若有未提交改动）**

```powershell
git status --short
# 若有残留：
git add -A
git commit -m "chore: auto-route multi-model follow-ups"
```

**提醒用户：** 修改已完成，是否推送到 GitHub 由你决定（按约定不自动 push）。

---

## Self-Review

1. **Spec coverage**
   - 5 项多选类型 `string[]` → Task 1、2、6
   - `asModelList` 兼容 → Task 1、2、3
   - 每档独立轮询 Map → Task 3
   - 本地 model-options + 不打厂商 → Task 4（含 `listAllModels` spy=0）
   - 能力过滤 → Task 5 `matchesFilter`
   - 离线已选仍显示 → Task 5 `missing`
   - 空数组清空 / 显式 undefined 保留 → Task 2 POST
   - UI 测试数组 payload / 过滤 / 清空 / model-options → Task 7
   - 文本三档独立游标 → Task 3 测试（simple vs image slot）

2. **Placeholder scan** — 无 TBD/TODO；Task 6 Step 4 label 形式给了明确简化决策（`label={tier.label}`）。

3. **Type consistency**
   - `asModelList` 于 core/server/ui 一致命名
   - `ModelOption` / `model-options` 字段 `id|provider|displayName|capabilities`
   - 轮询 slot key：`image` / `video` / `text:simple|medium|complex`
   - composed custom id：`custom:<sourceId>:<modelId>` 与 `custom.ts` 一致
