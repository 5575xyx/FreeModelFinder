# 多 Key 管理 + Auto 图片模态路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页 Provider/自定义源支持掩码列表多 Key 增删；`model=auto` 识别文本图片意图并路由到生图模型。

**Architecture:** Part A 扩展 `GET /api/config` 返回 `keyMeta`（hint 不含明文），`POST /api/providers` 增加 `appendKeys`/`removeKeyIndex`/`appendSourceKeys`/`removeSourceKey`；SettingsView 用草稿数组 + 立即删除。Part B 在 `openai.ts` 扩展 `detectRequestModality` 文本图片意图，`auto` 未配置 `imageModel` 时从 registry 自动发现生图模型。

**Tech Stack:** Fastify + TypeScript (server)、Next.js 16 + React (ui)、Node test runner (server)、Vitest (ui)

**Spec:** `docs/superpowers/specs/2026-09-23-multi-key-and-auto-modality-design.md`

**Notes:**
- 两部分独立，可按 Part 顺序执行；每 Task 结束跑对应测试。
- 不推送 GitHub；仅本地 commit（用户已要求勿擅自 push）。
- 验证命令：`npx prettier --write <files>` → `npx eslint <files> --max-warnings=0` → `pnpm --filter @freemodelfinder/server test` / `ui test` → 必要时 `pnpm typecheck`。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `packages/server/src/server.ts` | config `keyMeta`；POST append/remove |
| `packages/server/src/routes/openai.ts` | 图片文本意图 + auto 发现 imageModel |
| `packages/server/src/__tests__/server.test.ts` | Part A API 测试（或新文件 `multi-key.test.ts`） |
| `packages/server/src/routes/__tests__/auto-modality.test.ts` | Part B 路由测试（新建） |
| `packages/ui/app/components/SettingsView.tsx` | 多 Key UI |
| `packages/ui/app/i18n.tsx` | 文案 |
| `packages/ui/app/components/__tests__/settings.test.tsx` | UI 测试 |

---

# Part A — 多 Key 管理

## Task A1: keyMeta 工具 + GET /api/config

**Files:**
- Modify: `packages/server/src/server.ts`（`/api/config` ~463-527）

- [ ] **Step 1: 在 server.ts 顶部附近（helpers 区）加入 buildKeyMeta**

在 `activeGatewayKeys` 或其它 helper 旁添加：

```ts
function buildKeyMeta(keys: readonly string[]): Array<{ id: string; hint: string }> {
  return keys
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter((k) => !!k)
    .map((k, i) => ({
      id: `k${i}`,
      hint: `…${k.length >= 4 ? k.slice(-4) : k.length >= 2 ? k.slice(-2) : k}`,
    }));
}

function providerKeyPool(cred: { apiKey?: string; apiKeys?: string[] } | undefined): string[] {
  const pool = cred?.apiKeys?.filter((k) => !!k?.trim()) ?? [];
  if (pool.length) return pool;
  return cred?.apiKey?.trim() ? [cred.apiKey.trim()] : [];
}

function sourceKeyPool(apiKey: string | string[] | undefined): string[] {
  if (Array.isArray(apiKey)) return apiKey.filter((k) => typeof k === 'string' && !!k.trim());
  return typeof apiKey === 'string' && apiKey.trim() ? [apiKey.trim()] : [];
}
```

- [ ] **Step 2: providers map 增加 keyMeta**

将 `server.ts` ~507-518 改为：

```ts
providers: Object.fromEntries(
  Object.entries(cfg.providers).map(([id, s]) => [
    id,
    {
      enabled: s?.enabled ?? false,
      hasKey: !!s?.credentials?.apiKey,
      keyCount:
        (s?.credentials?.apiKeys?.filter((k) => !!k?.trim()) ?? []).length ||
        (s?.credentials?.apiKey ? 1 : 0),
      keyMeta: buildKeyMeta(providerKeyPool(s?.credentials)),
      credentialError: s?.credentialError,
    },
  ]),
),
```

- [ ] **Step 3: custom sources map 增加 keyMeta**

将 sources 映射（~481-490）改为：

```ts
? rawSources.map((s) => ({
    id: String(s.id ?? ''),
    label: s.label ?? '',
    baseUrl: String(s.baseUrl ?? ''),
    hasKey: !!(Array.isArray(s.apiKey)
      ? s.apiKey.some((x) => typeof x === 'string' && x)
      : s.apiKey),
    keyMeta: buildKeyMeta(sourceKeyPool(s.apiKey)),
    models: Array.isArray(s.models) ? s.models : [],
  }))
```

legacy default source 分支同样加：`keyMeta: buildKeyMeta(sourceKeyPool(legacyHasKey ? custom?.credentials?.apiKey : undefined))`——legacy 单 key 时用 `buildKeyMeta([custom.credentials.apiKey ?? ''])` 或直接：

```ts
keyMeta: legacyHasKey ? buildKeyMeta([custom.credentials?.apiKey ?? '']) : [],
```

- [ ] **Step 4: 写失败测试** `packages/server/src/__tests__/multi-key.test.ts`

