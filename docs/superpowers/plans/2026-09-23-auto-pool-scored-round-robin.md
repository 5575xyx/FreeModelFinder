# Auto 打分池 + 轮询 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `model:"auto"` 文本兜底路径改为：按策略从全目录打分 → Top-3 池 → 进程内轮询 → 冷却成员实时跳过；`model:"default"` 保留 defaultModel 语义。

**Architecture:** 在 `ProviderRegistry.resolveModel` 的 `auto` 分支新增 `pickFromScoredPool()`，复用 `AutoRouter` 已有冷却状态 + `scoreModel` 打分；轮询游标为模块级 `Map`（与 server `modalityCursor` 同模式，进程内存）。响应附加 `fmf_auto_route` 可观测字段。

**Tech Stack:** TypeScript, Node test runner (tsx), Fastify

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `packages/core/src/registry.ts` | `resolveModel` auto 分支 + `pickFromScoredPool()` + 模块级 `autoPoolCursor` |
| `packages/core/src/registry/__tests__/registry.test.ts` | auto 池单测 |
| `packages/server/src/routes/openai.ts` | 响应附加 `fmf_auto_route`（仅 auto 文本路径命中池时） |
| `packages/server/src/routes/__tests__/auto-modality.test.ts` | 集成：连续两次 auto 请求轮询 + `fmf_auto_route` |

设计文档：`docs/superpowers/specs/2026-09-23-auto-pool-scored-round-robin-design.md`

---

### Task 1: RED — auto 打分池单测（失败测试先行）

**Files:**
- Modify: `packages/core/src/registry/__tests__/registry.test.ts`

**背景（给零上下文的实现者）：**
`resolveModel` 在 `packages/core/src/registry.ts:275`。当前 `auto` 分支（276-293）：
1. `defaultModel` 有效 → `resolveModel(defaultModel)`（**Task 2 会把这段移到 `default` 专用分支**）
2. 否则取 `modelsCache.models[0]`
3. 无缓存 → 抛错

本任务只写**最终行为**的测试（auto 打分池），此时它们会失败（RED）。

`ProviderRegistry` 构造：`new ProviderRegistry(config, loadModelSnapshot?)`。测试内通过
`const internals = registry as unknown as { instances: Map<ProviderId, BaseProvider> }`
注入 fake provider（参考现有 `filters paid entries` 用例，registry.test.ts:29-74）。

`scoreModel(m, strategy, profile)` 从 `../../router/auto-router.js` 导出。冷却状态在
`registry.getAutoRouter()` 上：`markRateLimited(model, provider, parsed)`、`isRateLimited(model)`、
`isProviderRateLimited(provider)`、`listAllModels` 走 `getProvider(id).listModels()`。

`AutoRouteSettings` 在 `types.ts`，`strategy: 'capability' | 'speed' | 'rate-limit'`，`enabled: boolean`。
打分池行为**不依赖** `enabled`（冷却过滤用 router 内部状态即可）。

**ModelInfo 形状**（`types.ts:80`）：`{ id, provider, displayName, free, capabilities?, contextWindow?, ... }`。

- [ ] **Step 1: 在 `registry.test.ts` 文件末尾追加测试块**

