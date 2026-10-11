# Gateway Key 模型白名单 —— 实施计划

设计文档：`docs/superpowers/specs/2026-10-11-gateway-key-model-allowlist-design.md`

分支：`feat/key-model-allowlist`（从 main 切出）。每个任务走
TDD + 两阶段审查（规格符合性 → 代码质量）。

---

## Task 1：server 端白名单强制（核心行为）

**Files**
- Modify `packages/core/src/types.ts`
- Modify `packages/server/src/routes/openai.ts`
- Modify `packages/server/src/server.ts`
- Create `packages/server/src/__tests__/gateway-allowlist.test.ts`

**Step 1** `GatewayKeyEntry` 加字段：
```ts
  /** Composed real model ids this key may access. Omit or [] = unrestricted. */
  modelAllowlist?: string[];
```

**Step 2** `openai.ts`，在 `resolveGatewayKeyId`（第 53 行）旁加：
- `resolveGatewayKey(reg, req): GatewayKeyEntry | undefined` —— 把现有
  `resolveGatewayKeyId` 的循环体抽出返回整个 entry，`resolveGatewayKeyId`
  改为它的薄封装（`return entry?.id`）。
- `keyModelAllowlist(key): Set<string> | null` —— `undefined`/空数组/全非
  字符串 → `null`（不限制）；否则非空 Set。
- `modelAllowlistViolation(reg, key, model): string | null` ——
  1. `auto`/`default` → 拒绝（文案说明 auto 无法保证落在白名单内）
  2. `reg.resolveModel(model)` 抛错 → `null`（交给 handler 出常规错误）
  3. 命中 `composeModelId(resolved.provider.id, resolved.modelId)` → `null`
  4. 否则返回越权文案（列出允许的模型）

**Step 3** `GET /v1/models`（openai.ts:473）在别名替换前过滤：
```ts
const allowlist = keyModelAllowlist(resolveGatewayKey(reg, _req));
const visible = allowlist
  ? models.filter((m) => allowlist.has(composeModelId(m.provider, m.id)))
  : models;
```
`data:` 用 `visible`，`fmf` 块保持原样。

**Step 4** `server.ts` preHandler，在日限额块（559-579）之后：
```ts
const violation = modelAllowlistViolation(
  getRegistry(), matchedKey, extractGatewayModel(url, req.body),
);
if (violation) { return reply.code(403).send({ error: { message: violation, type: 'permission_error', code: 'model_not_allowed' } }); }
```
`extractGatewayModel(url, body)`：chat/messages/images/videos 取
`body.model`；`/v1beta/models/:model:generateContent` 从 path 取；
`/v1/videos/status|proxy` 和其他 → `null`（跳过）。

**Step 5** 测试 `gateway-allowlist.test.ts`，复用 model-aliases.test.ts 的
`appWith` 脚手架（`ProviderRegistry` + 假 provider + `createServer`）。
覆盖：
1. 未配置白名单 → `/v1/models` 返回全部，行为与现在一致
2. 白名单 1 个模型 → `/v1/models` 只返回它
3. 白名单命中空目录 → `data: []`（不 500）
4. 白名单用真实 id，模型带别名 → 仍显示别名 + `alias_of`
5. 白名单命中裸目录 id（openrouter 形态）→ 通过
6. POST 白名单内模型 → 200
7. POST 白名单外模型 → 403 `model_not_allowed`
8. POST 别名，其目标是白名单内 → 200
9. POST `auto` + 有限制 key → 403
10. POST `auto` + 无限制 key → 不受影响
11. 不限制 key 调一切 → 与现在一致
12. 本机 UI 请求（带 `x-fmf-client: ui`、无 key）不受限制
13. 白名单含非字符串/空白元素 → 视为不限制

---

## Task 2：管理 API

**Files**
- Modify `packages/server/src/server.ts`（`GET`/`POST /api/gateway`，1648-1772）
- Append tests 到 `gateway-allowlist.test.ts`

- `GET /api/gateway`：每个 key 增加 `modelAllowlist: k.modelAllowlist ?? []`
- `POST /api/gateway`：
  - Body 类型加 `modelAllowlist?: unknown`
  - `create`：过滤非字符串/空白、trim、去重后存入
  - `update`：传入（含 `[]`）→ 覆盖；不传 → 保持不变

测试：
1. GET 返回 `modelAllowlist: []` 当未配置
2. create 带 `modelAllowlist` → 持久化并回显
3. create 带脏数据（数字、空串、重复）→ 过滤去重
4. update 设置白名单 → 生效
5. update 传 `[]` → 清空为不限
6. update 不传字段 → 保留原值

---

## Task 3：UI

**Files**
- Modify `packages/ui/app/components/SettingsView.tsx`
- Modify `packages/ui/app/i18n.tsx`
- Modify `packages/ui/test/server.ts`
- Create `packages/ui/app/components/__tests__/gateway-allowlist.test.tsx`

- `GatewayKeyInfo` 加 `modelAllowlist?: string[]`
- key 元信息行加一项：`模型: N 个` 或 `全部`
- 每个 key 加「编辑模型」按钮，展开一个可折叠的模型多选（用下拉逐个添加，
  已选项可移除）
- 保存走 `POST /api/gateway` `action: 'update'` + `id` + `modelAllowlist`
- 新建 key 时不设置白名单（默认不限，符合需求）
- i18n zh/en 成对加键，注意 key-parity 测试
- `test/server.ts` 的 `/api/gateway` handler 返回补 `modelAllowlist: []`

测试：
1. 未配置白名单的 key 显示「全部」
2. 展开编辑器，从下拉加一个模型，保存 → POST payload 含 `modelAllowlist`
3. 移除已选模型，保存 → POST 空数组
4. 编辑 key A 不影响 key B 的白名单

---

## Task 4：全量校验

`pnpm build:runtime` → `pnpm typecheck` → `pnpm test:coverage` → `pnpm lint`
→ prettier 内容级校验（`--stdin-filepath`，避开 Windows CRLF 假阳性）

---

## 完成标准

- [ ] 未配置白名单的 key：`/v1/models` 与所有 POST 行为与现在**完全一致**
- [ ] 配置白名单的 key：`/v1/models` 只返回白名单内模型
- [ ] 配置白名单的 key：调白名单外模型 403（不是 404）
- [ ] 配置白名单的 key：调 `auto` 403
- [ ] 别名与白名单并存：白名单按真实 id 存，客户端仍用别名请求
- [ ] 本机 UI 不受限制
- [ ] 设置页可编辑每个 key 的白名单
- [ ] 四条门禁全绿