```ts
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ProviderRegistry, type AppConfig } from '@freemodelfinder/core';
import { createServer } from '../server.js';

const localUiHeaders = {
  origin: 'http://127.0.0.1:11435',
  'x-fmf-client': 'ui',
};

function testConfig(): AppConfig {
  return {
    version: 2,
    port: 11435,
    providers: {
      openrouter: {
        enabled: true,
        credentials: {
          apiKey: 'sk-first-aaaa',
          apiKeys: ['sk-first-aaaa', 'sk-second-bbbb'],
        },
      },
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
                apiKey: ['src-one-1111', 'src-two-2222'],
                models: [{ id: 'fixture-model' }],
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

function fakeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry(testConfig());
  registry.listAllModels = async () => ({
    models: [
      {
        id: 'fixture-model',
        provider: 'custom' as const,
        displayName: 'Fixture Model',
        free: true,
      },
    ],
    succeededProviders: ['custom' as const],
    failedProviders: [],
  });
  registry.resolveModel = () => {
    throw new Error('unused');
  };
  return registry;
}

describe('multi-key management', () => {
  let app: FastifyInstance;
  let uiDir: string;

  before(async () => {
    uiDir = await mkdtemp(join(tmpdir(), 'freemodelfinder-ui-'));
    await mkdir(join(uiDir, '_next', 'static'), { recursive: true });
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>FreeModelFinder</title>');
    await writeFile(join(uiDir, '_next', 'static', 'app.js'), 'globalThis.__fmf = true;');
    ({ app } = await createServer({
      registry: fakeRegistry(),
      uiDir,
      watchIntervalMs: 60 * 60 * 1000,
    }));
  });

  after(async () => {
    await app?.close();
    await rm(uiDir, { recursive: true, force: true });
  });

  it('returns keyMeta hints without plaintext', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const meta = body.providers.openrouter.keyMeta;
    assert.equal(meta.length, 2);
    assert.equal(meta[0].id, 'k0');
    assert.equal(meta[0].hint, '…aaaa');
    assert.equal(meta[1].hint, '…bbbb');
    assert.ok(!res.body.includes('sk-first-aaaa'));
    assert.ok(!res.body.includes('sk-second-bbbb'));
    const srcMeta = body.custom.sources[0].keyMeta;
    assert.equal(srcMeta.length, 2);
    assert.equal(srcMeta[0].hint, '…1111');
    assert.ok(!res.body.includes('src-one-1111'));
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`  
Expected: FAIL `keyMeta` undefined / length 不匹配

- [ ] **Step 6: 实现 Step 1-3 后重跑**

Run: `pnpm --filter @freemodelfinder/server test`  
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/__tests__/multi-key.test.ts
git commit -m "feat(server): expose keyMeta hints in /api/config"
```

---

## Task A2: POST appendKeys / removeKeyIndex

**Files:**
- Modify: `packages/server/src/server.ts` POST `/api/providers` ~536-720
- Test: `packages/server/src/__tests__/multi-key.test.ts`

- [ ] **Step 1: Body 类型增加字段**

```ts
app.post<{
  Body: {
    provider: string;
    apiKey?: string;
    apiKeys?: string[];
    enabled?: boolean;
    baseUrl?: string;
    clearCredentials?: boolean;
    appendKeys?: string[];
    removeKeyIndex?: number;
    models?: Array<{ id: string; displayName?: string; contextWindow?: number }>;
    sources?: Array<{
      id: string;
      label?: string;
      baseUrl: string;
      apiKey?: string;
      models?: Array<{ id: string; displayName?: string; contextWindow?: number }>;
    }>;
    appendSourceKeys?: { sourceId: string; keys: string[] };
    removeSourceKey?: { sourceId: string; index: number };
  };
}>('/api/providers', async (req, reply) => {
  const {
    provider,
    apiKey,
    apiKeys,
    enabled,
    baseUrl,
    clearCredentials,
    models,
    sources,
    appendKeys,
    removeKeyIndex,
    appendSourceKeys,
    removeSourceKey,
  } = req.body ?? {};
```

- [ ] **Step 2: 解析与校验（在 try updateConfig 之前）**

在 `cleanSources` 计算之后加入：

```ts
const cleanAppendKeys = Array.isArray(appendKeys)
  ? appendKeys.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => !!k)
  : undefined;
if (appendKeys !== undefined && (!cleanAppendKeys || cleanAppendKeys.length === 0)) {
  return reply.code(400).send({ error: 'appendKeys must be non-empty' });
}
if (
  removeKeyIndex !== undefined &&
  (typeof removeKeyIndex !== 'number' || !Number.isInteger(removeKeyIndex) || removeKeyIndex < 0)
) {
  return reply.code(400).send({ error: 'removeKeyIndex must be a non-negative integer' });
}
const appendSourceKeyList =
  appendSourceKeys && Array.isArray(appendSourceKeys.keys)
    ? appendSourceKeys.keys.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => !!k)
    : undefined;
if (
  appendSourceKeys !== undefined &&
  (typeof appendSourceKeys.sourceId !== 'string' || !appendSourceKeys.sourceId.trim() ||
    !appendSourceKeyList || appendSourceKeyList.length === 0)
) {
  return reply.code(400).send({ error: 'appendSourceKeys invalid' });
}
if (
  removeSourceKey !== undefined &&
  (typeof removeSourceKey.sourceId !== 'string' ||
    !removeSourceKey.sourceId.trim() ||
    typeof removeSourceKey.index !== 'number' ||
    !Number.isInteger(removeSourceKey.index) ||
    removeSourceKey.index < 0)
) {
  return reply.code(400).send({ error: 'removeSourceKey invalid' });
}

