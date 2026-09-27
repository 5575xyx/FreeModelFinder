# 千帆（Qianfan）一等 Provider 实施计划

日期：2026-09-27
状态：approved

## 需求与关键决策

- **provider id**: `qianfan`（对齐 `QIANFAN_API_KEY` 与社区先例），base URL `https://qianfan.baidubce.com/v2`（OpenAI 兼容，Bearer `bce-v3/ALTAK-...`）
- **免费清单**（官方公告 2026-05-21 + 第三方 2026-08-25 核对，6 个候选）：
  `ernie-speed-8k`(8K)、`ernie-speed-128k`(128K)、`ernie-lite-8k`(8K)、`ernie-lite-8k-0922`(8K)、`ernie-lite-128k`(128K)、`ernie-tiny`(ctx 不标)
- **剔除**：`ERNIE-Speed/Lite-AppBuilder`（官方已退役，替代品 Qianfan-Agent-* 是付费）；`ernie-3.5-8K`（仅第三方声称免费，默认不列，防误标收费模型）
- **listModels 混合策略**（sensenova 模式变体）：有 key 时 GET `/v2/models`，与免费白名单**大小写不敏感求交集**（动态侧写法为准，解决 id 大小写不确定 + 自动剔除退役型号）；接口失败/无 key 回退静态清单。交集只裁剪不新增，永不把付费模型标为 free
- **auto 路由评分**：`providerBaseline qianfan: 45`（QPS≈1/s ≈ 60 RPM，低于 zhipu 70）
- **quota.ts 不加策略**（QPS 确切值未证实，宁缺勿错）
- **cline-free**：只写接入文档（custom 来源），不做 provider
- README/FREE_MODELS.md **不手改**（自动生成），下次 `pnpm audit:daily`（带 key）自动收录
- 不推送，完成后提醒用户

## Task 1 — core provider（主体）

| 文件                                          | 改动                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts:3`                | ProviderIdSchema 加 `'qianfan'`                                                                                                                                                                                                                                                                                                   |
| `packages/core/src/providers/qianfan.ts`      | 新建。`QianfanProvider extends OpenAICompatibleProvider`，`id='qianfan'`，`displayName`，baseUrl 默认 `https://qianfan.baidubce.com/v2`（尊重 `ctx.credentials.baseUrl` 覆盖），`QIANFAN_FREE_MODELS` 白名单 Set + `QIANFAN_STATIC_MODELS: ModelInfo[]`（含 displayName/contextWindow/free/description），`listModels()` 混合策略 |
| `packages/core/src/providers/index.ts`        | 导出                                                                                                                                                                                                                                                                                                                              |
| `packages/core/src/registry.ts:37`            | `PROVIDER_CTORS` 加 `qianfan: QianfanProvider`（**exhaustive Record，不加 typecheck 必红**）；`resolveModel` heuristic 加 `modelId.toLowerCase().startsWith('ernie') → qianfan`（仿 `glm-` → zhipu，registry.ts:346，包 try/catch fallthrough）                                                                                   |
| `packages/core/src/config/store.ts:64`        | DEFAULT_CONFIG providers 加 `qianfan: { enabled: false }`                                                                                                                                                                                                                                                                         |
| `packages/core/src/router/auto-router.ts:148` | `providerBaseline` 加 `qianfan: 45`                                                                                                                                                                                                                                                                                               |

**listModels 语义**（qianfan.ts 内实现）：

1. 有 apiKey 且 `fetch(`${base}/models`)` 成功且返回数组：对动态 id 与白名单做 toLowerCase 交集；命中项用**动态侧写法**作为最终 id，静态元数据（displayName/contextWindow/description）保留；结果非空则返回
2. 任何失败/无命中/无 key：返回 `QIANFAN_STATIC_MODELS` 静态清单
3. 动态接口返回格式兼容 OpenAI `{data:[{id}]}`；解析失败按失败处理

**测试**（跟随现有模式）：

- `provider-contracts.test.ts`：`openAiCompatibleProviders` 数组加 `['qianfan', QianfanProvider]`；listModels 失败语义表加 `['qianfan', new QianfanProvider({credentials:{apiKey:'key'}, fetchImpl: async()=>jsonResponse({data:[]})}), 'fallback']`（空动态 → 静态回退）
- `free-catalog.test.ts` 新增 describe/it：
  - 无 fetchImpl/失败时静态回退返回全部 6 个免费 id 且 `free===true`
  - 动态交集：mock `/models` 返回 `['ERNIE-Speed-8k', 'ernie-5.0']`（大小写不同 + 付费模型）→ 只返回 `ernie-speed-8k`（采用动态大小写），付费模型不混入
  - 动态全不匹配（如仅付费）→ 回退静态清单
