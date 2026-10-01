# 密钥/代理条目的删除、按需揭示与复制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OpenCode Zen 设置面板的代理条目可单条删除与一键清空，让脱敏的 Key / 代理可按需揭示明文并复制，同时修复非 secure context 下复制必然失败的问题。

**Architecture:** 三层改动。`packages/server` 在 `GET /api/config` 增加脱敏 `proxyMeta`，在 `POST /api/providers` 增加 `removeProxyIndex`，新增 `POST /api/providers/reveal` 按需返回单条明文。`packages/ui` 新增 `copyToClipboard` helper（标准 API + `execCommand` 回退）并接入 3 个调用点，再在 Key 行与代理行加眼睛/复制/删除按钮。索引空间统一定义为「服务端生成 `keyMeta`/`proxyMeta` 时所用的列表」。

**Tech Stack:** TypeScript、Fastify（server）、Next.js 16 + React + lucide-react（ui）、Vitest + React Testing Library + msw（ui 测试）、`node --test`（server 测试）

**Spec:** `docs/superpowers/specs/2026-10-01-secret-list-reveal-copy-design.md`

---

## File Structure

| 文件                                                     | 动作 | 职责                                                                                                              |
| -------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server.ts`                          | 修改 | `proxyMeta` 输出、`removeProxyIndex` 校验与应用、`removeKeyIndex` 索引空间对齐、新增 `/api/providers/reveal` 路由 |
| `packages/ui/app/lib/utils.ts`                           | 修改 | 新增 `copyToClipboard`（含 `execCommand` 回退）                                                                   |
| `packages/ui/app/lib/__tests__/utils.test.ts`            | 新建 | `copyToClipboard` 三条路径的单测                                                                                  |
| `packages/ui/app/components/SettingsView.tsx`            | 修改 | `copyText` 改用 helper；Key 行加眼睛+复制；代理区块加条目列表、删除、清空；长度泄露修复                           |
| `packages/ui/app/i18n.tsx`                               | 修改 | 新增 zh/en 成对 key                                                                                               |
| `packages/ui/app/components/__tests__/settings.test.tsx` | 修改 | 代理删除/清空/揭示/复制用例                                                                                       |
| `packages/server/src/__tests__/opencode-config.test.ts`  | 修改 | `proxyMeta`、`removeProxyIndex`、`reveal` 用例                                                                    |
| `packages/ui/app/components/TesterView.tsx`              | 修改 | 改用 helper                                                                                                       |
| `packages/ui/app/components/ClineAccountsPanel.tsx`      | 修改 | 改用 helper                                                                                                       |

## 索引空间（实现必须遵守）

- Key：`providerKeyPool(credentials)`（`server.ts:309-313`，trim + 丢弃空串）过滤后的列表，与 `buildKeyMeta` 生成的 `k0`、`k1`… 一一对应。
- 代理：存储的 `extra.proxies` 数组下标，`proxyMeta` 不做任何过滤。
- `reveal` 与 `removeKeyIndex` / `removeProxyIndex` 必须使用同一空间。

---

### Task 1: `copyToClipboard` helper（修复复制失败）

**Files:**

- Modify: `packages/ui/app/lib/utils.ts`
- Test: `packages/ui/app/lib/__tests__/utils.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `packages/ui/app/lib/__tests__/utils.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../utils';

describe('copyToClipboard', () => {
  it('uses the async clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when the clipboard API is missing', async () => {
    Object.assign(navigator, { clipboard: undefined });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.assign(document, { execCommand });

    await expect(copyToClipboard('fallback')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back when the clipboard API rejects', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.assign(document, { execCommand });

    await expect(copyToClipboard('retry')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false when both paths fail', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    Object.assign(document, { execCommand: vi.fn().mockReturnValue(false) });

    await expect(copyToClipboard('nope')).resolves.toBe(false);
  });

  it('leaves no temporary textarea behind', async () => {
    Object.assign(navigator, { clipboard: undefined });
    Object.assign(document, { execCommand: vi.fn().mockReturnValue(true) });
    const before = document.querySelectorAll('textarea').length;

    await copyToClipboard('cleanup');

    expect(document.querySelectorAll('textarea').length).toBe(before);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/ui test -- utils.test.ts`
Expected: FAIL —— `copyToClipboard is not a function`（模块导出不存在）

- [ ] **Step 3: 写实现**

在 `packages/ui/app/lib/utils.ts` 末尾追加：

```ts
/**
 * Copy text to the clipboard.
 *
 * The async Clipboard API only exists in a secure context, so it is undefined
 * when the dashboard is served over plain http on a non-loopback host. The
 * execCommand path works there as long as it runs inside the user gesture.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/ui test -- utils.test.ts`
Expected: PASS —— 5 passed

- [ ] **Step 5: Commit**

```bash
git add packages/ui/app/lib/utils.ts packages/ui/app/lib/__tests__/utils.test.ts
git commit -m "fix(ui): 回退到 execCommand 修复非安全上下文下复制失败

navigator.clipboard 仅在 secure context 可用，通过明文 http 的公网地址
访问面板时它是 undefined，现有 copyText 直接抛 TypeError。"
```

---

### Task 2: 三个调用点改用 helper

**Files:**

- Modify: `packages/ui/app/components/SettingsView.tsx:1294-1302`
- Modify: `packages/ui/app/components/TesterView.tsx:473`
- Modify: `packages/ui/app/components/ClineAccountsPanel.tsx:389`
- Modify: `packages/ui/app/components/SettingsView.tsx:1883`（长度泄露）

- [ ] **Step 1: 确认三处现状**

Run: `pnpm --filter @freemodelfinder/ui exec grep -rn "clipboard" app/components/`
Expected: 命中 `SettingsView.tsx:1296`、`TesterView.tsx:473`、`ClineAccountsPanel.tsx:389`