// Pre-validate index bounds against current config
const curCfg = getRegistry().getConfig();
if (removeKeyIndex !== undefined && providerId !== 'custom') {
  const pool = providerKeyPool(curCfg.providers[providerId]?.credentials);
  if (removeKeyIndex >= pool.length) {
    return reply.code(400).send({ error: 'removeKeyIndex out of range' });
  }
}
if (removeSourceKey || appendSourceKeys) {
  const customExtra = (curCfg.providers.custom?.credentials?.extra ?? {}) as {
    sources?: Array<{ id?: string; apiKey?: string | string[] }>;
  };
  const list = Array.isArray(customExtra.sources) ? customExtra.sources : [];
  const targetId = (removeSourceKey ?? appendSourceKeys)!.sourceId;
  const target = list.find((s) => s?.id === targetId);
  if (!target) return reply.code(404).send({ error: `unknown source: ${targetId}` });
  if (removeSourceKey && removeSourceKey.sourceId === targetId) {
    const pool = sourceKeyPool(target.apiKey);
    if (removeSourceKey.index >= pool.length) {
      return reply.code(400).send({ error: 'removeSourceKey index out of range' });
    }
  }
}
```

注意：`providerId` 在 `parsedProvider` 之后已有。若 `appendSourceKeys`/`removeSourceKey` 出现且 `provider !== 'custom'`，返回 400：`source key ops require provider "custom"`。

- [ ] **Step 3: 非 custom 分支应用 remove + append**

在非 custom 的 `nextApiKeys` 计算处（~695-700）改为：

```ts
let nextApiKeys =
  cleanApiKeys !== undefined
    ? cleanApiKeys
    : cleanApiKey
      ? [cleanApiKey]
      : cur.credentials?.apiKeys ??
        (cur.credentials?.apiKey ? [cur.credentials.apiKey] : undefined);
if (removeKeyIndex !== undefined && !shouldClear) {
  const base = nextApiKeys ?? providerKeyPool(cur.credentials);
  if (removeKeyIndex >= base.length) {
    return reply.code(400).send({ error: 'removeKeyIndex out of range' });
  }
  nextApiKeys = base.filter((_, i) => i !== removeKeyIndex);
}
if (cleanAppendKeys?.length && !shouldClear) {
  nextApiKeys = [...(nextApiKeys ?? []), ...cleanAppendKeys];
}
const nextKey = nextApiKeys?.[0] ?? cleanApiKey ?? '';
```

`shouldClear` 分支保持最高优先（clear 时忽略 append/remove）。

- [ ] **Step 4: custom 分支应用 source key ops（在 cleanSources 写入之后）**

在 `providerId === 'custom'` 块内、`if (cleanSources !== undefined) { nextExtra.sources = cleanSources; ...}` 之后：

```ts
if (removeSourceKey || appendSourceKeys) {
  const list = Array.isArray(nextExtra.sources)
    ? (nextExtra.sources as Array<{
        id: string;
        apiKey?: string | string[];
        label?: string;
        baseUrl: string;
        models?: Array<{ id: string }>;
      }>)
    : [];
  if (removeSourceKey) {
    const idx = list.findIndex((s) => s.id === removeSourceKey.sourceId);
    if (idx < 0) return reply.code(404).send({ error: 'unknown source' });
    const pool = sourceKeyPool(list[idx]?.apiKey);
    if (removeSourceKey.index >= pool.length) {
      return reply.code(400).send({ error: 'removeSourceKey index out of range' });
    }
    const nextPool = pool.filter((_, i) => i !== removeSourceKey.index);
    if (nextPool.length === 0) delete list[idx]!.apiKey;
    else list[idx]!.apiKey = nextPool.length === 1 ? nextPool[0] : nextPool;
    nextExtra.sources = list;
  }
  if (appendSourceKeys) {
    const idx = list.findIndex((s) => s.id === appendSourceKeys.sourceId);
    if (idx < 0) return reply.code(404).send({ error: 'unknown source' });
    const pool = [...sourceKeyPool(list[idx]?.apiKey), ...appendSourceKeyList!];
    list[idx]!.apiKey = pool.length === 1 ? pool[0] : pool;
    nextExtra.sources = list;
  }
}
```

注意：在 `updateConfig` 回调内 `return reply` 不合法——**越界须在回调外预校验**（Step 2 已做）。回调内若发现不一致（并发），可 throw 或跳过；以 Step 2 预校验为准，回调内只做 splice，不再 reply。

- [ ] **Step 5: 追加测试到 multi-key.test.ts**

```ts
  it('appends and removes provider keys', async () => {
    const append = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', appendKeys: ['sk-third-cccc'], enabled: true },
    });
    assert.equal(append.statusCode, 200);

    let cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().providers.openrouter.keyMeta.length, 3);
    assert.equal(cfg.json().providers.openrouter.keyMeta[2].hint, '…cccc');

    const empty = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', appendKeys: [] },
    });
    assert.equal(empty.statusCode, 400);

    const remove = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', removeKeyIndex: 0 },
    });
    assert.equal(remove.statusCode, 200);

    cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().providers.openrouter.keyMeta.length, 2);
    assert.equal(cfg.json().providers.openrouter.keyMeta[0].hint, '…bbbb');

    const oob = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'openrouter', removeKeyIndex: 99 },
    });
    assert.equal(oob.statusCode, 400);
  });

  it('appends and removes custom source keys', async () => {
    const append = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: {
        provider: 'custom',
        appendSourceKeys: { sourceId: 'fixture', keys: ['src-three-3333'] },
      },
    });
    assert.equal(append.statusCode, 200);

    let cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().custom.sources[0].keyMeta.length, 3);

    const remove = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localUiHeaders,
      payload: { provider: 'custom', removeSourceKey: { sourceId: 'fixture', index: 0 } },
    });
    assert.equal(remove.statusCode, 200);

    cfg = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: localUiHeaders,
    });
    assert.equal(cfg.json().custom.sources[0].keyMeta.length, 2);
    assert.ok(!cfg.body.includes('src-one-1111'));
  });