- registry resolveModel 启发式：`ernie-speed-8k` 裸 id → provider `qianfan`（放在 `registry/__tests__/registry.test.ts`，参考现有 heuristic 测试写法；若现有测试对 getProvider 需要 config fixture，按现有模式提供）

验证：`pnpm --filter @freemodelfinder/core build` 后 `pnpm --filter @freemodelfinder/core test`

## Task 2 — server + cli 接入

- `packages/server/src/onboarding.ts:14` `ONBOARDING_ENVIRONMENT_KEYS` 加 `qianfan: ['QIANFAN_API_KEY']`
- `packages/server/src/server.ts:88` `PROVIDER_LABELS` 加 `qianfan: 'Baidu Qianfan'`
- `packages/cli/src/commands/key.ts:14` `KNOWN_PROVIDERS` 加 `{ id: 'qianfan', label: 'Baidu Qianfan', hint: 'https://console.bce.baidu.com/qianfan/ais/console/apiKey' }`
- OnboardingWizard 硬编码 PROVIDERS（仅 openrouter/gemini）**不动**——它只按自身 key 查环境变量，无崩溃风险
- 如 server 测试对 environment 列表有断言则按需适配（现有测试用 `.find()`，预期无改动）

验证：`pnpm --filter @freemodelfinder/core build`（server 测试吃 core dist）→ `pnpm --filter @freemodelfinder/server test` → `pnpm --filter freemodelfinder test`

## Task 3 — UI 接入

- `packages/ui/app/lib/platforms.ts`：
  - `SETTINGS_PROVIDERS` 加条目：`{ id: 'qianfan', label: '百度千帆 Baidu Qianfan', link: 'https://console.bce.baidu.com/qianfan/ais/console/apiKey', guide: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j', hint: '官方公告永久免费的 ERNIE Speed / Lite 系列，QPS 限速约 1 次/秒' }`
  - `providerLabelKey` map 加 `qianfan: 'platforms.qianfan.label'`
- `packages/ui/app/i18n.tsx`：加 4 条（zh/en × label/hint）。`displayHint = t(providerHintKey(id))` **强制要求** i18n key，缺失会显示裸 key
- UI 测试如有 settings provider 卡片计数断言则适配

验证：`pnpm --filter @freemodelfinder/ui exec vitest run`（settings.test.tsx 全量跑偶发 flaky，可单跑该文件）

## Task 4 — 审计脚本 + 文档

- `scripts/audit-free-models.mjs` `PROVIDER_META` 加：
  `{ id: 'qianfan', display: 'Baidu Qianfan', envKeys: ['QIANFAN_API_KEY'], freeType: '官方永久免费型号', freeBasis: '官方公告永久免费的 ERNIE Speed / Lite 白名单，实时目录求交集（AppBuilder 已退役）', risk: 'QPS 限速约 1 次/秒；免费清单与型号以官方政策为准，退役型号由交集自动剔除' }`
- `scripts/update-readme-audit.mjs` hint map 加 `qianfan: '官方永久免费型号'`
- 新建 `scripts/verify-qianfan.mjs`（仿 `scripts/verify-sensenova.mjs` 结构）：读 `QIANFAN_API_KEY`，拉 `/v2/models` ∩ 白名单，逐模型发 1-token 最小 chat 实测，打印结果
- 新建 `docs/CLINE_FREE.md`：cline-free 本地反代（`http://localhost:8787/v1`、`sk-cline-*`）走 FreeModelFinder「自定义来源」接入的步骤 + 风险说明（灰色逆向、依赖本机常驻进程、额度随时变、不做一等 provider 的原因）
- `docs/USAGE.md:125` 环境变量列表补 `QIANFAN_API_KEY`
- README/FREE_MODELS.md **不手改**

## Task 5 — 全量验证 + 两阶段审查

每个 Task 完成后：spec compliance review → code quality review（修复循环直到通过）。
全部完成后全量验证链（PowerShell 用 `; if ($?) { }` 串联，禁用 `&&`）：

```
逐文件 npx prettier --write（仅改动文件）
npx eslint <改动文件> --max-warnings=0
pnpm --filter @freemodelfinder/core build
pnpm --filter @freemodelfinder/core test
pnpm --filter @freemodelfinder/server test
pnpm --filter freemodelfinder test
pnpm --filter @freemodelfinder/ui exec vitest run
pnpm build:runtime; if ($?) { pnpm typecheck }
```

最终派 final reviewer 审整体实现。

## 风险与既知事项

1. 免费清单时效性：官方文档直连被墙；`verify-qianfan.mjs` + 动态交集 + failover 永久剔除三重自愈
2. `/v2/models` 端点存在性未证实 → 失败即回退静态，无功能损失
3. 既有范围外失败：CLI dual-listener 测试（不修）
4. 仓库级 `pnpm format:check` 因 CRLF 噪音失败——只做逐文件 prettier
5. 不跑 `pnpm build`/`pnpm test:pack`；不推送
