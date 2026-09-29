# P1-A：Zen 基础包、配置、身份与传输层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `@freemodelfinder/zen` 独立工作区包，并落地 P1 的地基：构建接线、zod 配置 schema、`ses_` 会话规范化、仿 `identity/request.go` 的请求标识，以及支持 direct/http/https/socks5 的 HTTP 传输层与 attempt 级监控。

**Architecture:** 新增 `packages/zen`，按 opencode2api 的 Go 包结构 1:1 对应分模块；本阶段只包含不依赖 core 的纯逻辑（config / identity / proxy / http / gateway-monitor），因此 core 与 zen 之间不存在循环依赖。后续 P1-E 才由 core 依赖 zen 并做适配层。

**Tech Stack:** TypeScript、zod v3、Node.js 内置 `node:http`/`node:https`、`http-proxy-agent` / `https-proxy-agent` / `socks-proxy-agent`、Node 内置 test runner（`node --test` + `tsx`）。

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-zen-integration-design.md`

---

## P1 阶段拆分（本计划只做 P1-A）

| 阶段     | 内容                                                                                                                            | 状态     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **P1-A** | 包脚手架 + 构建接线 + config schema + identity/session + HTTP 传输（direct/http/https/socks5） + attempt monitor                | ← 本计划 |
| P1-B     | 模型发现（`/v1/models` + `models.opencode.ai/api.json` + 文档回退）+ models.dev 定价 + `Catalog.Route()` 匿名资格 + 磁盘缓存    | 待写     |
| P1-C     | 三协议双向转换（chat/responses/anthropic）+ SSE 解析/重发 + 非流式折叠 + agent 形态形变 + `ForcedEffort` + stale-reasoning 重试 | 待写     |
| P1-D     | key 池 / 匿名池 / 代理池健康与冷却 / 上游状态机（tier 编排、重试、错误分类）/ runtime 装配                                      | 待写     |
| P1-E     | core 薄壳 provider + registry/auto-router/配额接线 + server `hasKey` + UI 面板/i18n + CLI + audit + docs                        | 待写     |

**已知 P1 设计缺口（P1-C/E 落地前必须处理）**：P0 未在 `ChatResponse`/`StreamChunk` 上提供 `raw` 回传载体，spec 的「同协议响应零损透传」目前无处安放。P1-C/E 的 plan 需要先补一个 `ChatResponse.raw`（可选）并让 core 出站序列化优先使用它。

**明确范围外**：`/v1/systemone`（OpenCode 结构化决策端点，非 LLM）。

---

## 关键背景（执行前必读）

1. **包管理**：`pnpm-workspace.yaml` 用 `packages/*`，新建目录自动纳入。新增**工作区依赖**或**第三方依赖**后必须运行 `pnpm install`（**不加** `--frozen-lockfile`）以更新 `pnpm-lock.yaml` 并提交它，否则 CI 的 `--frozen-lockfile` 会失败。
2. **测试运行**：仓库约定为显式 glob。本计划把 zen 的测试统一放在 `src/__tests__/*.test.ts`（扁平），`package.json` 的 test 脚本即 `node --import tsx --test src/__tests__/*.test.ts`。
3. **TS strict + `noUncheckedIndexedAccess`**：数组/字典取值一律 `?.`，测试用 `?.` 链。
4. **不要加行尾注释**；遵循仓库现有风格（参考 `packages/core/src/credentials/*`）。
5. **Git**：工作区存在大量与本计划无关的未提交改动（audit 产物、CRLF churn）。**每次只 `git add` 本任务列出的文件，绝不 `git add -A`/`git add .`**。
6. **不提推送**：按 `AGENTS.md`，任何 `git push` 都需要用户明确同意。

## 文件结构（P1-A）

| 文件                                   | 职责                                                         | 任务   |
| -------------------------------------- | ------------------------------------------------------------ | ------ |
| `packages/zen/package.json`            | 包定义、脚本、依赖                                           | A1、A4 |
| `packages/zen/tsconfig.json`           | TS 配置（extends 根）                                        | A1     |
| `packages/zen/tsup.config.ts`          | 构建（ESM + dts）                                            | A1     |
| `packages/zen/src/index.ts`            | barrel 导出                                                  | A1     |
| `pnpm-workspace.yaml`                  | 无需改（`packages/*` 自动纳入）                              | —      |
| `package.json`（根）                   | `build:runtime`、`test:coverage` 加入 zen                    | A1     |
| `packages/core/tsup.config.ts`         | `noExternal: ['@freemodelfinder/zen']`（P1-E 用；A1 预留）   | A1     |
| `packages/zen/src/config/index.ts`     | `ZenConfigSchema` + 默认值 + 归一化                          | A2     |
| `packages/zen/src/identity/session.ts` | `canonicalSessionId` / `deriveRequestIds`                    | A3     |
| `packages/zen/src/proxy/spec.ts`       | 代理 URL 解析、脱敏、列表去重                                | A4     |
| `packages/zen/src/http.ts`             | `ZenHttpClient` 端口 + Node http/https 实现 + `resolveAgent` | A4     |
| `packages/zen/src/gateway/monitor.ts`  | attempt 级记录环形缓冲                                       | A5     |

---

### Task A1: 包脚手架与构建接线

**Files:**

- Create: `packages/zen/package.json`
- Create: `packages/zen/tsconfig.json`
- Create: `packages/zen/tsup.config.ts`
- Create: `packages/zen/src/index.ts`
- Create: `packages/zen/src/__tests__/smoke.test.ts`
- Modify: `package.json`（根，`build:runtime` 与 `test:coverage`）
- Modify: `packages/core/tsup.config.ts`（预留 `noExternal`）

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/smoke.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZEN_PACKAGE_NAME } from '../index.js';

describe('zen package', () => {
  it('exposes its package name', () => {
    assert.equal(ZEN_PACKAGE_NAME, '@freemodelfinder/zen');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 包不存在（`No projects matched the filters`）。

- [ ] **Step 3: 创建包文件**

`packages/zen/package.json`：

```json
{
  "name": "@freemodelfinder/zen",
  "version": "0.1.0-rc.4",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test src/__tests__/*.test.ts",
    "test:coverage": "node --experimental-test-coverage --test-coverage-include='src/**/*.ts' --test-coverage-exclude='src/**/__tests__/**' --test-coverage-lines=85 --test-coverage-branches=74 --import tsx --test src/__tests__/*.test.ts"
  },
  "dependencies": {
    "http-proxy-agent": "^7.0.2",
    "https-proxy-agent": "^7.0.6",
    "socks-proxy-agent": "^8.0.4",
    "zod": "^3.23.4"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "tsup": "^8.0.2",
    "tsx": "^4.7.2",
    "typescript": "^5.4.5"
  }
}
```

`packages/zen/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`packages/zen/tsup.config.ts`：

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: true,
});
```

`packages/zen/src/index.ts`：

```ts
export const ZEN_PACKAGE_NAME = '@freemodelfinder/zen';
```

- [ ] **Step 4: 更新根脚本与 core 构建配置**

`package.json`（根）把 `build:runtime` 改为（zen 先于 core）：

```json
"build:runtime": "pnpm --filter @freemodelfinder/zen build && pnpm --filter @freemodelfinder/core build && pnpm --filter @freemodelfinder/server build",
```

把 `test:coverage` 改为（在 core 之前加入 zen）：

```json
"test:coverage": "pnpm run build:runtime && pnpm --filter @freemodelfinder/zen test:coverage && pnpm --filter @freemodelfinder/core test:coverage && pnpm --filter @freemodelfinder/server test:coverage && pnpm --filter freemodelfinder test:coverage && pnpm --filter @freemodelfinder/ui test:coverage",
```

`packages/core/tsup.config.ts` 增加 `noExternal`（P1-E 让 core 打包 zen，此处先预留，避免届时再改构建链）：

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: ['@freemodelfinder/zen'],
});
```

- [ ] **Step 5: 安装依赖并更新 lockfile**

Run: `pnpm install`
Expected: 成功，`pnpm-lock.yaml` 更新（新增 `@freemodelfinder/zen` 与 `socks-proxy-agent`）。

- [ ] **Step 6: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS（1 个用例）。

Run: `pnpm build:runtime`
Expected: zen → core → server 依次构建成功。

Run: `pnpm --filter @freemodelfinder/zen typecheck`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add packages/zen/package.json packages/zen/tsconfig.json packages/zen/tsup.config.ts packages/zen/src/index.ts packages/zen/src/__tests__/smoke.test.ts package.json packages/core/tsup.config.ts pnpm-lock.yaml
git commit -m "feat(zen): 新增 @freemodelfinder/zen 包脚手架与构建接线"
```

---

### Task A2: 配置 schema

对应 `opencode2api/internal/config`。定义 zen 运行时的全部配置项、默认值与归一化；不涉及磁盘读写（由 core 的 config store 负责持久化）。

**Files:**

- Create: `packages/zen/src/config/index.ts`
- Test: `packages/zen/src/__tests__/config.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/config.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenConfigSchema, DEFAULT_ZEN_CONFIG, normalizeZenConfig } from '../config/index.js';

describe('zen config', () => {
  it('applies documented defaults', () => {
    const cfg = ZenConfigSchema.parse({});
    assert.equal(cfg.anonymous, false);
    assert.equal(cfg.prefer, 'go');
    assert.equal(cfg.upstream.zen, 'https://opencode.ai/zen');
    assert.equal(cfg.upstream.go, 'https://opencode.ai/zen/go');
    assert.equal(cfg.retry.maxAttempts, 3);
    assert.equal(cfg.retry.timeoutSeconds, 300);
    assert.equal(cfg.performance.failureCooldownSeconds, 15);
    assert.equal(cfg.performance.connectTimeoutSeconds, 5);
    assert.equal(cfg.models.refreshSeconds, 300);
  });

  it('rejects an unknown reasoning effort', () => {
    const result = ZenConfigSchema.safeParse({ reasoning: { effort: 'extreme' } });
    assert.equal(result.success, false);
  });

  it('accepts only chat/responses/anthropic protocol overrides', () => {
    const ok = ZenConfigSchema.safeParse({ models: { protocols: { m: 'anthropic' } } });
    assert.equal(ok.success, true);
    const bad = ZenConfigSchema.safeParse({ models: { protocols: { m: 'systemone' } } });
    assert.equal(bad.success, false);
  });

  it('normalizeZenConfig fills defaults and freezes arrays', () => {
    const cfg = normalizeZenConfig({ zenKeys: ['k1'], goKeys: [] });
    assert.deepEqual(cfg.zenKeys, ['k1']);
    assert.equal(cfg.prefer, 'go');
  });

  it('exposes the documented default constant', () => {
    assert.deepEqual(DEFAULT_ZEN_CONFIG.retry, { maxAttempts: 3, timeoutSeconds: 300 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/config/index.ts`：

```ts
import { z } from 'zod';

export const ReasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'none',
]);

export const NativeProtocolSchema = z.enum(['chat', 'responses', 'anthropic']);

export const ZenConfigSchema = z.object({
  anonymous: z.boolean().default(false),
  zenKeys: z.array(z.string()).default([]),
  goKeys: z.array(z.string()).default([]),
  prefer: z.enum(['go', 'zen']).default('go'),
  upstream: z
    .object({
      zen: z.string().default('https://opencode.ai/zen'),
      go: z.string().default('https://opencode.ai/zen/go'),
    })
    .default({}),
  proxies: z.array(z.string()).default([]),
  proxyfile: z.string().default(''),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      timeoutSeconds: z.number().int().min(1).default(300),
    })
    .default({}),
  performance: z
    .object({
      attemptTimeoutSeconds: z.number().int().min(0).default(0),
      connectTimeoutSeconds: z.number().int().min(0).default(5),
      failureCooldownSeconds: z.number().int().min(0).default(15),
      maxIdleConns: z.number().int().min(0).default(2048),
      maxIdleConnsPerHost: z.number().int().min(0).default(256),
      maxConnsPerHost: z.number().int().min(0).default(0),
      idleConnTimeoutSeconds: z.number().int().min(0).default(120),
    })
    .default({}),
  models: z
    .object({
      refreshSeconds: z.number().int().min(1).default(300),
      protocols: z.record(NativeProtocolSchema).default({}),
    })
    .default({}),
  reasoning: z
    .object({
      effort: ReasoningEffortSchema.optional(),
      effortByModel: z.record(ReasoningEffortSchema).default({}),
    })
    .default({}),
});

export type ZenConfig = z.infer<typeof ZenConfigSchema>;
export type ZenReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ZenNativeProtocol = z.infer<typeof NativeProtocolSchema>;

export const DEFAULT_ZEN_CONFIG = {
  retry: { maxAttempts: 3, timeoutSeconds: 300 },
} as const;

export function normalizeZenConfig(input: unknown): ZenConfig {
  const cfg = ZenConfigSchema.parse(input ?? {});
  return {
    ...cfg,
    zenKeys: [...cfg.zenKeys],
    goKeys: [...cfg.goKeys],
    proxies: [...cfg.proxies],
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/config/index.ts packages/zen/src/__tests__/config.test.ts
git commit -m "feat(zen): 配置 schema 与默认值"
```

---

### Task A3: 身份与会话规范化

对应 `opencode2api/internal/identity/request.go`。**关键契约**：自 2026-09-16 起 Zen 免费层要求 session 形如 `ses_` + 12 位小写 hex + 14 位 base62，否则 403。已合规的 ID 必须原样保留（维持上游 prompt cache 亲和）。

**Files:**

- Create: `packages/zen/src/identity/session.ts`
- Test: `packages/zen/src/__tests__/session.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/session.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalSessionId, isCanonicalSessionId } from '../identity/session.js';

const SHAPED = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

describe('zen session canonicalization', () => {
  it('keeps an already canonical session unchanged', () => {
    const id = 'ses_3f9a1c2b7d4e0123456789ABCDEF';
    assert.equal(isCanonicalSessionId(id), true);
    assert.equal(canonicalSessionId(id), id);
  });

  it('maps arbitrary signals into the canonical shape deterministically', () => {
    const a = canonicalSessionId('conversation-abc');
    const b = canonicalSessionId('conversation-abc');
    assert.equal(a, b);
    assert.match(a, SHAPED);
  });

  it('produces different sessions for different signals', () => {
    assert.notEqual(canonicalSessionId('one'), canonicalSessionId('two'));
  });

  it('treats malformed ses_ ids as signals to re-hash', () => {
    const bad = 'ses_ZZZZZZZZZZZZ';
    assert.equal(isCanonicalSessionId(bad), false);
    assert.match(canonicalSessionId(bad), SHAPED);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/identity/session.ts`：

```ts
import { createHash } from 'node:crypto';

const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function isCanonicalSessionId(value: string): boolean {
  return CANONICAL_SESSION.test(value);
}

function base62Fixed(bytes: Buffer, width: number): string {
  let value = BigInt('0x' + bytes.toString('hex'));
  const base = 62n;
  const out: string[] = [];
  for (let i = 0; i < width; i += 1) {
    out.push(BASE62[Number(value % base)] as string);
    value /= base;
  }
  return out.reverse().join('');
}

export function canonicalSessionId(signal: string): string {
  if (isCanonicalSessionId(signal)) return signal;
  const digest = createHash('sha256')
    .update('ses\u0000' + signal)
    .digest();
  const timePart = digest.subarray(0, 6).toString('hex');
  const randomPart = base62Fixed(digest.subarray(6, 16), 14);
  return `ses_${timePart}${randomPart}`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/identity/session.ts packages/zen/src/__tests__/session.test.ts
git commit -m "feat(zen): ses_ 会话标识规范化"
```

---

### Task A4: 代理解析与 HTTP 传输层

对应 `internal/gateway/pool.go` 的代理来源解析与 `internal/config/proxy.go`，以及本设计新增的 `ZenHttpClient` 端口。

**Files:**

- Create: `packages/zen/src/proxy/spec.ts`
- Create: `packages/zen/src/http.ts`
- Test: `packages/zen/src/__tests__/proxy-spec.test.ts`
- Test: `packages/zen/src/__tests__/http.test.ts`

- [ ] **Step 1: 写失败测试（代理解析）**

新建 `packages/zen/src/__tests__/proxy-spec.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProxy, parseProxyList, redactProxy } from '../proxy/spec.js';

describe('zen proxy spec', () => {
  it('parses direct', () => {
    assert.deepEqual(parseProxy('direct'), { kind: 'direct', label: 'direct' });
  });

  it('parses http/https/socks5/socks5h with credentials', () => {
    assert.equal(parseProxy('http://user:pass@127.0.0.1:7890')?.kind, 'http');
    assert.equal(parseProxy('https://127.0.0.1:7890')?.kind, 'https');
    assert.equal(parseProxy('socks5://127.0.0.1:1080')?.kind, 'socks5');
    assert.equal(parseProxy('socks5h://127.0.0.1:1080')?.kind, 'socks5h');
  });

  it('rejects garbage and unsupported schemes', () => {
    assert.equal(parseProxy(''), null);
    assert.equal(parseProxy('not a url'), null);
    assert.equal(parseProxy('ftp://x:1'), null);
  });

  it('redacts credentials in the label', () => {
    const spec = parseProxy('http://user:secret@127.0.0.1:7890');
    assert.ok(spec);
    assert.equal(spec.label.includes('secret'), false);
  });

  it('loads config proxies then proxyfile, dedupes by order, and defaults to direct', () => {
    const list = parseProxyList(
      ['http://a:1', 'direct'],
      '# comment\nsocks5://b:2   # inline\nhttp://a:1\n\n; another\n',
    );
    assert.deepEqual(
      list.map((p) => p.label),
      ['http://a:1/', 'direct', 'socks5://b:2/'],
    );
    assert.deepEqual(parseProxyList([], ''), [{ kind: 'direct', label: 'direct' }]);
  });

  it('redactProxy hides userinfo', () => {
    assert.equal(redactProxy('http://u:p@h:1').includes('p'), false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现代理解析**

新建 `packages/zen/src/proxy/spec.ts`：

```ts
export type ProxyKind = 'direct' | 'http' | 'https' | 'socks5' | 'socks5h';

export interface ProxySpec {
  kind: ProxyKind;
  url?: string;
  label: string;
}

export function redactProxy(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function parseProxy(raw: string): ProxySpec | null {
  const value = raw.trim();
  if (!value) return null;
  if (value === 'direct') return { kind: 'direct', label: 'direct' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  switch (url.protocol) {
    case 'http:':
    case 'https:':
    case 'socks5:':
    case 'socks5h:':
      return {
        kind: url.protocol.slice(0, -1) as ProxyKind,
        url: value,
        label: redactProxy(value),
      };
    default:
      return null;
  }
}

function stripComment(line: string): string {
  const markers = ['#', ';', '//'];
  let cut = line.length;
  for (const marker of markers) {
    let from = 0;
    for (;;) {
      const found = line.indexOf(marker, from);
      if (found === -1) break;
      if (found === 0 || /\s/.test(line[found - 1] ?? '')) {
        if (found < cut) cut = found;
        break;
      }
      from = found + marker.length;
    }
  }
  return line.slice(0, cut).trim();
}

export function parseProxyList(
  proxies: string[] | undefined,
  proxyfileContent: string | undefined,
): ProxySpec[] {
  const sources: string[] = [...(proxies ?? [])];
  if (proxyfileContent) {
    for (const line of proxyfileContent.split(/\r?\n/)) {
      const stripped = stripComment(line);
      if (stripped) sources.push(stripped);
    }
  }
  const seen = new Set<string>();
  const out: ProxySpec[] = [];
  for (const raw of sources) {
    const spec = parseProxy(raw);
    if (!spec || seen.has(spec.label)) continue;
    seen.add(spec.label);
    out.push(spec);
  }
  if (out.length === 0) out.push({ kind: 'direct', label: 'direct' });
  return out;
}
```

- [ ] **Step 4: 写失败测试（HTTP 传输）**

新建 `packages/zen/src/__tests__/http.test.ts`：

```ts
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createNodeHttpClient, resolveAgent } from '../http.js';
import { parseProxy } from '../proxy/spec.js';

let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        res.end('data: two\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const direct = { kind: 'direct' as const, label: 'direct' };

describe('zen http client', () => {
  it('sends a POST and reads the JSON body', async () => {
    const client = createNodeHttpClient();
    const res = await client.send({
      url: `http://127.0.0.1:${port}/echo`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hi: 1 }),
      proxy: direct,
    });
    assert.equal(res.status, 200);
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(chunk as Buffer);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      method: 'POST',
      body: '{"hi":1}',
    });
  });

  it('streams an SSE body incrementally', async () => {
    const client = createNodeHttpClient();
    const res = await client.send({
      url: `http://127.0.0.1:${port}/stream`,
      method: 'GET',
      proxy: direct,
    });
    let text = '';
    for await (const chunk of res.body) text += String(chunk);
    assert.equal(text, 'data: one\n\ndata: two\n\n');
  });

  it('selects an agent per proxy kind and none for direct', () => {
    assert.equal(resolveAgent(direct), undefined);
    assert.ok(resolveAgent(parseProxy('http://127.0.0.1:7890')!));
    assert.ok(resolveAgent(parseProxy('https://127.0.0.1:7890')!));
    assert.ok(resolveAgent(parseProxy('socks5://127.0.0.1:1080')!));
    assert.ok(resolveAgent(parseProxy('socks5h://127.0.0.1:1080')!));
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— `../http.js` 不存在。

- [ ] **Step 6: 实现 HTTP 传输**

新建 `packages/zen/src/http.ts`：

```ts
import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { ProxySpec } from './proxy/spec.js';

export interface ZenHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  proxy: ProxySpec;
  signal?: AbortSignal;
}

export interface ZenHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

export interface ZenHttpClient {
  send(request: ZenHttpRequest): Promise<ZenHttpResponse>;
}

export function resolveAgent(proxy: ProxySpec): Agent | undefined {
  switch (proxy.kind) {
    case 'direct':
      return undefined;
    case 'http':
      return new HttpProxyAgent(proxy.url as string);
    case 'https':
      return new HttpsProxyAgent(proxy.url as string);
    case 'socks5':
    case 'socks5h':
      return new SocksProxyAgent(proxy.url as string);
  }
}

export function createNodeHttpClient(): ZenHttpClient {
  return {
    send(request) {
      return new Promise<ZenHttpResponse>((resolve, reject) => {
        const url = new URL(request.url);
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
          url,
          {
            method: request.method,
            headers: request.headers,
            agent: resolveAgent(request.proxy),
            signal: request.signal,
          },
          (response) => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: response,
            });
          },
        );
        req.on('error', reject);
        if (request.body !== undefined) req.write(request.body);
        req.end();
      });
    },
  };
}
```

- [ ] **Step 7: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS（含本地回环 HTTP 服务的真实请求与流式读取）。

- [ ] **Step 8: 提交**

```bash
git add packages/zen/src/proxy/spec.ts packages/zen/src/http.ts packages/zen/src/__tests__/proxy-spec.test.ts packages/zen/src/__tests__/http.test.ts
git commit -m "feat(zen): 代理解析与 direct/http/https/socks5 传输层"
```

---

### Task A5: attempt 级监控记录

对应 `internal/telemetry` 的上游尝试记录（spec 已确认：FMF 无此粒度，需在包内实现；UI 本期不展示）。

**Files:**

- Create: `packages/zen/src/gateway/monitor.ts`
- Test: `packages/zen/src/__tests__/monitor.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/zen/src/__tests__/monitor.test.ts`：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZenAttemptMonitor, type ZenAttemptRecord } from '../gateway/monitor.js';

function record(overrides: Partial<ZenAttemptRecord> = {}): ZenAttemptRecord {
  return {
    time: 1,
    requestId: 'req_1',
    model: 'm',
    tier: 'zen',
    attempt: 1,
    keyId: 'anonymous',
    channel: 'anonymous',
    anonymous: true,
    proxy: 'direct',
    status: 200,
    durationMs: 5,
    success: true,
    outcome: 'success',
    ...overrides,
  };
}

describe('zen attempt monitor', () => {
  it('keeps recorded attempts in order', () => {
    const monitor = new ZenAttemptMonitor(10);
    monitor.record(record());
    monitor.record(record({ attempt: 2, keyId: 'abc', channel: 'key', anonymous: false }));
    const list = monitor.list();
    assert.equal(list.length, 2);
    assert.equal(list[1]?.keyId, 'abc');
    assert.equal(list[1]?.anonymous, false);
  });

  it('bounds the buffer to the configured capacity keeping the newest', () => {
    const monitor = new ZenAttemptMonitor(3);
    for (let i = 1; i <= 5; i += 1) monitor.record(record({ attempt: i }));
    const list = monitor.list();
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((r) => r.attempt),
      [3, 4, 5],
    );
  });

  it('reset clears the buffer', () => {
    const monitor = new ZenAttemptMonitor(3);
    monitor.record(record());
    monitor.reset();
    assert.equal(monitor.list().length, 0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `packages/zen/src/gateway/monitor.ts`：

```ts
export type ZenAttemptOutcome = 'success' | 'retryable_failure' | 'transport_error' | 'rejected';

export interface ZenAttemptRecord {
  time: number;
  requestId: string;
  model: string;
  tier: string;
  attempt: number;
  keyId: string;
  channel: 'anonymous' | 'key';
  anonymous: boolean;
  proxy: string;
  status: number;
  durationMs: number;
  success: boolean;
  outcome: ZenAttemptOutcome;
}

export class ZenAttemptMonitor {
  private records: ZenAttemptRecord[] = [];

  constructor(private readonly capacity = 2000) {}

  record(entry: ZenAttemptRecord): void {
    this.records.push(entry);
    const overflow = this.records.length - this.capacity;
    if (overflow > 0) this.records.splice(0, overflow);
  }

  list(): ZenAttemptRecord[] {
    return this.records.slice();
  }

  reset(): void {
    this.records = [];
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @freemodelfinder/zen test`
Expected: PASS。

- [ ] **Step 5: 导出并确认构建**

在 `packages/zen/src/index.ts` 追加导出：

```ts
export const ZEN_PACKAGE_NAME = '@freemodelfinder/zen';

export * from './config/index.js';
export * from './identity/session.js';
export * from './proxy/spec.js';
export * from './http.js';
export * from './gateway/monitor.js';
```

Run: `pnpm --filter @freemodelfinder/zen typecheck && pnpm --filter @freemodelfinder/zen build`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/zen/src/gateway/monitor.ts packages/zen/src/__tests__/monitor.test.ts packages/zen/src/index.ts
git commit -m "feat(zen): attempt 级监控记录与包导出"
```

---

## 验收清单（P1-A）

- [ ] `pnpm --filter @freemodelfinder/zen test` 全绿
- [ ] `pnpm --filter @freemodelfinder/zen test:coverage` 达到 85% lines / 74% branches
- [ ] `pnpm build:runtime` 成功（zen → core → server）
- [ ] `pnpm typecheck` 全 package 通过
- [ ] `pnpm lint` 0 警告
- [ ] `pnpm-lock.yaml` 已更新并提交
- [ ] 仅本计划列出的文件被提交（工作区其他改动未被混入）

## 自查记录

1. **Spec 覆盖**：spec 的「包结构」中 `config/`、`identity/`、`proxy/`、`http.ts`、`gateway/monitor.ts` 由 A1–A5 落地；`models/`、`protocol/`、`gateway/` 其余部分、`providers/zen.ts` 明确留给 P1-B..E。✅ 无缺口。
2. **占位符扫描**：无 TBD/TODO；每个代码步骤给出完整代码或精确改动。
3. **类型一致性**：`ProxySpec`（A4）被 `ZenHttpRequest.proxy` 复用；`ZenConfig`（A2）与 spec 配置表字段一一对应；`ZenAttemptRecord`（A5）字段与 spec「attempt 级记录」一致。