```

- [ ] **Step 6: 跑测试**

Run: `pnpm --filter @freemodelfinder/server test`  
Expected: PASS（含原有 server.test.ts）

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/__tests__/multi-key.test.ts
git commit -m "feat(server): append/remove API keys via providers API"
```

---

## Task A3: i18n 文案

**Files:**
- Modify: `packages/ui/app/i18n.tsx`

- [ ] **Step 1: 中文键替换/新增**（~309-330）

```ts
'settings.sources.pastePlaceholder': '粘贴 API Key',
'settings.sources.pasteExisting': '已保存的 Key（删除后立即生效）',
'settings.sources.addKey': '添加 Key',
'settings.sources.removeKey': '删除 Key {n}',
'settings.sources.keyRow': '已保存 Key {n}：{hint}',
'settings.custom.apiKeyExisting': '••••••••••（留空则保持不变）',
'settings.custom.apiKeyPlaceholder': '粘贴 API Key（本地无鉴权可留空）',
'settings.custom.addKey': '添加 Key',
'settings.custom.removeKey': '删除 Key {n}',
'settings.custom.keyRow': '已保存 Key {n}：{hint}',
```

注意：`pasteExisting` 若不再用于 placeholder（已存行改为列表），可保留给 aria/说明；UI 以 `keyRow` 为准。保留 `留空则保持不变` 以兼容 settings.test.tsx 的 `/留空则保持不变/`。

- [ ] **Step 2: 英文键对称修改**（~769-794）

```ts
'settings.sources.pastePlaceholder': 'Paste API key',
'settings.sources.pasteExisting': 'Saved keys (delete takes effect immediately)',
'settings.sources.addKey': 'Add key',
'settings.sources.removeKey': 'Remove key {n}',
'settings.sources.keyRow': 'Saved key {n}: {hint}',
'settings.custom.apiKeyExisting': '••••••••••  (leave empty to keep unchanged)',
'settings.custom.apiKeyPlaceholder': 'Paste API key (leave empty for local unauthenticated)',
'settings.custom.addKey': 'Add key',
'settings.custom.removeKey': 'Remove key {n}',
'settings.custom.keyRow': 'Saved key {n}: {hint}',
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/app/i18n.tsx
git commit -m "feat(ui): i18n for multi-key add/remove"
```

---

## Task A4: SettingsView Provider 多 Key UI

**Files:**
- Modify: `packages/ui/app/components/SettingsView.tsx`

- [ ] **Step 1: 类型与状态**

`ConfigRes.providers` 值类型增加：

```ts
keyMeta?: Array<{ id: string; hint: string }>;
```

`CustomSourceDef` 增加：

```ts
keyMeta?: Array<{ id: string; hint: string }>;
```

状态（替换/并存 `keys`）：

```ts
const [keyDrafts, setKeyDrafts] = useState<Record<string, string[]>>({});
const [srcKeyDrafts, setSrcKeyDrafts] = useState<Record<string, string[]>>({});
```

保留 `keys` 可逐步删除——本 Task 将 provider 输入改用 `keyDrafts`；若 `keys` 仅剩 save 使用，删掉 `keys`/`setKeys` 全部引用。

- [ ] **Step 2: 改 save() 为 appendKeys**

```ts
async function save(providerId: string) {
  const appendKeys = (keyDrafts[providerId] ?? [])
    .map((k) => k.trim())
    .filter(Boolean);
  if (!appendKeys.length) return;
  setSaveStates((s) => ({ ...s, [providerId]: 'saving' }));
  try {
    const res = await fetch(
      `${GATEWAY}/api/providers`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: providerId,
          appendKeys,
          enabled: true,
        }),
      }),
    );
    if (res.ok) {
      setToast({
        kind: 'success',
        text: t('settings.sources.savedToast', { provider: providerId }),
      });
      setKeyDrafts((d) => ({ ...d, [providerId]: [] }));
      setSaveStates((s) => ({ ...s, [providerId]: 'saved' }));
      setTimeout(() => setSaveStates((s) => ({ ...s, [providerId]: 'idle' })), 1600);
      fetch(`${GATEWAY}/api/config`, withUiHeaders())
        .then((r) => r.json())
        .then(setCfg);
      if (onModelsRefresh) {
        try {
          const refreshed = await onModelsRefresh();
          if (Array.isArray(refreshed)) {
            const hasProvider = refreshed.some((m) => m.provider === providerId);
            if (!hasProvider) {
              setToast({
                kind: 'error',
                text: t('settings.sources.savedNoModels', { provider: providerId }),
              });
            }
          }
        } catch {
          /* ignore refresh errors */
        }
      }
    } else {
      /* 保留现有错误 toast 逻辑 */
    }
  } catch (err) {
    /* 保留现有 catch toast 逻辑 */
  }
}
```

- [ ] **Step 3: 新增 removeProviderKey**

```ts
async function removeProviderKey(providerId: string, index: number) {
  setSaveStates((s) => ({ ...s, [providerId]: 'saving' }));
  try {
    const res = await fetch(
      `${GATEWAY}/api/providers`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: providerId, removeKeyIndex: index }),
      }),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fetch(`${GATEWAY}/api/config`, withUiHeaders())
      .then((r) => r.json())
      .then(setCfg);
    setSaveStates((s) => ({ ...s, [providerId]: 'idle' }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setToast({ kind: 'error', text: t('settings.sources.saveFailed', { provider: providerId, detail: `: ${msg}` }) });
    setSaveStates((s) => ({ ...s, [providerId]: 'idle' }));
  }
}
```