```ts
describe('ProviderRegistry auto scored pool', () => {
  function poolConfig(autoRoute?: AppConfig['autoRoute']): AppConfig {
    return {
      version: 1,
      port: 11435,
      providers: {
        openrouter: { enabled: true, credentials: { apiKey: 'k' } },
      },
      autoRoute,
    };
  }

  function catalogRegistry(models: ModelInfo[], autoRoute?: AppConfig['autoRoute']) {
    const registry = new ProviderRegistry(poolConfig(autoRoute));
    const fakeProvider = {
      id: 'openrouter' as const,
      displayName: 'Fake',
      listModels: async () => models,
    } as unknown as import('../../providers/base.js').BaseProvider;
    const internals = registry as unknown as {
      instances: Map<import('../../types.js').ProviderId, unknown>;
    };
    internals.instances.set('openrouter', fakeProvider);
    return registry;
  }

  const bigModel: ModelInfo = {
    id: 'big-70b',
    provider: 'openrouter',
    displayName: 'Big',
    free: true,
  };
  const smallModel: ModelInfo = {
    id: 'tiny-3b',
    provider: 'openrouter',
    displayName: 'Small',
    free: true,
  };
  const midModel: ModelInfo = {
    id: 'mid-14b',
    provider: 'openrouter',
    displayName: 'Mid',
    free: true,
  };

  async function fill(registry: ProviderRegistry, models: ModelInfo[]) {
    await registry.listAllModels(true);
  }

  it('round-robins the top-3 capability-scored models for auto', async () => {
    const registry = catalogRegistry([tinyModel, bigModel, midModel]);
    await fill(registry, [tinyModel, bigModel, midModel]);

    const picks: string[] = [];
    for (let i = 0; i < 3; i++) {
      picks.push(registry.resolveModel('auto').modelId);
    }
    // capability 打分: big-70b(95) > mid-14b(65) > tiny-3b(30)
    assert.deepEqual(picks, ['big-70b', 'mid-14b', 'tiny-3b']);
    // 第四次循环回第一个
    assert.equal(registry.resolveModel('auto').modelId, 'big-70b');
  });

  it('skips cooling-down members and shrinks the pool', async () => {
    const registry = catalogRegistry([tinyModel, bigModel, midModel]);
    await fill(registry, [tinyModel, bigModel, midModel]);
    const router = registry.getAutoRouter();
    router.markRateLimited('big-70b', 'openrouter', {
      isRateLimit: true,
      resetAt: Date.now() + 60_000,
      message: 'rpm',
    });
    // 池变为 [mid-14b, tiny-3b]，轮询在这两者间
    const a = registry.resolveModel('auto').modelId;
    const b = registry.resolveModel('auto').modelId;
    assert.notEqual(a, b);
    assert.ok(a === 'mid-14b' || a === 'tiny-3b');
    assert.ok(b === 'mid-14b' || b === 'tiny-3b');
  });

  it('falls back to the first catalog model when the whole pool is cooling', async () => {
    const registry = catalogRegistry([tinyModel, bigModel, midModel]);
    await fill(registry, [tinyModel, bigModel, midModel]);
    const router = registry.getAutoRouter();
    for (const m of [bigModel, midModel, tinyModel]) {
      router.markRateLimited(m.id, 'openrouter', {
        isRateLimit: true,
        resetAt: Date.now() + 60_000,
        message: 'rpm',
      });
    }
    // 全池冷却 → 兜底第一个可用模型（目录顺序首项）
    assert.equal(registry.resolveModel('auto').modelId, tinyModel.id);
  });

  it('recomputes the pool per strategy', async () => {
    const registry = catalogRegistry([tinyModel, bigModel, midModel], {
      enabled: false,
      strategy: 'speed',
    } as AppConfig['autoRoute']);
    await fill(registry, [tinyModel, bigModel, midModel]);
    // speed: tiny-3b(78: 3b) > mid-14b(65) > big-70b(35: 70b)
    assert.equal(registry.resolveModel('auto').modelId, tinyModel.id);
  });
});
```

注意：若 `noUncheckedIndexedAccess` 导致 `picks` 等告警，按仓库风格调整；`resolveModel` 返回的是
`{ provider, modelId }`，`modelId` 即裸模型 id。

`defaultModel` 相关的回归（`default` 语义）在 Task 2 一并写。

- [ ] **Step 2: 运行确认 RED**

```powershell
pnpm --filter @freemodelfinder/core test
```
预期：4 个新用例 FAIL（auto 仍走第一个模型 `tiny-3b`，轮询/打分/跳过行为未实现），既有 148 用例不变。

- [ ] **Step 3: 提交测试（TDD 记录点）**

```powershell
git add packages/core/src/registry/__tests__/registry.test.ts
git commit -m "test(core): auto scored pool expectations (red)"
```

---

### Task 2: GREEN — resolveModel auto 打分池 + default 语义拆分

