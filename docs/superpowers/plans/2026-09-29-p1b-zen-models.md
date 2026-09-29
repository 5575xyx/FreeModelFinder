# P1-B：Zen 模型发现、定价与路由 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@freemodelfinder/zen` 中落地 opencode2api 的 `internal/models` 能力：Zen/Go 双 tier 的模型目录、按模型的原生协议归属、models.dev 定价与匿名资格判定、`Route()` 路由决策，以及目录/定价的磁盘缓存。

**Architecture:** 沿用 P1-A 的包结构，新增 `packages/zen/src/models/`。`ZenCatalog` 持有双 tier 的模型集合、原生协议、能力元数据与覆盖配置；`ZenPricingStore` 负责 models.dev 抓取与「是否免费/弃用」判定；`models/discovery.ts` 负责从 `/v1/models`、`models.opencode.ai/api.json` 与官方文档推断协议；`models/cache.ts` 提供原子化 JSON 缓存读写。本阶段仍是纯逻辑 + 注入式 `fetchImpl`，不依赖 core。

**Tech Stack:** TypeScript、zod v3（复用 P1-A 的 `ZenConfig` 类型）、Node.js 内置 test runner（`node --test` + `tsx`）。

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-zen-integration-design.md`（「路由与通道状态机」「模型发现与定价」节）

---

## 关键背景（执行前必读）

1. **协议类型来源**：`ZenNativeProtocol = 'chat' | 'responses' | 'anthropic'` 已在 `packages/zen/src/config/index.ts` 定义（zod enum `NativeProtocolSchema`）。`models/` 直接 `import type { ZenNativeProtocol } from '../config/index.js'`（models → config，无环）。
2. **tier 类型**：`ZenTier = 'zen' | 'go'`，本阶段新增于 `models/types.ts`。注意 config 的 `prefer` 是 `'go' | 'zen'`，两者兼容。
3. **本阶段不做网络实时调用**：`discovery`/`pricing` 的所有抓取函数都接收注入的 `fetchImpl`（签名同 `typeof fetch`），测试用假实现喂固定 JSON。真正的定时刷新编排属于 P1-D 的 `gateway/refresh.ts`。
4. **磁盘缓存**：`models/cache.ts` 提供通用原子 JSON 缓存读写；具体文件名（`<configPath>.models.catalog.json` / `.models.dev.json`）由 P1-D 决定。
5. **测试放 `packages/zen/src/__tests__/*.test.ts`**（扁平，与 P1-A 一致），文件名前缀 `models-`。
6. **TS strict + `noUncheckedIndexedAccess`**；不加行尾注释；不推送；**只 `git add` 本任务列出的文件，绝不 `git add -A`**。

## 文件结构（P1-B）

| 文件                                   | 职责                                                                                                     | 任务   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| `packages/zen/src/models/types.ts`     | `ZenTier` / `ZenRoute` / `ZenModelMetadata` / `AnonymousDecision` / `CatalogSnapshot` / `PricingDecider` | B1     |
| `packages/zen/src/models/catalog.ts`   | `ZenCatalog`：状态、替换、列表、快照、支持判定、元数据；`Route()` 与其辅助                               | B1、B2 |
| `packages/zen/src/models/pricing.ts`   | `ZenPricingStore`：models.dev 抓取/解码/`decide`/`price`/`snapshot`/缓存                                 | B3     |
| `packages/zen/src/models/discovery.ts` | `/v1/models`、`models.opencode.ai/api.json`、文档协议回退、metadata                                      | B4     |
| `packages/zen/src/models/cache.ts`     | 原子 JSON 缓存读写                                                                                       | B5     |
| `packages/zen/src/index.ts`            | barrel 追加 `models/*`                                                                                   | B5     |

---

### Task B1: 路由类型与 ZenCatalog 骨架

**Files:**

- Create: `packages/zen/src/models/types.ts`
- Create: `packages/zen/src/models/catalog.ts`
- Test: `packages/zen/src/__tests__/models-catalog.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/models-catalog.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenCatalog } from '../models/catalog.js';

function catalog(): ZenCatalog {
  const c = new ZenCatalog('go', {});
  c.replace({
    zen: ['m-free', 'shared'],
    go: ['shared', 'go-only'],
    native: {
      zen: { 'm-free': 'chat', shared: 'anthropic' },
      go: { shared: 'chat', 'go-only': 'responses' },
    },
    unsupported: { zen: {}, go: {} },
    metadata: {
      zen: { 'm-free': { contextWindow: 1000, reasoning: true } },
      go: {},
    },
  });
  return c;
}

describe('zen catalog state', () => {
  it('lists the union of both tiers sorted', () => {
    assert.deepEqual(catalog().list(), ['go-only', 'm-free', 'shared']);
  });

  it('reports availability via supported()', () => {
    const c = catalog();
    assert.equal(c.supported('shared'), true);
    assert.equal(c.supported('missing'), false);
  });

  it('snapshots counts', () => {
    const snap = catalog().snapshot();
    assert.equal(snap.zen, 2);
    assert.equal(snap.go, 2);
    assert.equal(snap.total, 3);
    assert.equal(snap.stale, false);
  });

  it('exposes per-tier metadata', () => {
    const c = catalog();
    assert.equal(c.metadataForTier('m-free', 'zen')?.contextWindow, 1000);
    assert.equal(c.metadataForTier('m-free', 'go')?.contextWindow, undefined);
  });

  it('marks a tier unsupported when the protocol is unknown', () => {
    const c = new ZenCatalog('zen', {});
    c.replace({
      zen: ['x'],
      go: [],
      native: { zen: {}, go: {} },
      unsupported: { zen: { x: true }, go: {} },
      metadata: { zen: {}, go: {} },
    });
    assert.equal(c.supported('x'), false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— `../models/catalog.js` 不存在。

- [ ] **Step 3: 实现类型**

新建 `packages/zen/src/models/types.ts`：

```ts
import type { ZenNativeProtocol } from '../config/index.js';

export type ZenTier = 'zen' | 'go';

export interface ZenModelMetadata {
  contextWindow?: number;
  maxInput?: number;
  maxOutput?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
}

export interface ZenRoute {
  id: string;
  tier: ZenTier;
  protocol: ZenNativeProtocol;
  protocols: Partial<Record<ZenTier, ZenNativeProtocol>>;
  anonymous: boolean;
  keyTiers: ZenTier[];
}

export interface AnonymousDecision {
  allowed: boolean;
  source: string;
  known: boolean;
  deprecated: boolean;
  inputCost?: number;
  outputCost?: number;
}

export interface CatalogSnapshot {
  zen: number;
  go: number;
  total: number;
  exposed: number;
  updatedAt?: number;
  cacheSource: string;
  stale: boolean;
}

export interface PricingDecider {
  decide(model: string): AnonymousDecision;
}

export interface CatalogCapabilities {
  zen?: string[];
  go?: string[];
  native?: Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>>;
  unsupported?: Partial<Record<ZenTier, Record<string, boolean>>>;
  metadata?: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>>;
}

export const TIERS: ZenTier[] = ['zen', 'go'];
```

- [ ] **Step 4: 实现 ZenCatalog 骨架**

新建 `packages/zen/src/models/catalog.ts`：

```ts
import type { ZenNativeProtocol } from '../config/index.js';
import {
  TIERS,
  type AnonymousDecision,
  type CatalogCapabilities,
  type CatalogSnapshot,
  type PricingDecider,
  type ZenModelMetadata,
  type ZenRoute,
  type ZenTier,
} from './types.js';

const CHAT: ZenNativeProtocol = 'chat';

function toSet(items: string[] | undefined, fallback: Set<string>): Set<string> {
  return items === undefined ? fallback : new Set(items);
}

function cloneTierProtocols(
  source: Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>> | undefined,
): Record<ZenTier, Map<string, ZenNativeProtocol>> {
  const out: Record<ZenTier, Map<string, ZenNativeProtocol>> = { zen: new Map(), go: new Map() };
  for (const tier of TIERS) {
    const layer = source?.[tier];
    if (!layer) continue;
    for (const [model, protocol] of Object.entries(layer)) out[tier].set(model, protocol);
  }
  return out;
}

function cloneTierBooleans(
  source: Partial<Record<ZenTier, Record<string, boolean>>> | undefined,
): Record<ZenTier, Set<string>> {
  const out: Record<ZenTier, Set<string>> = { zen: new Set(), go: new Set() };
  for (const tier of TIERS) {
    const layer = source?.[tier];
    if (!layer) continue;
    for (const [model, value] of Object.entries(layer)) if (value) out[tier].add(model);
  }
  return out;
}

function cloneTierMetadata(
  source: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>> | undefined,
): Record<ZenTier, Map<string, ZenModelMetadata>> {
  const out: Record<ZenTier, Map<string, ZenModelMetadata>> = {
    zen: new Map(),
    go: new Map(),
  };
  for (const tier of TIERS) {
    const layer = source?.[tier];
    if (!layer) continue;
    for (const [model, md] of Object.entries(layer)) out[tier].set(model, md);
  }
  return out;
}

export class ZenCatalog {
  private zen = new Set<string>();
  private go = new Set<string>();
  private nativeProtocols = cloneTierProtocols(undefined);
  private unsupported = cloneTierBooleans(undefined);
  private metadata = cloneTierMetadata(undefined);
  private readonly overrides: Map<string, ZenNativeProtocol>;
  private pricing: PricingDecider | undefined;
  private cachePath = '';
  private cacheSource = 'none';
  private updatedAt = 0;
  private stale = false;
  private refreshAfterMs = 0;

  constructor(
    private readonly prefer: ZenTier,
    overrides: Record<string, ZenNativeProtocol>,
  ) {
    this.overrides = new Map(Object.entries(overrides));
  }

  setPricing(store: PricingDecider | undefined): void {
    this.pricing = store;
  }

  setCachePath(path: string): void {
    this.cachePath = path;
  }

  getCachePath(): string {
    return this.cachePath;
  }

  setRefreshIntervalMs(intervalMs: number): void {
    this.refreshAfterMs = intervalMs;
  }

  replace(capabilities: CatalogCapabilities): void {
    this.zen = toSet(capabilities.zen, this.zen);
    this.go = toSet(capabilities.go, this.go);
    if (capabilities.native) this.nativeProtocols = cloneTierProtocols(capabilities.native);
    if (capabilities.unsupported) this.unsupported = cloneTierBooleans(capabilities.unsupported);
    if (capabilities.metadata) this.metadata = cloneTierMetadata(capabilities.metadata);
    this.updatedAt = Date.now();
    this.cacheSource = 'live';
    this.stale = false;
  }

  list(): string[] {
    const union = new Set<string>([...this.zen, ...this.go]);
    return [...union].filter((model) => this.supported(model)).sort();
  }

  supported(model: string): boolean {
    const pending = this.zen.size === 0 && this.go.size === 0;
    if (pending) return true;
    if (this.zen.has(model) && this.tierSupported(model, 'zen')) return true;
    if (this.go.has(model) && this.tierSupported(model, 'go')) return true;
    return false;
  }

  metadataForTier(model: string, tier: ZenTier): ZenModelMetadata | undefined {
    return this.metadata[tier].get(model);
  }

  snapshot(): CatalogSnapshot {
    const total = new Set<string>([...this.zen, ...this.go]).size;
    let exposed = 0;
    for (const model of new Set<string>([...this.zen, ...this.go])) {
      if (this.supported(model)) exposed += 1;
    }
    const stale =
      this.stale ||
      (this.updatedAt > 0 &&
        this.refreshAfterMs > 0 &&
        Date.now() - this.updatedAt > Math.max(2 * this.refreshAfterMs, 60_000));
    return {
      zen: this.zen.size,
      go: this.go.size,
      total,
      exposed,
      ...(this.updatedAt > 0 ? { updatedAt: this.updatedAt } : {}),
      cacheSource: this.cacheSource,
      stale,
    };
  }

  isFreeModel(model: string): boolean {
    return this.anonymousDecision(model).allowed;
  }

  anonymousDecision(model: string): AnonymousDecision {
    if (this.pricing) return this.pricing.decide(model);
    return {
      allowed: /free/i.test(model),
      source: 'name_fallback_metadata_pending',
      known: false,
      deprecated: false,
    };
  }

  protocolFor(model: string, tier: ZenTier): ZenNativeProtocol {
    const override = this.overrides.get(model);
    if (override) return override;
    const native = this.nativeProtocols[tier].get(model);
    if (native) return native;
    return CHAT;
  }

  private tierSupported(model: string, tier: ZenTier): boolean {
    if (this.overrides.has(model)) return true;
    if (this.unsupported[tier].has(model)) return false;
    if (this.nativeProtocols[tier].has(model)) return true;
    return this.zen.size === 0 && this.go.size === 0;
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/zen/src/models/types.ts packages/zen/src/models/catalog.ts packages/zen/src/__tests__/models-catalog.test.ts
git commit -m "feat(zen): 路由类型与 ZenCatalog 骨架"
```

---

### Task B2: `ZenCatalog.Route()` 与匿名资格

**Files:**

- Modify: `packages/zen/src/models/catalog.ts`
- Test: `packages/zen/src/__tests__/models-catalog.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `packages/zen/src/__tests__/models-catalog.test.ts` 追加：

```ts
import type { PricingDecider } from '../models/types.js';

function freeStore(free: string[]): PricingDecider {
  return {
    decide: (model: string) =>
      free.includes(model)
        ? {
            allowed: true,
            source: 'metadata_free',
            known: true,
            deprecated: false,
            inputCost: 0,
            outputCost: 0,
          }
        : {
            allowed: false,
            source: 'metadata_paid',
            known: true,
            deprecated: false,
            inputCost: 1,
            outputCost: 1,
          },
  };
}

describe('zen catalog routing', () => {
  it('routes a free model through the anonymous Zen lane', () => {
    const c = catalog();
    c.setPricing(freeStore(['m-free']));
    const route = c.route('m-free', true, true, true);
    assert.equal(route.anonymous, true);
    assert.equal(route.tier, 'zen');
    assert.equal(route.protocol, 'chat');
    assert.deepEqual(route.keyTiers, ['go', 'zen']);
  });

  it('routes a paid model through the preferred key tier', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    const route = c.route('shared', true, true, true);
    assert.equal(route.anonymous, false);
    assert.equal(route.tier, 'go');
    assert.equal(route.protocol, 'chat');
  });

  it('keeps per-tier protocols for cross-tier re-encoding', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    const route = c.route('shared', true, true, false);
    assert.equal(route.protocols.zen, 'anthropic');
    assert.equal(route.protocols.go, 'chat');
  });

  it('only builds a key route for tiers that can serve the model', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    const route = c.route('go-only', true, true, false);
    assert.deepEqual(route.keyTiers, ['go']);
    assert.equal(route.tier, 'go');
  });

  it('throws when no tier can serve the model', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    assert.throws(() => c.route('missing', true, true, false));
  });

  it('does not enter the anonymous lane when disabled', () => {
    const c = catalog();
    c.setPricing(freeStore(['m-free']));
    const route = c.route('m-free', true, true, false);
    assert.equal(route.anonymous, false);
  });

  it('honors a protocol override', () => {
    const c = new ZenCatalog('go', { 'm-free': 'responses' });
    c.replace({
      zen: ['m-free'],
      go: [],
      native: { zen: { 'm-free': 'chat' }, go: {} },
      unsupported: { zen: {}, go: {} },
      metadata: { zen: {}, go: {} },
    });
    c.setPricing(freeStore(['m-free']));
    assert.equal(c.route('m-free', true, false, true).protocol, 'responses');
  });

  it('routeForTier pins a single tier', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    const route = c.routeForTier('shared', 'zen', true, true);
    assert.equal(route.anonymous, false);
    assert.equal(route.tier, 'zen');
    assert.deepEqual(route.keyTiers, ['zen']);
    assert.equal(route.protocol, 'anthropic');
  });

  it('routeForTier rejects tiers without keys', () => {
    const c = catalog();
    c.setPricing(freeStore([]));
    assert.throws(() => c.routeForTier('shared', 'zen', false, true));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— `route` / `routeForTier` 不存在。

- [ ] **Step 3: 实现**

在 `packages/zen/src/models/catalog.ts` 的 `ZenCatalog` 内追加：

```ts
  route(model: string, hasZenKeys: boolean, hasGoKeys: boolean, hasAnonymous: boolean): ZenRoute {
    const keyTiers = this.keyTierOrder(model, hasZenKeys, hasGoKeys);
    const decision = this.anonymousDecision(model);
    const advertised = this.zen.size === 0 && this.go.size === 0
      ? true
      : this.zen.has(model) || this.go.has(model);
    if (
      hasAnonymous &&
      decision.allowed &&
      advertised &&
      (this.overrides.has(model) || !this.unsupported.zen.has(model))
    ) {
      const protocols = this.protocolsFor(model, keyTiers, true);
      return {
        id: model,
        tier: 'zen',
        protocol: protocols.zen ?? CHAT,
        protocols,
        anonymous: true,
        keyTiers,
      };
    }
    if (keyTiers.length > 0) {
      const protocols = this.protocolsFor(model, keyTiers, false);
      const primary = keyTiers[0] as ZenTier;
      return {
        id: model,
        tier: primary,
        protocol: protocols[primary] ?? CHAT,
        protocols,
        anonymous: false,
        keyTiers,
      };
    }
    throw new Error(`model "${model}" is not available in the configured Zen or Go pools`);
  }

  routeForTier(
    model: string,
    tier: ZenTier,
    hasZenKeys: boolean,
    hasGoKeys: boolean,
  ): ZenRoute {
    const hasKeys = tier === 'go' ? hasGoKeys : hasZenKeys;
    if (!hasKeys) throw new Error(`no ${tier} key is configured`);
    const advertised = this.zen.size === 0 && this.go.size === 0
      ? true
      : (tier === 'go' ? this.go.has(model) : this.zen.has(model));
    if (!advertised) {
      throw new Error(`model "${model}" is not available in the selected ${tier} key tier`);
    }
    if (!this.tierSupported(model, tier)) {
      throw new Error(`model "${model}" uses an upstream protocol unavailable on ${tier}`);
    }
    const protocol = this.protocolFor(model, tier);
    return {
      id: model,
      tier,
      protocol,
      protocols: { [tier]: protocol },
      anonymous: false,
      keyTiers: [tier],
    };
  }

  private keyTierOrder(model: string, hasZenKeys: boolean, hasGoKeys: boolean): ZenTier[] {
    const pending = this.zen.size === 0 && this.go.size === 0;
    const available = (tier: ZenTier): boolean => {
      if (tier === 'zen') {
        return hasZenKeys && (pending || this.zen.has(model)) && this.tierSupported(model, 'zen');
      }
      return hasGoKeys && (pending || this.go.has(model)) && this.tierSupported(model, 'go');
    };
    const order: ZenTier[] = this.prefer === 'go' ? ['go', 'zen'] : ['zen', 'go'];
    return order.filter(available);
  }

  private protocolsFor(
    model: string,
    keyTiers: ZenTier[],
    includeZen: boolean,
  ): Partial<Record<ZenTier, ZenNativeProtocol>> {
    const protocols: Partial<Record<ZenTier, ZenNativeProtocol>> = {};
    if (includeZen) protocols.zen = this.protocolFor(model, 'zen');
    for (const tier of keyTiers) protocols[tier] = this.protocolFor(model, tier);
    return protocols;
  }
```

> 注意 `tierSupported` 当前是 `private`；`routeForTier` 与 `keyTierOrder` 都是类内方法，可直接调用。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/models/catalog.ts packages/zen/src/__tests__/models-catalog.test.ts
git commit -m "feat(zen): ZenCatalog.Route 与匿名资格路由"
```

---

### Task B3: models.dev 定价与匿名资格

对应 `opencode2api/internal/models/pricing.go`。

**Files:**

- Create: `packages/zen/src/models/pricing.ts`
- Test: `packages/zen/src/__tests__/models-pricing.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/models-pricing.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenPricingStore, decodeModelsDev } from '../models/pricing.js';

const FIXTURE = {
  opencode: {
    id: 'opencode',
    models: {
      'free-by-cost': { id: 'free-by-cost', cost: { input: 0, output: 0 } },
      paid: { id: 'paid', cost: { input: 1, output: 2 } },
      unknown: { id: 'unknown' },
      dead: { id: 'dead', cost: { input: 0, output: 0 }, deprecated: true },
    },
  },
  other: {
    id: 'other',
    models: { nope: { id: 'nope', cost: { input: 0, output: 0 } } },
  },
};

describe('models.dev decoding', () => {
  it('prefers the opencode provider block', () => {
    const models = decodeModelsDev(FIXTURE);
    assert.ok(models['free-by-cost']);
    assert.equal(models['nope'], undefined);
  });

  it('treats zero cost and non-deprecated as anonymous-eligible', () => {
    const store = new ZenPricingStore();
    store.replace(decodeModelsDev(FIXTURE), Date.now());
    assert.equal(store.decide('free-by-cost').allowed, true);
    assert.equal(store.decide('paid').allowed, false);
    assert.equal(store.decide('unknown').allowed, false);
    assert.equal(store.decide('unknown').known, false);
    assert.equal(store.decide('dead').allowed, false);
    assert.equal(store.decide('dead').deprecated, true);
  });

  it('falls back to the -free name convention before metadata arrives', () => {
    const store = new ZenPricingStore();
    assert.equal(store.decide('something-free').allowed, true);
    assert.equal(store.decide('something-free').source, 'metadata_pending');
    assert.equal(store.decide('something-paid').allowed, false);
  });

  it('reports a snapshot', () => {
    const store = new ZenPricingStore();
    store.replace(decodeModelsDev(FIXTURE), Date.now());
    const snap = store.snapshot();
    assert.equal(snap.ready, true);
    assert.equal(snap.models, 4);
    assert.equal(snap.stale, false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/models/pricing.ts`：

```ts
import type { AnonymousDecision, PricingDecider } from './types.js';

export interface ZenPrice {
  id: string;
  input?: number;
  output?: number;
  deprecated: boolean;
}

export interface PricingSnapshot {
  ready: boolean;
  models: number;
  updatedAt?: number;
  stale: boolean;
  lastError?: string;
}

const MODELS_DEV_REFRESH_MS = 24 * 60 * 60 * 1000;

function numberAt(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isDeprecated(model: Record<string, unknown>): boolean {
  if (model['deprecated'] === true) return true;
  const status = String(model['status'] ?? model['lifecycle'] ?? '').toLowerCase();
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true;
  return model['deprecated_at'] != null || model['retirement_date'] != null;
}

function providerRank(key: string): number {
  const lower = key.toLowerCase();
  if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0;
  if (lower.includes('opencode')) return 1;
  return 2;
}

export function decodeModelsDev(data: unknown): Record<string, ZenPrice> {
  const providers = asRecord(data);
  if (!providers) throw new Error('models.dev payload is not an object');
  const keys = Object.keys(providers).sort((a, b) => {
    const rank = providerRank(a) - providerRank(b);
    return rank !== 0 ? rank : a.localeCompare(b);
  });
  for (const key of keys) {
    const rank = providerRank(key);
    if (rank > 1) continue;
    const provider = asRecord(providers[key]);
    if (!provider) continue;
    if (rank === 1) {
      const identity = String(provider['id'] ?? provider['name'] ?? '').toLowerCase();
      if (!identity.includes('opencode')) continue;
    }
    const models = asRecord(provider['models']);
    if (!models) continue;
    const result: Record<string, ZenPrice> = {};
    for (const [id, raw] of Object.entries(models)) {
      const model = asRecord(raw) ?? {};
      const modelId = String(model['id'] ?? id);
      const cost = asRecord(model['cost']);
      result[modelId] = {
        id: modelId,
        ...(numberAt(cost, 'input') !== undefined ? { input: numberAt(cost, 'input') } : {}),
        ...(numberAt(cost, 'output') !== undefined ? { output: numberAt(cost, 'output') } : {}),
        deprecated: isDeprecated(model),
      };
    }
    if (Object.keys(result).length > 0) return result;
  }
  throw new Error('models.dev contains no OpenCode model metadata');
}

export class ZenPricingStore implements PricingDecider {
  private models: Record<string, ZenPrice> = {};
  private updatedAt = 0;
  private lastError = '';

  replace(models: Record<string, ZenPrice>, updatedAt: number): void {
    this.models = models;
    this.updatedAt = updatedAt;
    this.lastError = '';
  }

  price(model: string): ZenPrice | undefined {
    return this.models[model];
  }

  decide(model: string): AnonymousDecision {
    const ready = this.updatedAt > 0 && Object.keys(this.models).length > 0;
    const nameFree = /free/i.test(model);
    const fallback = (source: string): AnonymousDecision => ({
      allowed: nameFree,
      source,
      known: false,
      deprecated: false,
    });
    if (!ready) return fallback('metadata_pending');
    const price = this.models[model];
    if (!price) return fallback('metadata_model_missing');
    const decision: AnonymousDecision = {
      allowed: false,
      source: 'metadata_paid',
      known: true,
      deprecated: price.deprecated,
      ...(price.input !== undefined ? { inputCost: price.input } : {}),
      ...(price.output !== undefined ? { outputCost: price.output } : {}),
    };
    const metadataFree = !price.deprecated && price.input === 0 && price.output === 0;
    if (nameFree || metadataFree) {
      decision.allowed = true;
      decision.source =
        nameFree && metadataFree
          ? 'name_and_metadata_free'
          : nameFree
            ? 'name_free'
            : 'metadata_free';
      return decision;
    }
    if (price.deprecated) {
      decision.source = 'metadata_deprecated';
      return decision;
    }
    if (price.input === undefined || price.output === undefined) {
      decision.known = false;
      decision.source = 'metadata_cost_unknown';
    }
    return decision;
  }

  snapshot(now = Date.now()): PricingSnapshot {
    const ready = this.updatedAt > 0 && Object.keys(this.models).length > 0;
    return {
      ready,
      models: Object.keys(this.models).length,
      ...(this.updatedAt > 0 ? { updatedAt: this.updatedAt } : {}),
      stale: this.updatedAt > 0 && now - this.updatedAt > MODELS_DEV_REFRESH_MS,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/models/pricing.ts packages/zen/src/__tests__/models-pricing.test.ts
git commit -m "feat(zen): models.dev 定价与匿名资格判定"
```

---

### Task B4: 模型发现与协议推断

对应 `opencode2api/internal/models/discovery.go`。

**Files:**

- Create: `packages/zen/src/models/discovery.ts`
- Test: `packages/zen/src/__tests__/models-discovery.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/models-discovery.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  capabilityTier,
  fetchCapabilities,
  fetchModels,
  protocolForSdk,
} from '../models/discovery.js';

const CAPABILITIES = {
  opencode: {
    id: 'opencode',
    api: 'https://opencode.ai/zen/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      chatty: {
        id: 'chatty',
        limit: { context: 200000, output: 8192 },
        reasoning: true,
        tool_call: true,
      },
      anthropicish: { id: 'anthropicish', provider: { npm: '@ai-sdk/anthropic' } },
      responsey: { id: 'responsey', provider: { npm: '@ai-sdk/openai' } },
      weird: { id: 'weird', provider: { npm: '@ai-sdk/unknown' } },
    },
  },
  'opencode-go': {
    id: 'opencode-go',
    api: 'https://opencode.ai/zen/go/v1',
    npm: '@ai-sdk/openai-compatible',
    models: { gochat: { id: 'gochat' } },
  },
};

function fetchJson(payload: unknown) {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('zen protocol inference', () => {
  it('maps SDKs to native protocols', () => {
    assert.equal(protocolForSdk('@ai-sdk/openai-compatible'), 'chat');
    assert.equal(protocolForSdk('@ai-sdk/anthropic'), 'anthropic');
    assert.equal(protocolForSdk('@ai-sdk/openai'), 'responses');
    assert.equal(protocolForSdk('@ai-sdk/unknown'), undefined);
  });

  it('classifies tiers by provider id and api', () => {
    assert.equal(capabilityTier('opencode-go', ''), 'go');
    assert.equal(capabilityTier('opencode', 'https://opencode.ai/zen/v1'), 'zen');
    assert.equal(capabilityTier('other', ''), undefined);
  });

  it('reads /v1/models ids', async () => {
    const models = await fetchModels(
      'https://opencode.ai/zen',
      'public',
      fetchJson({ data: [{ id: 'a' }, { id: 'b' }] }),
    );
    assert.deepEqual(models, ['a', 'b']);
  });

  it('builds per-tier protocols, unsupported flags and metadata', async () => {
    const caps = await fetchCapabilities(
      {
        zen: 'https://models.opencode.ai/api.json',
        go: 'https://models.opencode.ai/api.json',
        zenDocs: 'https://docs/zen.mdx',
        goDocs: 'https://docs/go.mdx',
      },
      fetchJson(CAPABILITIES),
    );
    assert.equal(caps.native.zen?.['chatty'], 'chat');
    assert.equal(caps.native.zen?.['anthropicish'], 'anthropic');
    assert.equal(caps.native.zen?.['responsey'], 'responses');
    assert.equal(caps.unsupported.zen?.['weird'], true);
    assert.equal(caps.native.go?.['gochat'], 'chat');
    assert.equal(caps.metadata.zen?.['chatty']?.contextWindow, 200000);
    assert.equal(caps.metadata.zen?.['chatty']?.reasoning, true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/models/discovery.ts`：

```ts
import type { ZenNativeProtocol } from '../config/index.js';
import type { ZenModelMetadata, ZenTier } from './types.js';

export interface ZenCapabilities {
  native: Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>>;
  unsupported: Partial<Record<ZenTier, Record<string, boolean>>>;
  metadata: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>>;
}

export interface CapabilityEndpoints {
  zen: string;
  go: string;
  zenDocs?: string;
  goDocs?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function protocolForSdk(npm: string): ZenNativeProtocol | undefined {
  const value = npm.trim().toLowerCase();
  if (value.includes('anthropic')) return 'anthropic';
  if (value === '@ai-sdk/openai' || value.endsWith('/openai')) return 'responses';
  if (value.includes('openai-compatible')) return 'chat';
  return undefined;
}

export function capabilityTier(providerId: string, api: string): ZenTier | undefined {
  const value = `${providerId} ${api}`.toLowerCase();
  if (value.includes('opencode-go') || value.includes('/go/')) return 'go';
  if (value.includes('opencode') || value.includes('/zen/')) return 'zen';
  return undefined;
}

export async function fetchModels(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`models endpoint returned HTTP ${res.status}`);
  const payload = asRecord(await res.json());
  const data = Array.isArray(payload?.['data']) ? (payload?.['data'] as unknown[]) : [];
  const ids: string[] = [];
  for (const item of data) {
    const id = str(asRecord(item)?.['id']);
    if (id) ids.push(id);
  }
  if (ids.length === 0) throw new Error('models endpoint returned an empty list');
  return ids;
}

export async function fetchCapabilities(
  endpoints: CapabilityEndpoints,
  fetchImpl: typeof fetch,
): Promise<ZenCapabilities> {
  const res = await fetchImpl(endpoints.zen);
  if (!res.ok) throw new Error(`capability endpoint returned HTTP ${res.status}`);
  const providers = asRecord(await res.json());
  if (!providers) throw new Error('capability endpoint returned no providers');
  const result: ZenCapabilities = {
    native: { zen: {}, go: {} },
    unsupported: { zen: {}, go: {} },
    metadata: { zen: {}, go: {} },
  };
  for (const [providerId, raw] of Object.entries(providers)) {
    const provider = asRecord(raw);
    if (!provider) continue;
    const tier = capabilityTier(providerId, str(provider['api']) ?? '');
    if (!tier) continue;
    const providerNpm = str(provider['npm']) ?? '';
    const models = asRecord(provider['models']);
    if (!models) continue;
    for (const [modelKey, rawModel] of Object.entries(models)) {
      const model = asRecord(rawModel);
      if (!model) continue;
      const modelId = str(model['id']) ?? modelKey;
      const modelProvider = asRecord(model['provider']);
      const npm = str(modelProvider?.['npm']) ?? providerNpm;
      const protocol = protocolForSdk(npm);
      if (protocol) result.native[tier]![modelId] = protocol;
      else result.unsupported[tier]![modelId] = true;
      result.metadata[tier]![modelId] = metadataOf(model);
    }
  }
  return result;
}

function metadataOf(model: Record<string, unknown>): ZenModelMetadata {
  const limit = asRecord(model['limit']);
  const modalities = asRecord(model['modalities']);
  const input = Array.isArray(modalities?.['input'])
    ? (modalities?.['input'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  const output = Array.isArray(modalities?.['output'])
    ? (modalities?.['output'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  const md: ZenModelMetadata = {};
  const context = num(limit?.['context']);
  const maxInput = num(limit?.['input']);
  const maxOutput = num(limit?.['output']);
  if (context !== undefined) md.contextWindow = context;
  if (maxInput !== undefined) md.maxInput = maxInput;
  if (maxOutput !== undefined) md.maxOutput = maxOutput;
  if (model['reasoning'] === true) md.reasoning = true;
  if (model['tool_call'] === true) md.toolCall = true;
  if (model['structured_output'] === true) md.structuredOutput = true;
  if (input) md.inputModalities = input;
  if (output) md.outputModalities = output;
  return md;
}
```

> 「官方文档 `.mdx` 协议表回退」在 opencode2api 中是可选补充来源。本阶段先实现能力目录这一主来源；文档回退留作 P1-D 刷新编排的可选步骤（`endpoints.zenDocs/goDocs` 已预留字段）。请在提交信息中如实注明。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/models/discovery.ts packages/zen/src/__tests__/models-discovery.test.ts
git commit -m "feat(zen): 模型发现与协议推断（能力目录 + /v1/models）"
```

---

### Task B5: 磁盘缓存与包导出

**Files:**

- Create: `packages/zen/src/models/cache.ts`
- Modify: `packages/zen/src/index.ts`
- Test: `packages/zen/src/__tests__/models-cache.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/models-cache.test.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readJsonCache, writeJsonCache } from '../models/cache.js';

describe('zen json cache', () => {
  it('round-trips a payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-cache-'));
    try {
      const path = join(dir, 'catalog.json');
      await writeJsonCache(path, { updatedAt: 1, models: { a: true } });
      const loaded = await readJsonCache<{ updatedAt: number; models: Record<string, boolean> }>(
        path,
      );
      assert.deepEqual(loaded, { updatedAt: 1, models: { a: true } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a missing file', async () => {
    const loaded = await readJsonCache('/definitely/not/here/nope.json');
    assert.equal(loaded, undefined);
  });

  it('returns undefined for malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-cache-'));
    try {
      const path = join(dir, 'bad.json');
      await writeFile(path, '{ not json');
      assert.equal(await readJsonCache(path), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing cache file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-cache-'));
    try {
      const path = join(dir, 'over.json');
      await writeJsonCache(path, { v: 1 });
      await writeJsonCache(path, { v: 2 });
      assert.deepEqual(await readJsonCache(path), { v: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/models/cache.ts`：

```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJsonCache<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function writeJsonCache(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    await rename(temp, path);
  } catch {
    await rm(path, { force: true });
    await rename(temp, path);
  }
}
```

- [ ] **Step 4: 更新 barrel**

`packages/zen/src/index.ts` 追加：

```ts
export * from './models/types.js';
export * from './models/catalog.js';
export * from './models/pricing.js';
export * from './models/discovery.js';
export * from './models/cache.js';
```

> 若 `discovery.ts` 与 `models/types.ts` 之间存在同名导出（例如 `ZenCapabilities` 仅 discovery 有），先 `pnpm --filter @freemodelfinder/zen typecheck` 确认无歧义；有冲突则改为显式具名导出。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test && pnpm --filter @freemodelfinder/zen typecheck && pnpm --filter @freemodelfinder/zen build`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add packages/zen/src/models/cache.ts packages/zen/src/__tests__/models-cache.test.ts packages/zen/src/index.ts
git commit -m "feat(zen): 原子 JSON 缓存与 models 模块导出"
```

---

## 验收清单（P1-B）

- [ ] `pnpm --filter @freemodelfinder/zen test` 全绿
- [ ] `pnpm --filter @freemodelfinder/zen test:coverage` 达 85% lines / 74% branches
- [ ] `pnpm build:runtime`、`pnpm typecheck`、`pnpm lint` 通过
- [ ] 仅本计划列出的文件被提交

## 自查记录

1. **Spec 覆盖**：spec「模型发现与定价」节的 `models/catalog.ts`（Route/匿名资格/per-tier 协议）、`models/pricing.ts`（models.dev → 匿名资格）、`models/cache.ts`（磁盘缓存）由 B1–B5 落地；`models/discovery.ts` 的**能力目录 + `/v1/models`** 落地，**官方 `.mdx` 文档回退**明确延后到 P1-D（已在 B4 注明）。✅
2. **占位符扫描**：无 TBD/TODO；每个代码步骤给出完整代码。
3. **类型一致性**：`ZenTier`/`ZenRoute`/`AnonymousDecision`/`PricingDecider`（B1）被 B2/B3 复用；`ZenCapabilities`（B4）的 `native/unsupported/metadata` 形状与 `CatalogCapabilities`（B1）对齐（字段全 optional，`replace()` 直接接受）。