- [ ] **Step 4: 替换 renderCard 中输入区（~1630-1691）**

```tsx
<div className="flex flex-col gap-2">
  {(state?.keyMeta ?? []).map((row, idx) => (
    <div
      key={row.id}
      className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 px-2 py-1.5"
    >
      <code className="flex-1 truncate font-mono text-xs text-foreground">
        {row.hint}
      </code>
      <span className="sr-only">
        {t('settings.sources.keyRow', { n: idx + 1, hint: row.hint })}
      </span>
      <button
        type="button"
        onClick={() => void removeProviderKey(p.id, idx)}
        disabled={saveState === 'saving'}
        aria-label={t('settings.sources.removeKey', { n: idx + 1 })}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Trash2 size={13} strokeWidth={1.75} />
      </button>
    </div>
  ))}
  {(keyDrafts[p.id] ?? []).map((draft, di) => (
    <div key={`draft-${di}`} className="relative">
      <input
        type={isVisible ? 'text' : 'password'}
        className="w-full rounded-md border border-input bg-surface px-3 py-2 pr-9 font-mono text-sm text-foreground shadow-sm outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={t('settings.sources.pastePlaceholder')}
        value={draft}
        onChange={(e) =>
          setKeyDrafts((d) => {
            const list = [...(d[p.id] ?? [])];
            list[di] = e.target.value;
            return { ...d, [p.id]: list };
          })
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault();
            void save(p.id);
          }
        }}
        aria-label={t('settings.providerApiKeyAria', { provider: displayLabel })}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => ({ ...v, [p.id]: !v[p.id] }))}
        aria-label={isVisible ? t('settings.hideKey') : t('settings.showKey')}
        className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {isVisible ? <EyeOff size={13} strokeWidth={1.75} /> : <Eye size={13} strokeWidth={1.75} />}
      </button>
      <button
        type="button"
        onClick={() =>
          setKeyDrafts((d) => ({
            ...d,
            [p.id]: (d[p.id] ?? []).filter((_, i) => i !== di),
          }))
        }
        aria-label={t('settings.sources.removeKey', { n: (state?.keyMeta?.length ?? 0) + di + 1 })}
        className="absolute -right-8 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
      >
        <X size={13} strokeWidth={1.75} />
      </button>
    </div>
  ))}
  <div className="flex flex-wrap items-center gap-2">
    <button
      type="button"
      onClick={() =>
        setKeyDrafts((d) => ({ ...d, [p.id]: [...(d[p.id] ?? []), ''] }))
      }
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Plus size={12} strokeWidth={2} />
      {t('settings.sources.addKey')}
    </button>
    <button
      type="button"
      className={classNames(
        'inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        saveState === 'error'
          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          : saveState === 'saved'
            ? 'bg-success text-primary-foreground'
            : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
      )}
      onClick={() => void save(p.id)}
      disabled={!(keyDrafts[p.id] ?? []).some((k) => k.trim()) || saveState === 'saving'}
    >
      {saveState === 'saving' && <Loader2 size={13} strokeWidth={2} className="animate-spin" />}
      {saveState === 'saved' && <Check size={13} strokeWidth={2} />}
      {saveState === 'error' && <X size={13} strokeWidth={2} />}
      {saveState === 'saving'
        ? t('settings.sources.saving')
        : saveState === 'saved'
          ? t('settings.sources.saved')
          : saveState === 'error'
            ? t('settings.sources.retry')
            : t('settings.sources.save')}
    </button>
  </div>
</div>
```

布局可按原 `sm:flex-row` 调整；语义以掩码列表 + 添加 + 保存为准。

- [ ] **Step 5: 删除对旧 `keys` 的引用**

Grep `setKeys(` / `keys[p.id]` 清干净；`const [keys, setKeys] = ...` 删除。

- [ ] **Step 6: Commit**

```bash
git add packages/ui/app/components/SettingsView.tsx
git commit -m "feat(ui): provider multi-key mask list and add-key flow"
```

---

## Task A5: SettingsView Custom source 多 Key UI

**Files:**
- Modify: `packages/ui/app/components/SettingsView.tsx`

- [ ] **Step 1: source key 增删函数**

```ts
async function saveSourceDrafts(sourceId: string) {
  const append = (srcKeyDrafts[sourceId] ?? []).map((k) => k.trim()).filter(Boolean);
  if (!append.length) return;
  setCustomSaveState('saving');
  try {
    const res = await fetch(
      `${GATEWAY}/api/providers`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'custom',
          appendSourceKeys: { sourceId, keys: append },
        }),
      }),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSrcKeyDrafts((d) => ({ ...d, [sourceId]: [] }));
    setToast({ kind: 'success', text: t('settings.custom.saved') });
    const refreshed = await fetch(`${GATEWAY}/api/config`, withUiHeaders()).then(
      (r) => r.json() as Promise<ConfigRes>,
    );
    setCfg(refreshed);
    if (refreshed.custom?.sources) {
      setCustomSources(
        refreshed.custom.sources.map((s) => ({ ...s, apiKey: '', models: s.models ?? [] })),
      );
    }
    setCustomSaveState('saved');
    setTimeout(() => setCustomSaveState('idle'), 1600);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setToast({ kind: 'error', text: msg });
    setCustomSaveState('idle');
  }
}

async function removeSourceKey(sourceId: string, index: number) {
  setCustomSaveState('saving');
  try {
    const res = await fetch(
      `${GATEWAY}/api/providers`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'custom',
          removeSourceKey: { sourceId, index },
        }),
      }),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const refreshed = await fetch(`${GATEWAY}/api/config`, withUiHeaders()).then(
      (r) => r.json() as Promise<ConfigRes>,
    );
    setCfg(refreshed);
    if (refreshed.custom?.sources) {
      setCustomSources(
        refreshed.custom.sources.map((s) => ({ ...s, apiKey: '', models: s.models ?? [] })),
      );
    }
    setCustomSaveState('idle');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setToast({ kind: 'error', text: msg });
    setCustomSaveState('idle');
  }
}
```