**Files:**
- Modify: `packages/core/src/registry.ts`（`resolveModel` 275-293 + 新增方法与模块级游标）
- Modify: `packages/core/src/registry/__tests__/registry.test.ts`（补 `default` 回归用例 + auto 池游标重置辅助）

**实现设计：**

1. 模块级游标（放在 `resolveModel` 附近、类外）：

```ts
const autoPoolCursor = 0; // 见下方实现
```

实际用一个模块级 `let` 不够（多 registry 共享会串），但 YAGNI：进程内所有 gateway 共用一个池游标是**期望行为**（轮询跨请求分布）。放模块级变量：

```ts
let autoPoolCursor = 0;

export function resetAutoPoolCursor(): void {
  autoPoolCursor = 0;
}
```

2. 类内新增私有方法：

```ts
/**
 * auto 文本兜底：按策略给可用模型打分，取 Top-3 池，池内轮询，
 * 冷却成员实时跳过。池全冷却/无缓存 → 回退目录首项（现状兜底）。
 */
private pickFromScoredPool(): { provider: BaseProvider; modelId: string } | null {
  const cached = this.modelsCache?.models;
  if (!cached || cached.length === 0) return null;
  const strategy = this.autoRouter.getStrategy();
  const cooldown = this.autoRouter;
  const candidates = cached.filter((m) => {
    if (cooldown.isProviderRateLimited(m.provider)) return false;
    if (cooldown.isRateLimited(m.id) || cooldown.isRateLimited(`${m.provider}:${m.id}`)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((m) => ({ m, s: scoreModel(m, strategy, this.autoRouter.getProfile(m.id)) }))
    .sort(
      (a, b) => b.s - a.s || a.m.id.localeCompare(b.m.id), // 同分按 id 稳定排序
    );
  const pool = scored.slice(0, 3);
  for (let i = 0; i < pool.length; i++) {
    const idx = (autoPoolCursor + i) % pool.length;
    const pick = pool[idx]!;
    autoPoolCursor = (idx + 1) % pool.length;
    return { provider: this.getProvider(pick.m.provider), modelId: pick.m.id };
  }
  return null;
}
```

⚠️ 修正：上面的循环"取出即返回"无法实现"冷却成员跳过"（因为冷却已在 filter 排除，其实 filter 就是实时跳过——冷却中的模型根本进不了候选）。所以循环只需要 `i=0`：`const pick = pool[autoPoolCursor % pool.length]`。把循环简化为：

```ts
const pick = pool[autoPoolCursor % pool.length]!;
autoPoolCursor = (autoPoolCursor + 1) % pool.length;
return { provider: this.getProvider(pick.m.provider), modelId: pick.m.id };
```

3. `resolveModel` 的 auto/default 分支重写（替换 276-293）：

```ts
if (modelId === 'auto' || modelId === 'default') {
  if (modelId === 'default') {
    const preferred = this.config.defaultModel;
    if (preferred && preferred !== 'auto' && preferred !== 'default') {
      return this.resolveModel(preferred);
    }
  }
  const enabled = this.listEnabledProviders();
  if (enabled.length === 0) {
    throw new Error('no provider is configured; add an API key in Settings first');
  }
  if (modelId === 'auto') {
    const picked = this.pickFromScoredPool();
    if (picked) return picked;
  }
  const cached = this.modelsCache?.models;
  if (cached && cached.length > 0) {
    const first = cached[0]!;
    return { provider: this.getProvider(first.provider), modelId: first.id };
  }
  throw new Error(
    'no default model available; set a default model or wait for /v1/models to load',
  );
}
```

语义总结：
- `default` → defaultModel 优先，否则第一兜底（与现状一致，只是不再碰打分池）
- `auto` → 打分池轮询优先，池空/无缓存 → 第一兜底（现状兜底保留）
- 注意：`auto` **不再**优先 defaultModel（设计决策：auto 纯打分轮询）

4. `registry.ts` 顶部 import `scoreModel`：`import { AutoRouter, parseRateLimitError, scoreModel } from './router/auto-router.js';`
   确认 `scoreModel` 已从 `router/auto-router.js` 导出（已导出，auto-router.ts:139）。

