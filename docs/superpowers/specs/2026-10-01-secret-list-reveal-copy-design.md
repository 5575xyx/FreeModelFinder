# 密钥/代理条目的删除、按需揭示与复制设计

日期：2026-10-01
状态：已批准（设计经用户逐项确认：移除粒度 = 单条删除 + 一键清空；展示 = 密码脱敏；明文下发 = 按需揭示单条；揭示范围 = Key + 代理；复制 = 新增按钮并修复非安全上下文失败）

## 背景

OpenCode Zen 设置面板的「代理列表」区块只能整体覆盖写入，没有删除能力：保存成功后输入框清空，界面仅剩「已保存 N 个」计数，既看不到条目内容，也无法移除其中某一项（`packages/ui/app/components/SettingsView.tsx:327-359`）。保存按钮在输入为空时禁用（`:347`），因此连「清空」都做不到。

同时暴露两个相关缺陷：

1. **脱敏条目无法取回明文**。上游 API Key 以 `…c4d0` 展示（`SettingsView.tsx:2204` 渲染 `row.hint`，由 `server.ts:299-307` 的 `buildKeyMeta` 生成），代理密码同样脱敏。用户无法核对配置、也无法复制实际值。
2. **复制在非安全上下文下必然失败**。`SettingsView.tsx:1296` 直接调用 `navigator.clipboard.writeText`，而 Clipboard API 仅在 secure context 可用。以 `http://<公网IP>:11435` 访问面板时 `navigator.clipboard` 为 `undefined`，抛 `TypeError` 被 `catch` 捕获，弹出「复制失败，请手动选中复制」。同类写法在 `TesterView.tsx:473`（同样报错）与 `ClineAccountsPanel.tsx:389`（`navigator.clipboard?.writeText` 静默失败，复制无反应也无提示）。

### 安全基线（决定明文下发方式的硬约束）

`/api/*` 管理接口**没有凭证级鉴权**，唯一守卫是 Origin/Referer + loopback 启发式（`server.ts:458-472`、`171-186`）。默认 Docker 部署下这三项叠加使管理面暴露在 `0.0.0.0`：

| 配置项                   | 位置                    | 值                               |
| ------------------------ | ----------------------- | -------------------------------- |
| 端口映射                 | `docker-compose.yml:10` | `"11435:11435"` → 绑定 `0.0.0.0` |
| 监听地址                 | `Dockerfile:57`         | `--host 0.0.0.0`                 |
| 绕过 loopback 校验的开关 | `docker-compose.yml:13` | `FREEMODELFINDER_TRUST_UI=true`  |

`x-fmf-client: ui` 是客户端可任意伪造的普通请求头，因此任何能连到该端口的客户端都能读写全部 provider 配置。

这一基线直接排除「随 `GET /api/config` 一并下发明文」的方案：那会让每次打开设置页都把所有上游明文密钥发给任何可达客户端，把当前仅存的一层脱敏保护整体撤掉。`GET /api/gateway` 已经明文下发 Gateway Key（`server.ts:1455/1459`），属于既有不一致，本设计不触碰。

## 需求决策（用户拍板）

| #   | 决策项       | 结论                                                                |
| --- | ------------ | ------------------------------------------------------------------- |
| 1   | 移除粒度     | **单条删除 + 一键清空**，单条删除需服务端新增按 index 的删除参数    |
| 2   | 条目展示形式 | **密码脱敏显示**（复用 `redactProxy`），不回传真实凭据              |
| 3   | 明文下发时机 | **按需揭示单条**：新增专用端点，点击才请求，不点不出服务器          |
| 4   | 揭示范围     | **上游 Key 与代理都支持**                                           |
| 5   | 复制能力     | **新增复制按钮**；复制到明文但不自动切换眼睛显示状态                |
| 6   | 复制失败     | **修复**：Clipboard API 不可用时回退 `document.execCommand('copy')` |

## 服务端设计

### 0. 索引空间定义（删除与揭示共用的唯一定义）

条目的 `index` 一律指**「服务端生成 `keyMeta` / `proxyMeta` 时所用的那份列表」中的位置**，UI 不做任何再过滤：

- Key：`buildKeyMeta`（`server.ts:299-307`）先 `trim` 再丢弃空串，因此 Key 的索引空间是 `providerKeyPool(credentials)`（`server.ts:309-313`，同样是 trim + 丢弃空串）过滤后的列表。
- 代理：`proxyMeta` 直接由存储的 `extra.proxies` 按位置生成，**不做任何过滤**，索引即存储数组下标。

由此暴露一处**既有不一致**：`removeKeyIndex` 的应用处（`server.ts:1123-1128`）取的是未经过滤的 `cur.credentials.apiKeys`（`:1121-1122`），与 `keyMeta` 的过滤后列表在「存在空白项」时会发生偏移。本设计要求把 `removeKeyIndex` 对齐到上述索引空间（改为基于 `providerKeyPool(cur.credentials)` 过滤）。这是行为修正：仅当 `apiKeys` 中混入空白串时结果才变化，属退化场景；不含空白串时行为与现状完全一致。