- [ ] **Step 2: saveCustomProvider 去掉 apiKey 逗号 split**

`payloadSources` 中删除 `apiKey` 字段的 split 逻辑（Key 只走 appendSourceKeys/removeSourceKey）。整包 sources 只提交 `id/label/baseUrl/models`：

```ts
const payloadSources = customSources.map((s) => ({
  id: s.id,
  label: s.label,
  baseUrl: s.baseUrl.trim(),
  models: s.models,
}));
```

保存成功后：对每个 source 若有非空 draft，可依次 `await saveSourceDrafts(s.id)`，或在主保存后单独「保存 Key」按钮——**推荐**：source 卡片内 Key 区自带「保存」调用 `saveSourceDrafts`，与主「保存自定义模型」分离，避免一次请求过大。

- [ ] **Step 3: 替换 source 卡片 API Key 输入区（~1837-1873）**

模式与 Provider 相同：

```tsx
<div className="space-y-1.5">
  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
    <KeyRound size={12} strokeWidth={1.75} /> API Key
  </div>
  {(src.keyMeta ?? []).map((row, idx) => (
    <div key={row.id} className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 px-2 py-1.5">
      <code className="flex-1 truncate font-mono text-xs">{row.hint}</code>
      <button
        type="button"
        onClick={() => void removeSourceKey(src.id, idx)}
        aria-label={t('settings.custom.removeKey', { n: idx + 1 })}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 size={13} />
      </button>
    </div>
  ))}
  {(srcKeyDrafts[src.id] ?? []).map((draft, di) => (
    <div key={`sd-${di}`} className="relative">
      <input
        type={isKeyVisible ? 'text' : 'password'}
        className="w-full rounded-md border border-input bg-surface px-3 py-2 pr-9 font-mono text-sm ..."
        placeholder={t('settings.custom.apiKeyPlaceholder')}
        value={draft}
        onChange={(e) =>
          setSrcKeyDrafts((d) => {
            const list = [...(d[src.id] ?? [])];
            list[di] = e.target.value;
            return { ...d, [src.id]: list };
          })
        }
        autoComplete="off"
        spellCheck={false}
      />
      {/* eye toggle 同现有 customKeyVisible[src.id] */}
      <button
        type="button"
        onClick={() =>
          setSrcKeyDrafts((d) => ({
            ...d,
            [src.id]: (d[src.id] ?? []).filter((_, i) => i !== di),
          }))
        }
        aria-label={t('settings.custom.removeKey', { n: (src.keyMeta?.length ?? 0) + di + 1 })}
        className="absolute -right-8 top-1/2 -translate-y-1/2 ..."
      >
        <X size={13} />
      </button>
    </div>
  ))}
  <div className="flex flex-wrap gap-2">
    <button
      type="button"
      onClick={() =>
        setSrcKeyDrafts((d) => ({ ...d, [src.id]: [...(d[src.id] ?? []), ''] }))
      }
      className="..."
    >
      <Plus size={12} /> {t('settings.custom.addKey')}
    </button>
    <button
      type="button"
      onClick={() => void saveSourceDrafts(src.id)}
      disabled={!(srcKeyDrafts[src.id] ?? []).some((k) => k.trim()) || customSaveState === 'saving'}
      className="..."
    >
      {t('settings.sources.save')}
    </button>
  </div>
</div>
```

空 keyMeta 且无草稿时可显示 hint placeholder 文案说明。

- [ ] **Step 4: 确认 no remaining comma-split for custom keys**

Grep `split(/[\s,;|]+/)` in SettingsView — 应为 0 处（或仅 provider 旧码已删）。

- [ ] **Step 5: Commit**

```bash
git add packages/ui/app/components/SettingsView.tsx
git commit -m "feat(ui): custom source multi-key list and immediate delete"
```

---

## Task A6: UI 测试 + 全量验证

**Files:**
- Modify: `packages/ui/app/components/__tests__/settings.test.tsx`
- Modify: `packages/ui/test/server.ts`（如需 mock keyMeta / POST）

- [ ] **Step 1: 扩展 configPayload providers**

```ts
openrouter: {
  enabled: false,
  hasKey: false,
  keyCount: 0,
  keyMeta: [],
},
gemini: { enabled: false, hasKey: false, keyCount: 0, keyMeta: [] },
```

custom source 增加：

```ts
keyMeta: [{ id: 'k0', hint: '…a1b2' }],
hasKey: true,
```

- [ ] **Step 2: 新增测试**