5. 测试游标污染防护：模块级 `autoPoolCursor` 跨用例共享。在每个新用例开头调用 `resetAutoPoolCursor()`；把该函数从 `registry.js` 导出并在测试中导入。

- [ ] **Step 1: 在 `registry.test.ts` 的 auto pool describe 内每个 it 开头加 `resetAutoPoolCursor();`，并 import**

```ts
import { ProviderRegistry, resetAutoPoolCursor } from '../../registry.js';
```
并在 `registry.ts` 导出 `resetAutoPoolCursor`。

- [ ] **Step 2: 追加 `default` 回归用例**

```ts
it('default resolves defaultModel first (regression)', async () => {
  const registry = catalogRegistry([tinyModel, bigModel], undefined);
  // 通过 updateConfig 或直接构造 config 时设置 defaultModel
  registry.updateConfig({
    ...registry.getConfig(),
    defaultModel: 'openrouter:big-70b',
  });
  await fill(registry, [tinyModel, bigModel]);
  assert.equal(registry.resolveModel('default').modelId, 'big-70b');
  resetAutoPoolCursor();
  // auto 不受 defaultModel 影响，走打分池
  assert.equal(registry.resolveModel('auto').modelId, 'big-70b'); // capability 最高分
});
```

- [ ] **Step 3: 实现（按上面 1-4 的代码改 `registry.ts`）**

- [ ] **Step 4: 运行全量 core 测试**

```powershell
pnpm --filter @freemodelfinder/core test
```
预期：全绿。若既有 `selectOnboardingModel` 等用例因 `resolveModel` 变化失败，逐个分析（onboarding 有自己的 selectOnboardingModel，不应受影响）。

- [ ] **Step 5: 格式 + lint + 提交**

```powershell
npx prettier --write "packages/core/src/registry.ts" "packages/core/src/registry/__tests__/registry.test.ts"
npx eslint "packages/core/src/registry.ts" "packages/core/src/registry/__tests__/registry.test.ts" --max-warnings=0
git add packages/core/src/registry.ts packages/core/src/registry/__tests__/registry.test.ts
git commit -m "feat(core): auto resolves via strategy-scored top-3 pool with round-robin"
```

---

### Task 3: 集成 — auto 响应附加 fmf_auto_route + 轮询验证

**Files:**
- Modify: `packages/server/src/routes/openai.ts`（auto 文本路径 payload 附加字段）
- Modify: `packages/server/src/routes/__tests__/auto-modality.test.ts`（集成用例）

**设计：**
`openai.ts` 中 `chatReq.model === 'auto'` 且最终走**文本链路**（非 image/video）时，在成功响应的 payload 上附加：

```ts
if (originalModel === 'auto' && finalModel !== 'auto') {
  (payload as Record<string, unknown>).fmf_auto_route = {
    picked: finalModel,
    strategy: reg.getAutoRouter().getStrategy(),
  };
}
```

⚠️ 不要改 `dispatchWithAutoRoute` 内部（它已处理 429 切换）。只在 auto 文本路径的**非流式成功响应**（约 openai.ts:513-536）和**流式 chunk**（`streamChunkToOpenAI` 的包装处）附加。流式 chunk 已有 `fmf_route_notices` 附加模式可参考（同文件 523-525 与流式分支对应处）。

实现要点：在 handler 入口记录 `const originalModel = chatReq.model;`（模态路由会改写它，但模态命中后走 image/video 分支，不会到文本链路，所以文本链路里 originalModel 仍为 auto）。

**测试**（auto-modality.test.ts 追加，复用现有 `withApp` fixture；注意该文件 registry 的 `listAllModels` 是固定的 options.models，模型带 capabilities 时打分有差异——用 3 个无 capabilities 模型测试轮询即可，池序按同分 id 稳定排序）：