### 1. `GET /api/config`：新增脱敏 `proxyMeta`

在 opencode 分支（`server.ts:663-676`）现有 `proxyCount` 旁新增 `proxyMeta`：

- 形状：`Array<{ id: string; hint: string }>`，`id` 为 `p0`、`p1`…（对齐 `buildKeyMeta` 的 `k0` 风格）。
- `hint` 由 `redactProxy`（`packages/zen/src/proxy/spec.ts:7`）生成，`user:pass` → `***`；非 URL 值（如 `direct`）原样返回。
- 数组顺序与存储的 `extra.proxies` **严格一致**，因为删除按 index 定位。
- `proxyCount` 与既有 `keyMeta` 保持不变，避免破坏现有断言与调用方。
- 响应体**不含任何明文凭据**。

### 2. `POST /api/providers`：新增 `removeProxyIndex`

- 请求体新增 `removeProxyIndex?: number`，校验逻辑对齐既有 `removeKeyIndex`（`server.ts:954-961`）：非整数或 `< 0` 返回 `400 { error: 'removeProxyIndex must be a non-negative integer' }`。
- 应用位置对齐 `server.ts:1123-1128`：在 `nextExtra` 计算时对 `prevExtra.proxies` 按 index 过滤；index 越界时保持原样（与 key 行为一致，不报错）。
- 仅对 `providerId === 'opencode'` 生效，其他 provider 传该字段返回 `400`，避免静默忽略。
- 同时按「索引空间定义」把 `removeKeyIndex` 对齐到 `providerKeyPool` 过滤后的列表。
- **「一键清空」不需要新参数**：`extra: { proxies: [] }` 已被 `cleanExtra` allowlist（`server.ts:932-950`）放行，且 `nextExtra = { ...prevExtra, ...cleanExtra }`（`:1111-1115`）是整表覆盖，提交空数组即清空。

### 3. `POST /api/providers/reveal`（新增路由）

- 请求：`{ provider: string; kind: 'key' | 'proxy'; index: number }`
- 响应：`{ value: string }`，**仅该条明文**，无其他字段。
- 校验：
  - provider 未启用或不存在 → `400`
  - `kind` 非 `key`/`proxy` → `400`
  - `index` 非非负整数 → `400`（错误文案与 `removeProxyIndex` 同构）
  - index 越界 → `404 { error: 'not found' }`
- 取值来源：`key` → `providerKeyPool(credentials)`（`server.ts:309-313`）；`proxy` → 存储的 `extra.proxies`。两者均按「索引空间定义」定位。
- 路由挂在既有 `preHandler` 守卫之下（`server.ts:458-472`），与其他写操作同级别，不新增鉴权机制。
- **明文不进日志**：只记录 provider / kind / index；既有 redact 名单（`server.ts:393-407`）已覆盖请求体常见密钥字段，本端点请求体不含明文。

### 4. 不改动的服务端行为

- `parseProxyList`（`packages/zen/src/proxy/spec.ts:64-87`）的去重 / 丢弃非法项 / 空列表回落 `direct` 仍只在运行时生效（`runtime.ts:116`），不回写配置。
- 写入时仍不校验代理格式、不去重 —— 非法项会持久化并计入 `proxyCount`，属既有行为，本设计不处理。

## UI 设计

### 1. 共享剪贴板 helper（修复复制失败）

在 `packages/ui/app/lib/utils.ts` 新增：

```ts
export async function copyToClipboard(text: string): Promise<boolean>;
```

- 优先 `navigator.clipboard.writeText`；当 `navigator.clipboard` 为 `undefined`（非 secure context）或该调用抛错时，回退到「临时 textarea + `select()` + `document.execCommand('copy')`」，并清理临时节点与选区。
- `execCommand` 不受 secure context 限制，只要在用户手势的调用栈内执行即可用，正好覆盖 `http://<公网IP>:11435` 场景。
- 两条路径都失败才返回 `false`，由调用方决定提示文案。

替换 3 个调用点：

| 位置                               | 现状                                         | 处理                      |
| ---------------------------------- | -------------------------------------------- | ------------------------- |
| `SettingsView.tsx:1294` `copyText` | `navigator.clipboard.writeText`              | 改用 helper，失败才 toast |
| `TesterView.tsx:473`               | `navigator.clipboard.writeText`              | 改用 helper               |
| `ClineAccountsPanel.tsx:389`       | `navigator.clipboard?.writeText`（静默失败） | 改用 helper，失败给提示   |

顺带修一处信息泄露：`SettingsView.tsx:1883` 用 `'•'.repeat(Math.min(entry.key.length, 36))` 遮罩 Gateway Key，会暴露密钥长度；改为与长度无关的固定串。