```ts
it('adds a key draft and saves with appendKeys', async () => {
  const writes: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${gateway}/api/config`, () =>
      HttpResponse.json({
        ...configPayload,
        providers: {
          ...configPayload.providers,
          openrouter: { enabled: true, hasKey: true, keyCount: 1, keyMeta: [{ id: 'k0', hint: '…abcd' }] },
        },
      }),
    ),
    http.post(`${gateway}/api/providers`, async ({ request }) => {
      writes.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true });
    }),
  );
  const user = userEvent.setup();
  render(<SettingsView />);
  expect(await screen.findByText('…abcd')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /添加 Key/ }));
  const input = screen.getByLabelText(/OpenRouter API Key/);
  await user.type(input, 'brand-new-key');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(writes.length).toBeGreaterThan(0));
  expect(writes[0]).toMatchObject({
    provider: 'openrouter',
    appendKeys: ['brand-new-key'],
  });
  expect(writes[0]).not.toHaveProperty('apiKeys');
});
```

（若 `添加 Key` 出现多个，用 `within` 限定 OpenRouter 卡片。）

- [ ] **Step 3: 修复被文案改动打破的现有断言**

settings.test.tsx L27 `/留空则保持不变/` — i18n 必须保留该子串（A3 已保留）。

- [ ] **Step 4: 全量验证**

```bash
npx prettier --write "packages/server/src/server.ts" "packages/server/src/__tests__/multi-key.test.ts" "packages/ui/app/components/SettingsView.tsx" "packages/ui/app/i18n.tsx" "packages/ui/test/server.ts" "packages/ui/app/components/__tests__/settings.test.tsx"
npx eslint "packages/server/src/server.ts" "packages/server/src/__tests__/multi-key.test.ts" "packages/ui/app/components/SettingsView.tsx" "packages/ui/app/i18n.tsx" --max-warnings=0
pnpm --filter @freemodelfinder/server test
pnpm --filter @freemodelfinder/ui test
pnpm typecheck
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "test(ui): multi-key append flow and keyMeta mocks"
```

---

# Part B — Auto 图片模态路由

## Task B1: 文本图片意图检测

**Files:**
- Modify: `packages/server/src/routes/openai.ts` ~154-167
- Create: `packages/server/src/routes/__tests__/auto-modality.test.ts`

- [ ] **Step 1: 导出 detectRequestModality 并增加 IMAGE 正则**

```ts
export function detectRequestModality(
  messages: OpenAIChatCompletionRequest['messages'],
): RequestModality {
  const VIDEO_KEYWORDS =
    /\b(生成|制作|创建|做一段?|来一段?|画一段?)(视频|动画|短片|影片|动态|视频片段)\b/i;
  const IMAGE_TEXT =
    /((生成|绘制|画|创作|做|来一张|来个|帮我画|给我画)(一|张|幅|点)?[^。\n]{0,12}(图|图片|图像|照片|插画|插图|壁纸|头像|海报|图画|画像))|(generate|draw|create|make)\s+(an?\s+)?[\w\s-]{0,20}(image|picture|photo|illustration|wallpaper|avatar|poster)/i;
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'image_url' || part.type === 'image') return 'image';
      }
      const text = content
        .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
        .join('\n');
      if (text) {
        if (VIDEO_KEYWORDS.test(text)) return 'video';
        if (IMAGE_TEXT.test(text)) return 'image';
      }
    } else if (typeof content === 'string') {
      if (VIDEO_KEYWORDS.test(content)) return 'video';
      if (IMAGE_TEXT.test(content)) return 'image';
    }
  }
  return 'text';
}
```

同消息内优先级：image part → video 关键词 → 图片文本。跨消息按序第一个命中返回（与原逻辑一致）。

- [ ] **Step 2: 写失败测试** `auto-modality.test.ts`

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectRequestModality } from '../openai.js';

function textMsg(content: string) {
  return { role: 'user' as const, content };
}

describe('detectRequestModality image text intent', () => {
  it('detects Chinese image generation prompts', () => {
    assert.equal(detectRequestModality([textMsg('生成小猫图片')]), 'image');
    assert.equal(detectRequestModality([textMsg('帮我画一张风景插画')]), 'image');
    assert.equal(detectRequestModality([textMsg('generate an image of a cat')]), 'image');
  });

  it('does not flag ordinary chat', () => {
    assert.equal(detectRequestModality([textMsg('介绍一下 OpenRouter')]), 'text');
    assert.equal(detectRequestModality([textMsg('这张地图怎么走')]), 'text');
  });

  it('keeps video keyword priority over image text', () => {
    assert.equal(detectRequestModality([textMsg('生成一段小猫视频')]), 'video');
  });

  it('keeps uploaded image parts as image', () => {
    assert.equal(
      detectRequestModality([
        {
          role: 'user' as const,
          content: [{ type: 'image_url' as const, image_url: { url: 'http://x/y.png' } }],
        },
      ]),
      'image',
    );
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`  
Expected: FAIL（未导出或仍返回 text）

- [ ] **Step 4: 实现 Step 1 后重跑**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/openai.ts packages/server/src/routes/__tests__/auto-modality.test.ts
git commit -m "feat(server): detect text image-generation intent for auto modality"
```

---

## Task B2: auto + image 未配置时自动发现

**Files:**
- Modify: `packages/server/src/routes/openai.ts` ~284-307

- [ ] **Step 1: 增加 findImageModel helper（openai.ts 模块级）**

```ts
async function findImageModelId(reg: ProviderRegistry): Promise<string | null> {
  try {
    const { models } = await reg.listAllModels();
    const byId = models.find((m) => /image/i.test(m.id.split(':').pop() ?? m.id));
    if (byId) return byId.id;
    const byCap = models.find((m) => m.capabilities?.includes('image'));
    return byCap ? byCap.id : null;
  } catch {
    return null;
  }
}
```

需确认 `ProviderRegistry` 已从 core import（openai.ts 已有 reg 类型）。

- [ ] **Step 2: 改 auto 分支**

```ts
if (chatReq.model === 'auto' || chatReq.model === 'default') {
  const cfg = reg.getConfig();
  const ar = cfg.autoRoute;
  const detectedModality = detectRequestModality(body.messages);
  let forcedImage = false;
  if (detectedModality === 'image') {
    if (ar?.imageModel) {
      chatReq.model = ar.imageModel;
      forcedImage = true;
    } else {
      const discovered = await findImageModelId(reg);
      if (discovered) {
        chatReq.model = discovered;
        forcedImage = true;
      }
      // 未发现则保持 auto → 原文本链路
    }
  } else if (detectedModality === 'video' && ar?.videoModel) {
    chatReq.model = ar.videoModel;
  } else if (detectedModality === 'text' && ar?.textTiers) {
    const prompt = chatReq.messages.map((m) => m.content).join('\n');
    const tier = classifyTextComplexity(prompt);
    const tierModel = ar.textTiers[tier];
    if (tierModel) chatReq.model = tierModel;
  }

  // 将 forcedImage 传给下方 fast-path：用变量提升到函数作用域
  // 在 auto 块外声明: let forcedImageModality = false;
}
```

在 handler 内 auto 块之前声明 `let forcedImageModality = false;`，块内赋值。

- [ ] **Step 3: fast-path 认 capabilities / forced flag**

```ts
const rawModelId = chatReq.model.split(':').pop() ?? chatReq.model;
const inferredCaps: ('text' | 'image' | 'video')[] = /video/i.test(rawModelId)
  ? ['video']
  : /image/i.test(rawModelId) || forcedImageModality
    ? ['image']
    : [];