- [ ] **Step 2: 替换 SettingsView 的 copyText**

`packages/ui/app/components/SettingsView.tsx:1294-1302` 替换为：

```ts
async function copyText(text: string, id: string) {
  const ok = await copyToClipboard(text);
  if (!ok) {
    setToast({ kind: 'error', text: t('settings.copyFailed') });
    return;
  }
  setCopied(id);
  setTimeout(() => setCopied((c) => (c === id ? null : c)), 1400);
}
```

`copyToClipboard` 加入该文件既有的 `../lib/utils` import 语句（`GATEWAY`、`withUiHeaders` 等已从该路径导入），不要新增重复 import 语句。

- [ ] **Step 3: 替换 TesterView 的复制**

`packages/ui/app/components/TesterView.tsx:473` 所在逻辑改为：

```ts
const copied = await copyToClipboard(message.content);
if (copied) {
  setCopied(true);
}
```

保留该处原有的后续行为（如定时复位）。同样确保 `copyToClipboard` 已从 `../lib/utils` 导入。

- [ ] **Step 4: 替换 ClineAccountsPanel 的复制**

`packages/ui/app/components/ClineAccountsPanel.tsx:389` 所在逻辑改为：

```ts
const ok = await copyToClipboard(code);
if (aliveRef.current && !ok) setActionError(t('settings.copyFailed'));
else if (aliveRef.current) {
  setCopied(true);
}
```

若该处原本只调用不检查返回值，请确保失败时仍然设置 `actionError`，因为原来的 `?.` 会静默失败。

- [ ] **Step 5: 修复 Gateway Key 遮罩的长度泄露**

`packages/ui/app/components/SettingsView.tsx:1883` 的：

```tsx
{
  visibleKey ? entry.key : '•'.repeat(Math.min(entry.key.length, 36));
}
```

替换为：

```tsx
{
  visibleKey ? entry.key : '•'.repeat(36);
}
```

- [ ] **Step 6: 运行 ui 测试与类型检查**

Run: `pnpm --filter @freemodelfinder/ui test && pnpm --filter @freemodelfinder/ui exec tsc --noEmit`
Expected: 全部 PASS，无类型错误

- [ ] **Step 7: Commit**

```bash
git add packages/ui/app/components/SettingsView.tsx packages/ui/app/components/TesterView.tsx packages/ui/app/components/ClineAccountsPanel.tsx
git commit -m "fix(ui): 三处复制统一走 copyToClipboard 并移除密钥长度泄露

ClineAccountsPanel 原本用可选链静默失败，复制无反应也无提示；
Gateway Key 遮罩用 repeat(key.length) 会暴露密钥长度。"
```

---

### Task 3: 服务端输出脱敏 `proxyMeta`

**Files:**

- Modify: `packages/server/src/server.ts:663-676`
- Test: `packages/server/src/__tests__/opencode-config.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/__tests__/opencode-config.test.ts` 的 `describe` 内追加：

```ts
it('exposes redacted proxyMeta without the plaintext password', async () => {
  const current = registry.getConfig();
  registry.updateConfig({
    ...current,
    providers: {
      ...current.providers,
      opencode: {
        enabled: false,
        credentials: { apiKey: '', extra: { proxies: [] } },
      },
    },
  });

  const post = await app.inject({
    method: 'POST',
    url: '/api/providers',
    headers: localUiHeaders,
    payload: {
      provider: 'opencode',
      enabled: true,
      extra: {
        anonymous: true,
        proxies: ['http://user:secret@host:8080', 'socks5://10.0.0.1:1080', 'direct'],
      },
    },
  });
  assert.equal(post.statusCode, 200);

  const response = await app.inject({
    method: 'GET',
    url: '/api/config',
    headers: localUiHeaders,
  });
  const provider = response.json().providers.opencode;

  assert.equal(provider.proxyCount, 3);
  assert.deepEqual(
    provider.proxyMeta.map((row: { id: string; hint: string }) => row.id),
    ['p0', 'p1', 'p2'],
  );
  assert.doesNotMatch(JSON.stringify(provider.proxyMeta), /secret/);
  assert.match(provider.proxyMeta[0].hint, /\*\*\*/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: FAIL —— `provider.proxyMeta` 为 `undefined`

- [ ] **Step 3: 写实现**

在 `packages/server/src/server.ts` 的 `buildKeyMeta`（`:299-307`）之后追加：

```ts
function buildProxyMeta(proxies: unknown): Array<{ id: string; hint: string }> {
  if (!Array.isArray(proxies)) return [];
  return proxies
    .map((raw, index) => (typeof raw === 'string' ? raw : ''))
    .map((value, index) => ({ id: `p${index}`, hint: redactProxy(value) }));
}
```

`redactProxy` 由 `@freemodelfinder/zen` 导出（`packages/zen/src/index.ts:3` 转出 `./proxy/spec.js`，`spec.ts:7` 定义该函数）。

**依赖前置**：`packages/server/package.json` 当前只有 `@freemodelfinder/core`，**没有** `@freemodelfinder/zen`。因此必须先在该文件 `dependencies` 中加 `"@freemodelfinder/zen": "workspace:*"`，再执行：

```bash
pnpm install --frozen-lockfile
```

若 `--frozen-lockfile` 因 lockfile 未包含新依赖而失败，改用 `pnpm install` 更新 lockfile，并把 `pnpm-lock.yaml` 一并纳入本次提交。

再在 opencode 读取分支（`:663-676`）的 `proxyCount` 之后追加：

```ts
                      proxyMeta: buildProxyMeta(extra['proxies']),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/__tests__/opencode-config.test.ts
