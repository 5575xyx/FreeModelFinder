# P1-E：Zen 接入 FreeModelFinder（provider、UI、构建与发布）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已完成的 `@freemodelfinder/zen` 运行时接入 FMF 网关：core 薄壳 provider（映射数据、匿名/key 准入、`listModels`）、registry/auto-router/配额、server `hasKey`、UI 面板与 i18n、CLI、audit、Dockerfile、`verify-release`、环境变量与文档；并关闭 P1-D 交接清单中的接口级缺陷与 `extra` 加密阻塞项。

**Architecture:** core 依赖 zen（`workspace:*` + `tsup noExternal` 已在前阶段预留）。`packages/core/src/providers/zen.ts` 是唯一新增的 core 文件，做结构映射（core `ChatRequest`/`ChatResponse` 与 zen `ZenRequest`/`ZenChatResponse` 结构等价，映射为薄层）。其余是配置/接线/UI/脚本改动。

**Tech Stack:** TypeScript、Fastify、zod、Next.js（UI）、Node 内置 test runner / Vitest。

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-zen-integration-design.md`（「配置、UI 与接入点」节 + 「必改接入点」表 + 「明确不移植清单」）
**上游计划：** `docs/superpowers/plans/2026-09-29-p1d-zen-runtime.md`（P1-E 交接清单）

---

## 执行约定

- 逐任务 TDD；只 `git add` 本任务列出的文件，绝不 `git add -A`（工作区有大量无关未提交改动）。
- 不推送（按 `AGENTS.md`）。
- **优先级**：H1（core provider + 构建接线）与 H2（P1-D 交接的接口级缺陷 I-1/I-2）最先，其余随后。

## 文件结构（P1-E）

| 文件/位置                                                                                                                                   | 职责                                         | 任务  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----- |
| `packages/zen/src/gateway/runtime.ts`                                                                                                       | 补 `loadCache()` 接线 + 请求 `signal`/总超时 | H2    |
| `packages/core/package.json`、`packages/core/src/providers/zen.ts`、`packages/core/src/providers/index.ts`                                  | core 依赖 zen + 薄壳 provider                | H1    |
| `packages/core/src/types.ts`                                                                                                                | `ProviderIdSchema` 加 `'opencode'`           | H1    |
| `packages/core/src/registry.ts`                                                                                                             | `PROVIDER_CTORS` 加 `opencode`               | H1    |
| `packages/core/src/router/auto-router.ts`、`packages/core/src/quota.ts`                                                                     | baseline / policies                          | H3    |
| `packages/server/src/server.ts`、`packages/server/src/onboarding.ts`                                                                        | `hasKey` 分派 + env                          | H3    |
| `packages/ui/app/lib/platforms.ts`、`i18n.tsx`、`components/SettingsView.tsx`                                                               | 面板、i18n、空 key 放行、匿名开关            | H4    |
| `packages/cli/src/commands/key.ts`、`scripts/audit-free-models.mjs`、`scripts/update-readme-audit.mjs`、`.github/workflows/daily-audit.yml` | CLI/audit                                    | H5    |
| `Dockerfile`、`scripts/verify-release.mjs`、`packages/cli/package.json`                                                                     | 打包/发布                                    | H6    |
| `packages/core/src/config/store.ts`                                                                                                         | `extra` 敏感字段加密（spec 阻塞项）          | H7    |
| `docs/USAGE.md`、`docs/API.md`                                                                                                              | 文档                                         | H5    |
| `packages/zen/src/index.ts`                                                                                                                 | （如需要）导出补充                           | H1/H8 |

---

### Task H1: core 薄壳 provider 与构建接线

**Files:**

- Modify: `packages/core/package.json`（加 `@freemodelfinder/zen: workspace:*`）
- Modify: `packages/core/src/types.ts`（`ProviderIdSchema` 加 `'opencode'`）
- Create: `packages/core/src/providers/zen.ts`
- Modify: `packages/core/src/providers/index.ts`（barrel）
- Modify: `packages/core/src/registry.ts`（`PROVIDER_CTORS` 加 `opencode`）
- Test: `packages/core/src/providers/__tests__/zen.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/providers/__tests__/zen.test.ts`：构造 `ZenProvider`（注入 `fetchImpl` 与最小 credentials），断言：

- `hasCredentials()` 在 `extra.anonymous === true` 且无 key 时为 true；无 anonymous 且无 key 时为 false；
- `listModels()` 经假 fetch（喂目录/定价）返回 `ModelInfo[]`，含 `provider: 'opencode'` 与 `free` 标记；
- `chat(req)` 把 core `ChatRequest` 映射为 zen 请求并用假 http 客户端返回 `ChatResponse`（含 `raw`/`rawProtocol` 传递）。

（具体 fake 注入方式参考 `providers/__tests__/provider-contracts.test.ts` 与 zen 的 `createZenGateway` 注入项。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build:runtime && pnpm --filter @freemodelfinder/core test`
Expected: FAIL（`opencode` 不在 ProviderId、provider 不存在）。