```

这样 id 不含 image 但经发现/配置选中的模型仍走 `generateImage`。

- [ ] **Step 4: HTTP 级测试追加到 auto-modality.test.ts 或 server.test.ts**

使用带 `autoRoute.imageModel` 的 registry/config fixture：

```ts
// 在 multi-key 或独立 describe：需要 createServer + config autoRoute
// testConfig 增加:
// autoRoute: { enabled: false, strategy: 'capability', imageModel: 'custom:img-model' }
// listAllModels 返回含 id: 'agnes:image-2.0' capabilities: ['image'] 的模型
// resolveModel: 若 modelId 含 image 则返回 fake generateImage provider
```

若 `generateImage` 需完整 mock 较重，最小断言：chat 后 `record` 或 response 的 `model` 字段为 image 模型；或 mock `reg.generateImage` 返回 URL。

简化路径（推荐）：在 fakeRegistry 中：

```ts
registry.generateImage = async (req) => ({
  response: {
    created: Date.now(),
    data: [{ url: 'https://example.invalid/cat.png' }],
  },
  request: req,
});
registry.resolveModel = (model: string) => {
  if (/image/i.test(model)) {
    return { provider: providerWithImage as never, modelId: model };
  }
  return { provider: provider as never, modelId: 'fixture-model' };
};
```

测试：

```ts
const res = await app.inject({
  method: 'POST',
  url: '/v1/chat/completions',
  headers: localUiHeaders,
  payload: {
    model: 'auto',
    messages: [{ role: 'user', content: '生成小猫图片' }],
    stream: false,
  },
});
assert.equal(res.statusCode, 200);
const body = res.json();
assert.match(JSON.stringify(body), /cat\.png|image/);
```

同时一条：`content: '你好'` 不触发 image 路径（仍 text fixture reply）。

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter @freemodelfinder/server test`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/openai.ts packages/server/src/routes/__tests__/auto-modality.test.ts
git commit -m "feat(server): auto discovers image model when imageModel unset"
```

---

## Task B3: 文案（可选）+ 全量验证

**Files:**
- Modify: `packages/ui/app/i18n.tsx` ~245-246 / ~701-702

- [ ] **Step 1: modality.desc 补一句**

中文：

```
'当 model 为 auto 时，根据请求内容自动选择合适的模型。检测到图片（含「生成xx图片」等文本意图）走图片模型；检测到视频关键词走视频模型；其余走默认文本模型。未配置图片模型时会自动发现可用生图模型。'
```

英文对应改 `settings.autoRoute.modality.desc`。

- [ ] **Step 2: 全量验证**

```bash
npx prettier --write "packages/server/src/routes/openai.ts" "packages/server/src/routes/__tests__/auto-modality.test.ts" "packages/ui/app/i18n.tsx"
npx eslint "packages/server/src/routes/openai.ts" "packages/server/src/routes/__tests__/auto-modality.test.ts" --max-warnings=0
pnpm --filter @freemodelfinder/core test
pnpm --filter @freemodelfinder/server test
pnpm --filter @freemodelfinder/ui test
pnpm typecheck
```

Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/app/i18n.tsx
git commit -m "docs(ui): clarify auto modality image intent copy"
```

---

## Final Verification (both parts)

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm --filter @freemodelfinder/server test`
- [ ] `pnpm --filter @freemodelfinder/ui test`
- [ ] `pnpm --filter @freemodelfinder/core test`
- [ ] 手动：`pnpm dev:server` + `pnpm dev:ui` → 设置页多 Key 增删 → 对话测试 auto +「生成小猫图片」

提醒用户：验证通过后由用户决定是否推送 GitHub。

---

## Self-Review

1. **Spec coverage:** A1-A6 覆盖 keyMeta、append/remove、UI、i18n、测试；B1-B3 覆盖意图检测、auto 发现、fast-path、文案。网关密钥/多自定义源/Anthropic-Gemini 为 scope 外。
2. **Placeholder:** 无 TBD；helper 与字段名与 spec 一致（`appendKeys`/`removeKeyIndex`/`appendSourceKeys`/`removeSourceKey`/`keyMeta`）。
3. **Type consistency:** `buildKeyMeta`/`providerKeyPool`/`sourceKeyPool` 与用法一致；`forcedImageModality` 声明位置已在 B2 Step 2 注明。