```ts
it('auto text request round-robins across the scored pool and reports fmf_auto_route', async () => {
  await withApp(
    {
      autoRoute: { enabled: false, strategy: 'capability' },
      models: [textOnlyModel, capabilityImageModel, {
        id: 'another-text-1',
        provider: 'custom',
        displayName: 'Another',
        free: true,
      }],
    },
    async (app) => {
      resetModalityCursors?.(); // 若无此辅助则跳过；本用例不涉模态
      const post = async () =>
        (
          await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            payload: { model: 'auto', messages: [textMsg('你好')], stream: false },
          })
        ).json();
      const r1 = await post();
      const r2 = await post();
      assert.ok(r1.fmf_auto_route, 'fmf_auto_route present on first');
      assert.ok(r2.fmf_auto_route, 'fmf_auto_route present on second');
      assert.notEqual(r1.model, r2.model, 'consecutive auto picks differ');
      assert.equal(r1.fmf_auto_route.strategy, 'capability');
    },
  );
});
```

注意：
- `你好` 是纯文本（不触发模态分支）
- 该 fixture 的 resolveModel 被覆写为固定返回（modalityRegistry 里 `registry.resolveModel = ...`），需要在新用例中**不覆写** resolveModel 或改为委托真实实现：`registry.resolveModel = (id: string) => { if (id === 'auto' || id === 'default') return realResolve(id); ... }`。检查 `withApp`/`modalityRegistry` 是否强制覆写（registry.ts 现有 fixture 覆写了 resolveModel + listAllModels）——若覆写死，则本用例改用直接 `new ProviderRegistry` + `createServer({ registry })` 的新 fixture（参考 auto-route-round-robin.test.ts 的 `rrRegistry` 风格，保留真实 resolveModel，仅覆写 provider 实例）。
- 响应 `model` 字段在 payload 上是 `finalModel`（完整 `provider:model` 形式，见 openai.ts:522 `payload.model = finalModel`）。

- [ ] **Step 1: 先写集成测试（RED），按上面注意事项决定 fixture 风格，跑 `pnpm --filter @freemodelfinder/server test` 确认新用例 FAIL（无 fmf_auto_route）**

- [ ] **Step 2: 实现 openai.ts 附加逻辑（非流式 + 流式）**

- [ ] **Step 3: 全量验证**

```powershell
npx prettier --write "packages/server/src/routes/openai.ts" "packages/server/src/routes/__tests__/auto-modality.test.ts"
npx eslint "packages/server/src/routes/openai.ts" "packages/server/src/routes/__tests__/auto-modality.test.ts" --max-warnings=0
pnpm --filter @freemodelfinder/server test
pnpm --filter @freemodelfinder/core test
pnpm typecheck
```

- [ ] **Step 4: 提交**

```powershell
git add packages/server/src/routes/openai.ts packages/server/src/routes/__tests__/auto-modality.test.ts
git commit -m "feat(server): report fmf_auto_route on auto text picks"
```

---

### Task 4: 全量验证 + 冒烟

- [ ] **Step 1: 完整链路**

```powershell
pnpm build:runtime
pnpm typecheck
pnpm lint
pnpm --filter @freemodelfinder/core test
pnpm --filter @freemodelfinder/server test
pnpm --filter @freemodelfinder/ui test
```

- [ ] **Step 2: 冒烟（可选，需用户配合重启网关）**

重启网关后 `curl http://127.0.0.1:11435/v1/chat/completions -d '{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'` 连发 3 次，观察响应 model 在池内轮转、`fmf_auto_route` 字段存在。

## 自我审查

1. **Spec 覆盖**：打分池（Task 2）✓、Top-3 ✓、轮询 ✓、冷却跳过（filter 即跳过）✓、全冷却兜底 ✓、策略重算（每次现算）✓、fmf_auto_route（Task 3）✓、default 语义保留（Task 2 回归用例）✓、无缓存现状保留 ✓
2. **占位符**：无 TBD；Task 3 的 fixture 注意事项已给出两种路径的明确选择准则
3. **类型一致**：`pickFromScoredPool` 返回 `{ provider, modelId }` 与 resolveModel 返回形状一致；`resetAutoPoolCursor` 在 Task 2 定义并在测试中使用；`scoreModel(m, strategy, profile)` 签名与 auto-router.ts:139 一致