- [ ] **Step 3: 实现**

- `packages/core/src/types.ts`：`ProviderIdSchema` 加 `'opencode'`。
- `packages/core/src/providers/zen.ts`：`export class ZenProvider extends BaseProvider`：
  - `id='opencode'`、`displayName='OpenCode Zen'`；
  - 懒建 `ZenGateway`（`createZenGateway`）从 `ctx.credentials` 读配置：`apiKeys`→`zenKeys`、`extra.goKeys`→`goKeys`、`extra.anonymous`、`extra.prefer`、`extra.upstream`、`extra.proxies`、`extra.proxyfile`、`extra.retry`、`extra.performance`、`extra.models`、`extra.reasoning`；`httpClient`/`fetchImpl` 用 `ctx.fetchImpl` 与可选注入；
  - `hasCredentials()`：`extra.anonymous === true || keyPool(非空)`；
  - `listModels()`：`gateway.refresh()` 后取 `listRoutes(hasZen, hasGo, anonymous)` → `ModelInfo[]`（`free` 来自 `catalog.isFreeModel`）；
  - `chat(req)`：core→zen（结构等价，直接传），`await gateway.chat(zen)` → core `ChatResponse`（含 `raw`/`rawProtocol`）；
  - `stream(req)`：`for await (chunk of gateway.stream(zen))` → core `StreamChunk`。
- `providers/index.ts` 导出；`registry.ts` 的 `PROVIDER_CTORS` 加 `opencode: ZenProvider`。

- [ ] **Step 4: 安装并验证**

Run: `pnpm install`（更新 lockfile）
Run: `pnpm build:runtime && pnpm --filter @freemodelfinder/core test && pnpm --filter @freemodelfinder/core typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/types.ts packages/core/src/providers/zen.ts packages/core/src/providers/index.ts packages/core/src/registry.ts packages/core/src/providers/__tests__/zen.test.ts
git commit -m "feat(core): OpenCode Zen 薄壳 provider 与构建接线"
```

---

### Task H2: 关闭 P1-D 交接的接口级缺陷（I-1 loadCache、I-2 超时/signal）

**Files:**

- Modify: `packages/zen/src/gateway/runtime.ts`
- Modify: `packages/zen/src/protocol/types.ts`（`ZenRequest.signal?`）
- Test: `packages/zen/src/__tests__/gateway-runtime.test.ts`（追加）

- [ ] **Step 1: 写失败测试**：`start()`（或 `createZenGateway`）会调用 `loadCache()`（用临时缓存文件断言冷启动后 `snapshot().cacheSource==='disk'`）；`chat` 传入 `signal` 时在 abort 后拒绝；总超时到达后拒绝。

- [ ] **Step 2–4: 实现**
- `createZenGateway`/`start()`：先 `await refresher.loadCache()`，再 `start()`；接口暴露 `loadCache()`。
- `ZenRequest` 加 `signal?: AbortSignal`；`chat`/`stream` 用 `config.retry.timeoutSeconds` 包一个 `AbortSignal.timeout(...)` 与调用方 signal 组合（`AbortSignal.any`），透传到 `doUpstream`；`connectTimeoutSeconds`/`attemptTimeoutSeconds` 接入 `ZenHttpRequest`（http.ts）。

- [ ] **Step 5: 提交**

```bash
git add packages/zen/src/gateway/runtime.ts packages/zen/src/protocol/types.ts packages/zen/src/__tests__/gateway-runtime.test.ts
git commit -m "fix(zen): 启动读取磁盘缓存并为请求接入超时与取消"
```

---

### Task H3: registry / auto-router / 配额 / server `/api/config`

**Files:**

- Modify: `packages/core/src/router/auto-router.ts`（`providerBaseline` 加 `opencode`）
- Modify: `packages/core/src/quota.ts`（`PROVIDER_POLICIES` 可选加 `opencode`）
- Modify: `packages/server/src/server.ts`（`PROVIDER_LABELS` + `hasKey` 分派）
- Modify: `packages/server/src/onboarding.ts`（env keys）
- Test: `packages/server/src/__tests__/`（新增一个 opencode hasKey/匿名用例）