git commit -m "feat(server): 输出脱敏 proxyMeta 供代理列表展示

代理可能带 user:pass，GET /api/config 此前只返回计数，UI 无法展示条目，
因此也无法按条目删除。索引即存储数组下标，与 removeProxyIndex 对齐。"
```

---

### Task 4: 服务端 `removeProxyIndex` + `removeKeyIndex` 索引空间对齐

**Files:**

- Modify: `packages/server/src/server.ts:954-961`（校验）、`:1123-1128`（应用）
- Test: `packages/server/src/__tests__/opencode-config.test.ts`

- [ ] **Step 1: 写失败测试**

在同一个 `describe` 内追加：

```ts
it('removes a single proxy via removeProxyIndex', async () => {
  const current = registry.getConfig();
  registry.updateConfig({
    ...current,
    providers: {
      ...current.providers,
      opencode: {
        enabled: false,
        credentials: { apiKey: '', extra: { proxies: ['direct', 'http://a:1', 'http://b:2'] } },
      },
    },
  });

  const post = await app.inject({
    method: 'POST',
    url: '/api/providers',
    headers: localUiHeaders,
    payload: { provider: 'opencode', enabled: true, removeProxyIndex: 1 },
  });
  assert.equal(post.statusCode, 200);

  const response = await app.inject({
    method: 'GET',
    url: '/api/config',
    headers: localUiHeaders,
  });
  const provider = response.json().providers.opencode;

  assert.equal(provider.proxyCount, 2);
  assert.deepEqual(
    provider.proxyMeta.map((row: { hint: string }) => row.hint),
    ['direct', 'http://b:2/'],
  );
});

it('ignores an out-of-range removeProxyIndex', async () => {
  const current = registry.getConfig();
  registry.updateConfig({
    ...current,
    providers: {
      ...current.providers,
      opencode: {
        enabled: false,
        credentials: { apiKey: '', extra: { proxies: ['http://a:1'] } },
      },
    },
  });

  const post = await app.inject({
    method: 'POST',
    url: '/api/providers',
    headers: localUiHeaders,
    payload: { provider: 'opencode', enabled: true, removeProxyIndex: 9 },
  });
  assert.equal(post.statusCode, 200);

  const response = await app.inject({
    method: 'GET',
    url: '/api/config',
    headers: localUiHeaders,
  });
  assert.equal(response.json().providers.opencode.proxyCount, 1);
});

it('rejects a negative removeProxyIndex', async () => {
  const post = await app.inject({
    method: 'POST',
    url: '/api/providers',
    headers: localUiHeaders,
    payload: { provider: 'opencode', enabled: true, removeProxyIndex: -1 },
  });
  assert.equal(post.statusCode, 400);
  assert.match(post.json().error, /removeProxyIndex/);
});

it('rejects removeProxyIndex for a non-opencode provider', async () => {
  const post = await app.inject({
    method: 'POST',
    url: '/api/providers',
    headers: localUiHeaders,
    payload: { provider: 'openrouter', enabled: true, removeProxyIndex: 0 },
  });
  assert.equal(post.statusCode, 400);
});