### 2. 已保存 Key 行（`SettingsView.tsx:2198-2219`）

沿用现有「行 + Trash2」结构，在 `…c4d0` 右侧增加两个图标按钮：

- **眼睛 / EyeOff**：点击调 `POST /api/providers/reveal`（`kind: 'key'`, `index`），明文缓存进组件 state（按 `row.id`）；再次点击隐藏。图标与 `aria-label` 复用既有 `settings.showKey` / `settings.hideKey`（zh/en 齐备）。
- **复制 / Copy**：点击先取明文再写入剪贴板，**但不翻转眼睛状态** —— 显示保持 `…c4d0`，避免肩窥。沿用既有 `copied` 状态的 1.4s 反馈模式（`:1298`）。

`row.id` 与 index 的对应关系由服务端保证：`GET /api/config` 的 `keyMeta` 已按存储顺序生成 `k0`、`k1`…。

### 3. 代理区块（`SettingsView.tsx:327-359`）

- 保留 textarea 与「保存代理」（整表覆盖语义，hint 文案已说明）。
- 计数下方渲染已保存条目列表，每行 = 脱敏 `hint` + 眼睛（揭示密码，`kind: 'proxy'`）+ Trash2（`removeProxyIndex`）。
- 列表非空时显示「清空全部」按钮，点击提交 `extra: { proxies: [] }`。**不弹二次确认** —— 与既有单条 Key 删除（`removeProviderKey`）保持一致的即时生效语义；误删可由输入框重新提交恢复。
- 行内按钮的 busy 态复用组件既有的 `busy` 锁（`:175-192`），避免并发提交。

### 4. i18n

新增 key 必须在 zh 与 en **成对**补齐，`packages/ui/app/__tests__/i18n.test.tsx:48-51` 断言两语言 key 集合完全一致，漏一边直接失败。

- `settings.opencode.proxies.row` —— 条目行的无障碍标签
- `settings.opencode.proxies.remove` —— 单条删除
- `settings.opencode.proxies.clear` —— 清空全部
- `settings.copy.proxy` —— 复制代理

## 测试设计

全部按 TDD：先写失败测试并确认失败原因正确，再写实现。

| 层        | 文件                                                    | 用例                                                                                                                                                                                         |
| --------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ui helper | `app/lib/__tests__/`（新增 `utils.test.ts`）            | clipboard 可用时走标准 API；`navigator.clipboard` 为 `undefined` 时回退 `execCommand` 并返回 true；两者皆失败返回 false。vitest coverage 覆盖 `app/lib/**`                                   |
| server    | `packages/server/src/__tests__/opencode-config.test.ts` | `proxyMeta` 脱敏（响应体不含明文密码）；`removeProxyIndex` 删除生效、越界不报错、非法值 400；`reveal` 返回正确条目、越界 404、非法 kind 400；**`reveal` 的明文不得出现在 `GET /api/config`** |
| ui        | `app/components/__tests__/settings.test.tsx`            | 参照既有 `:112-143` 的 `removeKeyIndex` 用例：单条删除、清空全部、点眼睛揭示、点复制写入剪贴板（含非 secure context 下的回退路径）                                                           |
| i18n      | `app/__tests__/i18n.test.tsx`                           | 现有断言自动覆盖新增 key 的 zh/en 配对                                                                                                                                                       |

## 明确不做（范围边界）

- 不修改 `parseProxyList` 的运行时去重 / 丢弃 / `direct` 回落语义。
- 不在写入链路校验代理格式或去重（既有行为：非法项会持久化并计入 `proxyCount`）。
- 不改变 Gateway Key 的数据下发方式（`GET /api/gateway` 仍明文全量下发），只修其复制路径与长度泄露。
- 不新增鉴权机制，不修改 Docker 暴露面（`0.0.0.0` 绑定 + `FREEMODELFINDER_TRUST_UI`）与 HTTPS 缺失。这三项是独立且严重度更高的决策，需用户单独拍板，且改动会改变远程访问方式。
- 不给 reveal / copy 加限流或审计日志落盘。

## 已知遗留风险（随本设计一同生效，需用户知晓）

本设计不扩大暴露面：reveal 每次只返回一条、且仅在被点击时返回，与既有 `GET /api/gateway` 的明文下发处于同一暴露等级。但在默认 Docker 部署下，`/api/*` 无鉴权且绑 `0.0.0.0`，因此**任何能连到 11435 端口的客户端都可以读走 provider 明文密钥与代理密码**——他们本来就能伪造 `x-fmf-client: ui` 直接覆写配置。

缓解手段（不属于本设计）：改用 `http://127.0.0.1:11435` 或 SSH 隧道访问面板；部署侧收紧端口绑定与 `FREEMODELFINDER_TRUST_UI`。