- [ ] **Step 1–4: 实现**
- `hasKey` 从 cline 硬编码特判改为按 provider 分派：`opencode → !!s?.enabled && (extra.anonymous === true || apiKeys.length>0)`；`PROVIDER_LABELS.opencode = 'OpenCode Zen'`。
- `providerBaseline` 给 `opencode` 一个 RPM 分数；`quota.ts` 视需要加条目。
- onboarding env：`OPENCODE_API_KEY`（zen keys）等。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/router/auto-router.ts packages/core/src/quota.ts packages/server/src/server.ts packages/server/src/onboarding.ts <new test files>
git commit -m "feat(server,core): opencode provider 标签、hasKey 分派与路由接线"
```

---

### Task H4: UI 面板 / i18n / 空 key 放行

**Files:**

- Modify: `packages/ui/app/lib/platforms.ts`
- Modify: `packages/ui/app/i18n.tsx`（zh + en）
- Modify: `packages/ui/app/components/SettingsView.tsx`
- Test: `packages/ui/app/components/__tests__/settings.test.tsx`（追加）

- [ ] **Step 1–4: 实现**
- `SETTINGS_PROVIDERS` 加 `opencode`（label/link/guide）；`i18n` 补中英 `platforms.opencode.hint`（parity 测试强制）。
- opencode 专属面板：匿名通道开关、zen/go 两个 key 池、prefer、代理列表、高级（retry/models/reasoning）。
- 空 key 放行：`saveProvider()` 在 `anonymous===true` 时允许无 key 启用；卡片 `enabled = state?.enabled && (state.hasKey || state.anonymous)`。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/app/lib/platforms.ts packages/ui/app/i18n.tsx packages/ui/app/components/SettingsView.tsx packages/ui/app/components/__tests__/settings.test.tsx
git commit -m "feat(ui): OpenCode Zen 设置面板、i18n 与匿名通道启用"
```

---

### Task H5: CLI / audit / 文档

**Files:**

- Modify: `packages/cli/src/commands/key.ts`
- Modify: `scripts/audit-free-models.mjs`、`scripts/update-readme-audit.mjs`
- Modify: `.github/workflows/daily-audit.yml`
- Modify: `docs/USAGE.md`、`docs/API.md`

- [ ] **Step 1–4: 实现**：CLI `KNOWN_PROVIDERS` 加 `opencode`；audit 的 `PROVIDER_META` 加 zen（动态抓取 + 定价）；workflow 注入 secrets；文档补环境变量与用法。`README.md`/`FREE_MODELS.md` 由脚本生成，勿手改。

- [ ] **Step 5: 提交**

```bash
git add packages/cli/src/commands/key.ts scripts/audit-free-models.mjs scripts/update-readme-audit.mjs .github/workflows/daily-audit.yml docs/USAGE.md docs/API.md
git commit -m "feat(cli,scripts,docs): opencode provider 接入 audit/CLI/文档"
```

---

### Task H6: Dockerfile / verify-release / CLI 构建依赖

**Files:**

- Modify: `Dockerfile`（COPY + build `packages/zen`）
- Modify: `scripts/verify-release.mjs`（manifest 加 `packages/zen/package.json`）
- Modify: `packages/cli/package.json`（`build:dependencies` 加 zen）

- [ ] **Step 1–4: 实现**：让 `pnpm install --frozen-lockfile` + `build:runtime` + CLI 打包在 Docker 与发布校验下都包含 zen。

- [ ] **Step 5: 提交**

```bash
git add Dockerfile scripts/verify-release.mjs packages/cli/package.json
git commit -m "build: Docker/发布校验/CLI 构建纳入 @freemodelfinder/zen"
```

---

### Task H7: `extra` 敏感字段加密（spec 阻塞项）

**Files:**

- Modify: `packages/core/src/config/store.ts`
- Test: `packages/core/src/config/__tests__/store.test.ts`（追加）