it('removes the key at the same index keyMeta reports', async () => {
  const current = registry.getConfig();
  registry.updateConfig({
    ...current,
    providers: {
      ...current.providers,
      opencode: {
        enabled: false,
        credentials: { apiKey: '', extra: {}, apiKeys: ['sk-aaa', '   ', 'sk-bbb'] },
      },
    },
  });

  const before = await app.inject({
    method: 'GET',
    url: '/api/config',
    headers: localUiHeaders,
  });
  const beforeMeta = before.json().providers.opencode.keyMeta;
  assert.equal(beforeMeta.length, 2, 'a blank key must not occupy an index');

  const post = await app.inject({
    method: 'POST',
    url: '/api/providers',
    headers: localUiHeaders,
    payload: { provider: 'opencode', enabled: true, removeKeyIndex: 1 },
  });
  assert.equal(post.statusCode, 200);

  const response = await app.inject({
    method: 'GET',
    url: '/api/config',
    headers: localUiHeaders,
  });
  const provider = response.json().providers.opencode;
  assert.equal(provider.keyMeta.length, 1);
  assert.match(provider.keyMeta[0].hint, /aaa/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: FAIL —— 删除未生效（`proxyCount` 仍为 3），且 `removeProxyIndex` 未被校验

- [ ] **Step 3: 写校验实现**

请求体解构在 `packages/server/src/server.ts:826-833`（`} = req.body ?? {};`）。把 `removeProxyIndex` 加入解构列表：

```ts
const {
  provider,
  apiKey,
  apiKeys,
  enabled,
  baseUrl,
  models,
  extra,
  appendKeys,
  removeKeyIndex,
  appendSourceKeys,
  removeSourceKey,
  removeProxyIndex,
} = req.body ?? {};
```

在 `removeKeyIndex` 的范围校验块（`:998-1003`）之后追加：

```ts
if (removeProxyIndex !== undefined) {
  if (providerId !== 'opencode') {
    return reply.code(400).send({ error: 'removeProxyIndex requires provider "opencode"' });
  }
  if (
    typeof removeProxyIndex !== 'number' ||
    !Number.isInteger(removeProxyIndex) ||
    removeProxyIndex < 0
  ) {
    return reply.code(400).send({ error: 'removeProxyIndex must be a non-negative integer' });
  }
}
```

范围越界按既有 `removeKeyIndex` 的先例（`:1000-1002` 返回 400）保持一致。在整数校验后追加：

```ts
const proxies = Array.isArray(curCfg.providers[providerId]?.credentials?.extra?.['proxies'])
  ? (curCfg.providers[providerId]?.credentials?.extra?.['proxies'] as unknown[])
  : [];
if (removeProxyIndex >= proxies.length) {
  return reply.code(400).send({ error: 'removeProxyIndex out of range' });
}
if (cleanExtra?.['proxies'] !== undefined) {
  return reply.code(400).send({ error: 'removeProxyIndex conflicts with extra.proxies' });
}
```

并把 Step 1 的 `ignores an out-of-range removeProxyIndex` 用例期望从 200 改为 `400` —— 与 `removeKeyIndex` 的既有行为保持一致，而不是静默忽略。

**两处关键点**：

1. `proxies` **不做 `typeof string` 过滤**。`cleanExtra`（`:944-962`）只按 key 名做白名单、从不校验数组元素值，所以 `extra: { proxies: [42, 'http://a:1'] }` 能原样落盘。若这里过滤而 `buildProxyMeta` / `proxyCount` 不过滤，两侧索引基准就不同：界面上看得见的合法代理会返回 400 删不掉，删那条不可见的项则会连带清空整表。这与本文档开头「索引空间」一节「代理不做任何过滤，索引即存储下标」直接冲突。
2. 拒绝与 `extra.proxies` 同请求提交。否则 `nextExtra` 刚被 `{...prevExtra, ...cleanExtra}` 合并出的新列表会被下面的「旧表减一项」静默覆盖，用户提交的代理凭空消失；且与兄弟参数 `removeKeyIndex`（作用在**合并后**的新列表上）语义相反，后续维护者极易踩。

- [ ] **Step 4: 写应用实现**

`nextExtra` 在 `packages/server/src/server.ts:1111-1115` 计算。在其之后立刻插入：

```ts
if (removeProxyIndex !== undefined && providerId === 'opencode') {
  const currentProxies = Array.isArray(prevExtra['proxies'])
    ? (prevExtra['proxies'] as unknown[])
    : [];
  nextExtra.proxies = currentProxies.filter((_, i) => i !== removeProxyIndex);
}
```

同样**不做 `typeof string` 过滤**，理由见 Step 3 的关键点 1。

- [ ] **Step 5: 对齐 `removeKeyIndex` 的索引空间**

`packages/server/src/server.ts:1116-1122` 的 `nextApiKeys` 在用户未提交 `apiKeys`/`apiKey` 时取的是**未过滤**的 `cur.credentials.apiKeys`（可能是 `undefined`）。而 `:1123-1128` 的删除与 `keyMeta`（`buildKeyMeta` 先 trim 再丢弃空串）索引空间不一致。

把 `:1116-1128` 整段替换为：

```ts
let nextApiKeys =
  cleanApiKeys !== undefined
    ? cleanApiKeys
    : cleanApiKey
      ? [cleanApiKey]
      : cur.credentials?.apiKeys
        ? providerKeyPool(cur.credentials)
        : undefined;
if (removeKeyIndex !== undefined && !shouldClear) {
  const base = nextApiKeys ?? providerKeyPool(cur.credentials);
  if (removeKeyIndex < base.length) {
    nextApiKeys = base.filter((_, i) => i !== removeKeyIndex);
  }
}
```

关键点：`cur.credentials.apiKeys` 存在时改用 `providerKeyPool(cur.credentials)`（trim + 丢弃空串），使其与 `buildKeyMeta` 的过滤一致。用户本次提交的 `cleanApiKeys` 本身已在 `:840-843` 做过同样的 trim+filter，优先级不变。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/__tests__/opencode-config.test.ts
git commit -m "feat(server): 支持 removeProxyIndex 并统一删除索引空间

keyMeta 过滤掉空白键但 removeKeyIndex 取的是未过滤数组，两者会错位；
现在删除、揭示与展示共用同一索引空间。清空代理列表无需新参数，
提交 extra.proxies=[] 已由整表覆盖语义生效。"
```

---

### Task 5: 新增 `POST /api/providers/reveal`

**Files:**

- Modify: `packages/server/src/server.ts`（在 `/api/providers` 路由之后新增）
- Test: `packages/server/src/__tests__/opencode-config.test.ts`

- [ ] **Step 1: 写失败测试**

在同一个 `describe` 内追加：

```ts
it('reveals one stored key without exposing the others in /api/config', async () => {
  const current = registry.getConfig();
  registry.updateConfig({
    ...current,
    providers: {
      ...current.providers,
      opencode: {
        enabled: false,
        credentials: {
          apiKey: '',
          apiKeys: ['sk-first-secret', 'sk-second-secret'],
          extra: { proxies: ['http://user:pw@host:1'] },
        },
      },
    },
  });

  const reveal = await app.inject({
    method: 'POST',
    url: '/api/providers/reveal',
    headers: localUiHeaders,
    payload: { provider: 'opencode', kind: 'key', index: 1 },
  });
  assert.equal(reveal.statusCode, 200);
  assert.deepEqual(reveal.json(), { value: 'sk-second-secret' });

  const config = await app.inject({
    method: 'GET',
    url: '/api/config',
    headers: localUiHeaders,
  });
  assert.doesNotMatch(config.body, /sk-first-secret/);
  assert.doesNotMatch(config.body, /sk-second-secret/);
});

it('reveals a stored proxy including its password', async () => {
  const current = registry.getConfig();
  registry.updateConfig({
    ...current,
    providers: {
      ...current.providers,
      opencode: {
        enabled: false,
        credentials: { apiKey: '', extra: { proxies: ['http://user:pw@host:1'] } },
      },
    },
  });

  const reveal = await app.inject({
    method: 'POST',
    url: '/api/providers/reveal',
    headers: localUiHeaders,
    payload: { provider: 'opencode', kind: 'proxy', index: 0 },
  });
  assert.equal(reveal.statusCode, 200);
  assert.equal(reveal.json().value, 'http://user:pw@host:1');
});

it('returns 404 for an out-of-range reveal index', async () => {
  const reveal = await app.inject({
    method: 'POST',
    url: '/api/providers/reveal',
    headers: localUiHeaders,
    payload: { provider: 'opencode', kind: 'proxy', index: 42 },
  });
  assert.equal(reveal.statusCode, 404);
});

it('rejects an unknown reveal kind and a non-integer index', async () => {
  const badKind = await app.inject({
    method: 'POST',
    url: '/api/providers/reveal',
    headers: localUiHeaders,
    payload: { provider: 'opencode', kind: 'nope', index: 0 },
  });
  assert.equal(badKind.statusCode, 400);

  const badIndex = await app.inject({
    method: 'POST',
    url: '/api/providers/reveal',
    headers: localUiHeaders,
    payload: { provider: 'opencode', kind: 'key', index: 1.5 },
  });
  assert.equal(badIndex.statusCode, 400);
});

it('requires the ui origin guard for reveal', async () => {
  const reveal = await app.inject({
    method: 'POST',
    url: '/api/providers/reveal',
    headers: { 'x-fmf-client': 'ui' },
    payload: { provider: 'opencode', kind: 'key', index: 0 },
  });
  assert.equal(reveal.statusCode, 403);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: FAIL —— 404（路由不存在，Fastify 返回 `Not found`）

- [ ] **Step 3: 写实现**

在 `packages/server/src/server.ts` 的 `/api/providers` 路由块结束后追加：

```ts
app.post('/api/providers/reveal', async (req, reply) => {
  const body = (req.body ?? {}) as {
    provider?: unknown;
    kind?: unknown;
    index?: unknown;
  };
  if (typeof body.provider !== 'string') {
    return reply.code(400).send({ error: 'provider is required' });
  }
  if (body.kind !== 'key' && body.kind !== 'proxy') {
    return reply.code(400).send({ error: 'kind must be "key" or "proxy"' });
  }
  if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
    return reply.code(400).send({ error: 'index must be a non-negative integer' });
  }

  const parsed = ProviderIdSchema.safeParse(body.provider);
  if (!parsed.success || parsed.data === 'ollama') {
    return reply.code(400).send({ error: `unsupported provider: ${String(body.provider)}` });
  }
  const settings = getRegistry().getConfig().providers[parsed.data];
  if (!settings?.enabled) {
    return reply.code(400).send({ error: `provider ${parsed.data} is not enabled` });
  }

  const index = body.index;
  const value =
    body.kind === 'key'
      ? providerKeyPool(settings.credentials)[index]
      : (Array.isArray(settings.credentials?.extra?.['proxies'])
          ? (settings.credentials?.extra?.['proxies'] as unknown[])
          : []
        ).filter((entry): entry is string => typeof entry === 'string')[index];

  if (value === undefined) {
    return reply.code(404).send({ error: 'not found' });
  }
  return { value };
});
```

复用 `server.ts:7-22` 已有的 `ProviderIdSchema` import（`:11`），不要新增类型 import。`getRegistry` 是 `server.ts:432` 的既有模块级 helper，直接使用。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/server test`
Expected: PASS

- [ ] **Step 5: 验证明文不进日志**

Run: `grep -n "req.body" packages/server/src/server.ts | head -20`
Expected: 既有 redact 名单（`:393-407`）未包含新增字段；确认 reveal 请求体只含 `provider`/`kind`/`index`，不含明文，无需改动 redact 配置。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/__tests__/opencode-config.test.ts
git commit -m "feat(server): 新增按需揭示单条明文的 reveal 端点

随 GET /api/config 一并下发明文会撤掉现存唯一一层脱敏保护，且默认
Docker 部署下 /api/* 无鉴权，因此改为点击时才取回单条。路由复用既有
preHandler 守卫，请求体不含明文，无需扩展日志 redact。"
```

---

### Task 6: i18n 新增 key

**Files:**

- Modify: `packages/ui/app/i18n.tsx`

- [ ] **Step 1: 写失败测试**

无需单独写测试：`packages/ui/app/__tests__/i18n.test.tsx:48-51` 已断言 zh/en key 集合完全一致，新增单边 key 会自动失败。先记录基线：

Run: `pnpm --filter @freemodelfinder/ui test -- i18n.test.tsx`
Expected: PASS（基线通过）

- [ ] **Step 2: 加 zh 文案**

在 `packages/ui/app/i18n.tsx` 的 zh 对象中，`'settings.opencode.proxies.count'` 附近加入：

```ts
  'settings.opencode.proxies.row': '代理 {n}',
  'settings.opencode.proxies.remove': '删除代理 {n}',
  'settings.opencode.proxies.clear': '清空全部',
  'settings.copy.proxy': '复制代理',
```

- [ ] **Step 3: 加 en 文案**

在 en 对象相同位置加入：

```ts
  'settings.opencode.proxies.row': 'Proxy {n}',
  'settings.opencode.proxies.remove': 'Remove proxy {n}',
  'settings.opencode.proxies.clear': 'Clear all',
  'settings.copy.proxy': 'Copy proxy',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/ui test -- i18n.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/app/i18n.tsx
git commit -m "feat(ui): 代理条目操作的中英文案"
```

---

### Task 7: 代理列表 UI（条目展示 + 单条删除 + 清空）

**Files:**

- Modify: `packages/ui/app/components/SettingsView.tsx:56-69`（ConfigRes 类型）、`:136-154`（组件 props/state）、`:327-359`（代理区块）
- Test: `packages/ui/app/components/__tests__/settings.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `packages/ui/app/components/__tests__/settings.test.tsx` 中追加：

```tsx
it('removes one saved proxy via removeProxyIndex', async () => {
  const writes: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${gateway}/api/config`, () =>
      HttpResponse.json({
        ...configPayload,
        providers: {
          ...configPayload.providers,
          opencode: {
            enabled: true,
            hasKey: true,
            anonymous: true,
            proxyCount: 2,
            proxyMeta: [
              { id: 'p0', hint: 'http://***@a:1/' },
              { id: 'p1', hint: 'http://***@b:2/' },
            ],
          },
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
  const row = await screen.findByText('http://***@a:1/');
  const controls = row.parentElement;
  await user.click(within(controls!).getByRole('button', { name: '删除代理 1' }));
  await waitFor(() => expect(writes.length).toBeGreaterThan(0));
  expect(writes[0]).toMatchObject({ provider: 'opencode', removeProxyIndex: 0 });
});

it('clears the whole proxy list with an empty array', async () => {
  const writes: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${gateway}/api/config`, () =>
      HttpResponse.json({
        ...configPayload,
        providers: {
          ...configPayload.providers,
          opencode: {
            enabled: true,
            hasKey: true,
            anonymous: true,
            proxyCount: 1,
            proxyMeta: [{ id: 'p0', hint: 'direct' }],
          },
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
  await user.click(await screen.findByRole('button', { name: '清空全部' }));
  await waitFor(() => expect(writes.length).toBeGreaterThan(0));
  expect(writes[0]).toMatchObject({ provider: 'opencode', extra: { proxies: [] } });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/ui test -- settings.test.tsx`
Expected: FAIL —— 找不到「删除代理 1」/「清空全部」按钮

- [ ] **Step 3: 扩展类型与 props**

`packages/ui/app/components/SettingsView.tsx:63` 的 `proxyCount?: number;` 之后加入：

```tsx
      proxyMeta?: Array<{ id: string; hint: string }>;
```

`:141` 的 props 类型替换为：

```tsx
  extra: {
    anonymous: boolean;
    prefer?: string;
    goKeyCount?: number;
    proxyCount?: number;
    proxyMeta?: Array<{ id: string; hint: string }>;
  };
```

`:149` 的 state 声明之后加入：

```tsx
const [proxyMeta, setProxyMeta] = useState(extra.proxyMeta ?? []);
```

并在 `:157` 的 useEffect 区域追加：

```tsx
useEffect(() => setProxyMeta(extra.proxyMeta ?? []), [extra.proxyMeta]);
```

- [ ] **Step 4: 渲染代理条目与操作**

在 `:327-359` 的代理区块中，「保存代理」按钮之后追加：

```tsx
{
  (proxyMeta ?? []).map((row, idx) => (
    <div
      key={row.id}
      className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 px-2 py-1.5"
    >
      <code className="flex-1 truncate font-mono text-xs text-foreground">{row.hint}</code>
      <span className="sr-only">{t('settings.opencode.proxies.row', { n: idx + 1 })}</span>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() =>
          void run('proxies', async () => {
            await postExtra({ removeProxyIndex: idx });
          })
        }
        aria-label={t('settings.opencode.proxies.remove', { n: idx + 1 })}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Trash2 size={13} strokeWidth={1.75} />
      </button>
    </div>
  ));
}
{
  (proxyMeta ?? []).length > 0 && (
    <button
      type="button"
      disabled={busy !== null}
      onClick={() =>
        void run('proxies', async () => {
          await postExtra({ proxies: [] });
        })
      }
      className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
    >
      {t('settings.opencode.proxies.clear')}
    </button>
  );
}
```

注意 `postExtra` 的实现（`:159-173`）目前把 patch 整体放进 `extra`。`removeProxyIndex` 是顶层字段而非 `extra` 成员，因此必须改 `postExtra` 支持顶层字段：

```tsx
async function postExtra(
  patch: Record<string, unknown>,
  options: { topLevel?: Record<string, unknown> } = {},
): Promise<void> {
  const res = await fetch(
    `${GATEWAY}/api/providers`,
    withUiHeaders({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'opencode',
        ...(options.topLevel ?? {}),
        extra: patch,
      }),
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
```

并把删除按钮的调用改为：

```tsx
await postExtra({}, { topLevel: { removeProxyIndex: idx } });
```

- [ ] **Step 5: 在挂载点传入 proxyMeta**

`:2330-2335` 的 `extra={{ ... }}` 中加入：

```tsx
        proxyMeta: state?.proxyMeta,
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/ui test -- settings.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ui/app/components/SettingsView.tsx packages/ui/app/components/__tests__/settings.test.tsx
git commit -m "feat(ui): 代理列表支持单条删除与一键清空

此前只有整表覆盖写入，空输入还会禁用保存按钮，既看不到条目也无法移除。"
```

---

### Task 8: Key 行与代理行的眼睛揭示 + 复制

**Files:**

- Modify: `packages/ui/app/components/SettingsView.tsx:1294-1302`（新增 reveal helper）、`:2198-2219`（Key 行）、Task 7 的代理区块
- Test: `packages/ui/app/components/__tests__/settings.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `packages/ui/app/components/__tests__/settings.test.tsx` 追加：

```tsx
  it('reveals a saved key on demand and never puts the plaintext in /api/config', async () => {
    const reveals: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            openrouter: {
              enabled: true,
              hasKey: true,
              keyCount: 1,
              keyMeta: [{ id: 'k0', hint: '…abcd' }],
            },
          },
        }),
      ),
      http.post(`${gateway}/api/providers/reveal', async ({ request }) => {
        reveals.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ value: 'sk-revealed-value' });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    const hint = await screen.findByText('…abcd');
    const controls = hint.parentElement;
    await user.click(within(controls!).getByRole('button', { name: '显示 Key' }));
    expect(await screen.findByText('sk-revealed-value')).toBeTruthy();
    expect(reveals[0]).toMatchObject({ provider: 'openrouter', kind: 'key', index: 0 });
  });

  it('copies a saved key without flipping the row to revealed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            openrouter: {
              enabled: true,
              hasKey: true,
              keyCount: 1,
              keyMeta: [{ id: 'k0', hint: '…abcd' }],
            },
          },
        }),
      ),
      http.post(`${gateway}/api/providers/reveal`, () =>
        HttpResponse.json({ value: 'sk-copy-me' }),
      ),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    const hint = await screen.findByText('…abcd');
    const controls = hint.parentElement;
    await user.click(within(controls!).getByRole('button', { name: '复制 API Key' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('sk-copy-me'));
    expect(screen.queryByText('sk-copy-me')).toBeNull();
  });
```

同时确认该测试文件顶部已 `import { vi } from 'vitest'`；若无则加入。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @freemodelfinder/ui test -- settings.test.tsx`
Expected: FAIL —— 找不到「显示 Key」/「复制 API Key」按钮

- [ ] **Step 3: 写 reveal helper**

在 `packages/ui/app/components/SettingsView.tsx` 的 `copyText` 之后追加：

```tsx
const [revealed, setRevealed] = useState<Record<string, string>>({});

async function revealSecret(
  providerId: string,
  kind: 'key' | 'proxy',
  index: number,
): Promise<string | undefined> {
  const res = await fetch(
    `${GATEWAY}/api/providers/reveal`,
    withUiHeaders({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: providerId, kind, index }),
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { value?: string };
  if (typeof data.value !== 'string') throw new Error('reveal returned no value');
  return data.value;
}

async function toggleReveal(providerId: string, kind: 'key' | 'proxy', cacheKey: string) {
  if (revealed[cacheKey] !== undefined) {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[cacheKey];
      return next;
    });
    return;
  }
  try {
    const value = await revealSecret(providerId, kind, 0);
    if (value === undefined) return;
    setRevealed((prev) => ({ ...prev, [cacheKey]: value }));
  } catch (err) {
    setToast({
      kind: 'error',
      text: t('settings.copyFailed', {
        detail: err instanceof Error ? err.message : String(err),
      }),
    });
  }
}

async function copySecret(
  providerId: string,
  kind: 'key' | 'proxy',
  index: number,
  copiedId: string,
) {
  try {
    const value = await revealSecret(providerId, kind, index);
    if (value === undefined) return;
    const ok = await copyToClipboard(value);
    if (!ok) {
      setToast({ kind: 'error', text: t('settings.copyFailed') });
      return;
    }
    setCopied(copiedId);
    setTimeout(() => setCopied((c) => (c === copiedId ? null : c)), 1400);
  } catch (err) {
    setToast({
      kind: 'error',
      text: t('settings.copyFailed', {
        detail: err instanceof Error ? err.message : String(err),
      }),
    });
  }
}
```

`toggleReveal` 里的 `index` 被硬编码为 `0` 是错的 —— 改为接收 `index` 参数并在调用处传入。正确签名与实现：

```tsx
async function toggleReveal(
  providerId: string,
  kind: 'key' | 'proxy',
  index: number,
  cacheKey: string,
) {
  if (revealed[cacheKey] !== undefined) {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[cacheKey];
      return next;
    });
    return;
  }
  try {
    const value = await revealSecret(providerId, kind, index);
    if (value === undefined) return;
    setRevealed((prev) => ({ ...prev, [cacheKey]: value }));
  } catch (err) {
    setToast({ kind: 'error', text: t('settings.copyFailed') });
  }
}
```

- [ ] **Step 4: Key 行加眼睛与复制**

`packages/ui/app/components/SettingsView.tsx:2198-2219` 的 Key 行替换为：

```tsx
{
  (state?.keyMeta ?? []).map((row, idx) => {
    const cacheKey = `${p.id}:key:${idx}`;
    const shown = revealed[cacheKey] ?? row.hint;
    return (
      <div
        key={row.id}
        className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 px-2 py-1.5"
      >
        <code className="flex-1 truncate font-mono text-xs text-foreground">{shown}</code>
        <span className="sr-only">
          {t('settings.sources.keyRow', { n: idx + 1, hint: row.hint })}
        </span>
        <button
          type="button"
          disabled={saveState === 'saving'}
          onClick={() => void toggleReveal(p.id, 'key', idx, cacheKey)}
          aria-label={
            revealed[cacheKey] !== undefined ? t('settings.hideKey') : t('settings.showKey')
          }
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {revealed[cacheKey] !== undefined ? (
            <EyeOff size={13} strokeWidth={1.75} />
          ) : (
            <Eye size={13} strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          disabled={saveState === 'saving'}
          onClick={() => void copySecret(p.id, 'key', idx, `key-${cacheKey}`)}
          aria-label={t('settings.copy.apiKey')}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {copied === `key-${cacheKey}` ? (
            <Check size={13} strokeWidth={1.75} />
          ) : (
            <Copy size={13} strokeWidth={1.75} />
          )}
        </button>
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
    );
  });
}
```

`Eye`、`EyeOff`、`Copy`、`Check`、`Trash2` 均已在 `SettingsView.tsx:5-22` 的 `lucide-react` import 中，无需新增导入。

- [ ] **Step 5: 代理行加眼睛与复制**

在 Task 7 渲染的代理行中，Trash2 之前插入：

```tsx
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void toggleReveal('opencode', 'proxy', idx, `opencode:proxy:${idx}`)}
          aria-label={
            revealed[`opencode:proxy:${idx}`] !== undefined
              ? t('settings.hideKey')
              : t('settings.showKey')
          }
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {revealed[`opencode:proxy:${idx}`] !== undefined ? (
            <EyeOff size={13} strokeWidth={1.75} />
          ) : (
            <Eye size={13} strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void copySecret('opencode', 'proxy', idx, `proxy-opencode:${idx}`)
          }
          aria-label={t('settings.copy.proxy')}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Copy size={13} strokeWidth={1.75} />
        </button>
```

并把该行 `<code>` 的内容改为：

```tsx
<code className="flex-1 truncate font-mono text-xs text-foreground">
  {revealed[`opencode:proxy:${idx}`] ?? row.hint}
</code>
```

**注意**：代理行位于 `OpenCodeZenExtras` 子组件内（`:136` 定义），而 Step 3 的 `revealed` / `revealSecret` / `toggleReveal` / `copySecret` 定义在父组件 `SettingsView`。跨组件共享父组件 state 不可行，必须分两处落地：

1. **父组件 `SettingsView`**：保留 `revealed` / `revealSecret` / `toggleReveal` / `copySecret`，供 `:2198` 的 Key 行使用。`copySecret` 需要 `setCopied` / `setToast` / `copyToClipboard`，这些在父组件内均已可用（`:453` 有 `copied`）。
2. **子组件 `OpenCodeZenExtras`**：新增**独立**的 `revealedProxy` state 与同名处理函数（内部同样直接 `fetch` + `withUiHeaders`，`run(...)` 提供 busy 与 toast），供代理行使用：

```tsx
const [revealedProxy, setRevealedProxy] = useState<Record<number, string>>({});

async function fetchProxySecret(index: number): Promise<string | undefined> {
  const res = await fetch(
    `${GATEWAY}/api/providers/reveal`,
    withUiHeaders({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'opencode', kind: 'proxy', index }),
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { value?: string };
  return typeof data.value === 'string' ? data.value : undefined;
}

async function toggleProxyReveal(index: number) {
  if (revealedProxy[index] !== undefined) {
    setRevealedProxy((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    return;
  }
  try {
    const value = await fetchProxySecret(index);
    if (value === undefined) return;
    setRevealedProxy((prev) => ({ ...prev, [index]: value }));
  } catch {
    onToast({ kind: 'error', text: t('settings.copyFailed') });
  }
}

async function copyProxySecret(index: number) {
  try {
    const value = revealedProxy[index] ?? (await fetchProxySecret(index));
    if (value === undefined) return;
    if (!(await copyToClipboard(value))) {
      onToast({ kind: 'error', text: t('settings.copyFailed') });
    }
  } catch {
    onToast({ kind: 'error', text: t('settings.copyFailed') });
  }
}
```

Step 5 代理行代码中的 `revealed[...]` / `toggleReveal(...)` / `copySecret(...)` 一并替换为子组件版本：`revealed[`opencode:proxy:${idx}`]` → `revealedProxy[idx]`，`toggleReveal('opencode','proxy',idx,...)` → `toggleProxyReveal(idx)`，`copySecret('opencode','proxy',idx,...)` → `copyProxySecret(idx)`。

`OpenCodeZenExtras` 需从 `../lib/utils` 导入 `GATEWAY`、`withUiHeaders`、`copyToClipboard`（若尚未导入）。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @freemodelfinder/ui test -- settings.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ui/app/components/SettingsView.tsx packages/ui/app/components/__tests__/settings.test.tsx
git commit -m "feat(ui): Key 与代理条目支持按需揭示与复制

复制到明文但不翻转眼睛状态，显示保持脱敏以避免肩窥。揭示只取单条。"
```

---

### Task 9: 全量验证

**Files:** 无新增

- [ ] **Step 1: 构建运行时**

Run: `pnpm build:runtime`
Expected: `Build success`，无 `error TS`

- [ ] **Step 2: 全量类型检查与 lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 两者 exit 0，无 warning（`--max-warnings=0`）

- [ ] **Step 3: 各包测试**

Run: `pnpm --filter @freemodelfinder/core test && pnpm --filter @freemodelfinder/server test && pnpm --filter @freemodelfinder/ui test`
Expected: 全部 `# fail 0` / vitest 全通过

- [ ] **Step 4: 格式检查**

Run: `npx prettier --check "packages/**/*.{ts,tsx}" "docs/superpowers/**/*.md"`
Expected: `All matched files use Prettier code style!`

- [ ] **Step 5: 确认工作区无遗漏改动**

Run: `git status --short`
Expected: 只包含本计划涉及的文件；若出现无关文件则不要 `git add .`，逐个显式 add

---

## 完成标准

- `copyToClipboard` 在 secure context 与非 secure context 下都能复制，两个失败路径才返回 `false`
- `GET /api/config` 的 opencode 含脱敏 `proxyMeta`，响应中不含任何明文密码
- `POST /api/providers` 支持 `removeProxyIndex`（含 400 校验与 provider 限制）
- `POST /api/providers/reveal` 走既有守卫，只返回单条明文，越界 404
- `removeKeyIndex` / `reveal` / `keyMeta` 三者索引空间一致
- UI 代理条目可单条删除与一键清空；Key 与代理行可按需揭示并复制
- `pnpm build:runtime`、`pnpm typecheck`、`pnpm lint`、三包测试、prettier 全绿

## 不在本计划范围

- 不修改 Docker 暴露面（`0.0.0.0` 绑定 + `FREEMODELFINDER_TRUST_UI`）与 HTTPS 缺失
- 不新增鉴权机制，不给 reveal / copy 加限流或审计落盘
- 不改 `parseProxyList` 语义，不在写入时校验或去重代理
- 不改 Gateway Key 的明文下发方式（只修其复制路径与长度泄露）