- [ ] **Step 1–4: 实现**：扩展 `encryptProviders`/解密路径，使 `extra` 内的敏感字段（至少 `proxies[]`，含 `user:pass@`）加密落盘；`GET /api/config` 脱敏输出。补回归测试（既有 custom `sources` 不受影响）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/config/store.ts packages/core/src/config/__tests__/store.test.ts
git commit -m "fix(core): 加密 extra 敏感字段（proxies 凭据）"
```

---

### Task H8: 全量验证与收尾

- [ ] **Step 1: 全量验证**

Run（CI 顺序，跳过 docker 与仓库级 format）：
`pnpm build:runtime && pnpm typecheck && pnpm lint && pnpm --filter @freemodelfinder/zen test && pnpm --filter @freemodelfinder/core test && pnpm --filter @freemodelfinder/server test && pnpm --filter freemodelfinder test && pnpm --filter @freemodelfinder/ui test`
Expected: 全绿。对本次改动文件跑 `pnpm exec prettier --check`。

- [ ] **Step 2: 真实上游冒烟（手动，不入 CI）**

可选：`node scripts/zen-smoke.mjs`（本阶段新建，打真 Zen 匿名 `/v1/models` 与一次免费模型推理），验证 UA/session/agent 形变在真实上游通过。若网络/地区不可用，记录并跳过。

- [ ] **Step 3: 提交（如有）**

---

## 验收清单（P1-E）

- [ ] core `opencode` provider 可用；`pnpm build:runtime`/`typecheck`/`lint` 通过
- [ ] 现有 17 provider 与 P0 的 401/175 测试无回归
- [ ] `loadCache` 与请求超时已接线（I-1/I-2）
- [ ] `extra` 加密阻塞项关闭
- [ ] 仅计划文件被提交

## 自查记录

1. **Spec 覆盖**：spec「必改接入点」表 22 项由 H1/H3/H4/H5/H6 覆盖；「不移植清单」已遵守；`extra` 加密阻塞项由 H7；P1-D 交接 11 项由 H2（接口级）+ 本计划各任务；其余（key↔代理重绑、流式 raw 保真、signature 承载等）在报告中逐条标注为「已修 / 显式有损 / 延后」。
2. **占位符扫描**：H1/H2/H7 给出具体行为规格；H3–H6 为接入点清单（非算法实现），逐文件给出。
3. **类型一致性**：core provider 依赖 zen 的结构等价类型；`ProviderId` 加 `'opencode'` 后全类型链自动跟随。

## 交付状态与剩余 follow-up

**已交付**：core `opencode` provider 与构建接线、I-1（磁盘缓存实读）/I-2（超时与取消）、server `hasKey` 分派、auto-router/onboarding、UI 面板与匿名通道、CLI/audit/文档、Docker/verify-release/CLI 构建、`extra` 加密（proxies + goKeys）、响应侧同协议 `raw` 零损透传（非流式）。全量：`build:runtime`/`typecheck` 5 包/lint 0 警告/zen 195/core 417/server 181/cli 14/ui 108 全绿；新增/改动文件 prettier 通过。

**已知延后项（后续 follow-up，非本期阻断）**：

| #   | 项                                                                                                                                | 说明                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | 客户端取消贯通                                                                                                                    | core `ChatRequest` 无 `signal`，server 未传 AbortSignal；仅 zen 内部总超时生效 |
| 2   | 会话/请求 id 从客户头派生                                                                                                         | 当前随机生成，会话亲和/prompt cache 未生效                                     |
| 3   | 模型发现走代理池                                                                                                                  | `refresh` 用全局 fetch，地区受限环境目录刷新易失败                             |
| 4   | key↔代理重绑定                                                                                                                    | 缺失 `RebindProxy`/`RestoreProxy`；key 游标不跳过不健康代理                    |
| 5   | 代理健康复查调度                                                                                                                  | 15 分钟 Cloudflare trace 复查未落地；超时未置 unhealthy                        |
| 6   | 非 2xx 错误体透传                                                                                                                 | 未回传上游 `{error:{type,message}}`/`Retry-After`                              |
| 7   | 流式 `raw` 字节级保真                                                                                                             | 当前为解析后的 `{event,data}`；非流式已实现                                    |
| 8   | Anthropic `thinking.signature` 承载                                                                                               | 跨协议重放有损                                                                 |
| 9   | `snapshot`/`Diagnostic` 准确性                                                                                                    | `exposed`/`staleAfter`/`lastRefresh` 待补                                      |
| 10  | pricing `FirstString` 空串语义、`name_free` 回退 source                                                                           | 诊断字段差异                                                                   |
| 11  | `docs/API.md`、`provider-contracts.test.ts` 登记、`scripts/zen-smoke.mjs`、`DEFAULT_CONFIG.providers.opencode`、server 端到端测试 | 文档/测试完备性                                                                |
