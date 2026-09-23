# 设计：多 API Key 管理 + Auto 模态路由补全

日期：2026-09-23  
状态：待用户审阅  
范围：设置页 Provider/自定义源多 Key 交互；`model=auto` 图片文本意图路由

## 背景与目标

### 问题 1 — 多 Key 输入

当前 Provider / 自定义源仅有一个 password 输入框，多把 Key 靠逗号分隔字符串（`split(/[\s,;|]+/)`）。用户无法看到已保存的有哪些 Key，也无法逐把删除。

目标（用户已确认）：

- 展示已保存 Key 的**掩码列表**（每行一把，可删除）
- 「添加 Key」按钮追加空白输入框，填完后保存
- 删除**立即生效**
- 范围：普通 Provider **和** 自定义源（Custom Source）
- 多个自定义源（「添加源」）**已支持**，本次不改

### 问题 2 — Auto 模态路由

对话测试选 `auto`，输入「生成小猫图片」时被路由到文本模型，返回「我是文本 AI 无法生成图片」。

根因：

1. `detectRequestModality`（`packages/server/src/routes/openai.ts` ~154-167）只识别上传的 `image_url` part 与视频关键词，**纯文本图片意图被判定为 `text`**
2. 即便判为 `image`，也需手动配置 `autoRoute.imageModel` 才换模型（~289）
3. 最终 `auto` 经 `resolveModel` 落到 defaultModel / 缓存列表第一个文本模型

目标：`auto` + 文本图片意图 → 自动导航到合适的图片生成模型；未配置 `imageModel` 时**自动发现**可用生图模型（用户已确认选项 A）。

## 问题 1 设计

### 方案（已选定）

扩展 `GET /api/config` 返回 Key 元数据；`POST /api/providers` 支持按索引删除与追加；前端掩码列表 + 添加按钮。不采用独立 CRUD API，不采用仅回 `keyCount` 的占位方案。

### API

#### GET /api/config

**Provider 条目**（`server.ts` providers map ~507-518）增加：

```ts
keyMeta?: Array<{ id: string; hint: string }>
```

- `id`：稳定序号 `k0`, `k1`, …（配置无独立 Key id，用下标）
- `hint`：掩码提示，优先 `…` + 尾 4 位；长度不足 4 时用尾 2 位；空串不返回该行
- 来源：`credentials.apiKeys` 过滤非空；若仅 legacy `apiKey` 无 `apiKeys`，视为单元素
- **绝不返回明文**

**自定义 source 条目**（~481-490 map）同样增加 `keyMeta`：

- 归一化 `apiKey: string | string[]` → 数组 → 同上生成 `id`/`hint`

#### POST /api/providers

Body 增量字段（与现有字段兼容）：

```ts
appendKeys?: string[];      // 追加新 Key，不触碰已有明文
removeKeyIndex?: number;    // 按当前 keyMeta 下标删除一把；越界 400
```

语义与优先级：

1. `clearCredentials === true` 或 `apiKey === ''` → 清空（现状，最高优先）
2. 否则若给出 `removeKeyIndex` → 删除该下标（允许与 `appendKeys` 同请求：先删后加，**索引基于删除前数组**）
3. 否则/其后 `appendKeys` 非空 → 合并到 `credentials.apiKeys` 尾部；`appendKeys` 为空数组 → 400
4. 现有全量 `apiKeys?: string[]` 替换语义保留（测试与 onboarding 仍可用）

校验：

- `appendKeys` 存在但 `[]` 或全空白 → 400
- `removeKeyIndex` 非整数或越界 → 400
- 成功后继续把 legacy `credentials.apiKey` 同步为 `apiKeys[0]`（现状兼容）

自定义源 Key 不能走整包 `sources[].apiKey` 全量覆盖（config 不回明文，整包提交会丢掉已存 Key）。增删均用专用字段，服务端在 `extra.sources` 内按 `sourceId` 定位：

```ts
// POST /api/providers
appendKeys?: string[];                 // provider 追加（可多把）
removeKeyIndex?: number;               // provider 按 keyMeta 下标删除
appendSourceKeys?: { sourceId: string; keys: string[] };   // custom source 追加（可多把）
removeSourceKey?: { sourceId: string; index: number };     // custom source 按 keyMeta 下标删除
```

- `appendSourceKeys.keys` 为空或全空白 → 400；`sourceId` 不存在 → 404
- `removeSourceKey.index` 越界 → 400
- custom 的 baseUrl/label/models 仍走整包 `sources`；**Key 增删只走上述字段**
- 单把追加即数组长度 1，不另设单数字段

### UI（Provider + Custom Source 一致）

```
已配置 2 个
[ …ab12 ] [ 🗑 ]              ← 已存：hint 掩码 + 立即删除（无完整显隐）
[ …cd34 ] [ 🗑 ]
[ 粘贴 API Key ]              ← 仅「添加 Key」后出现的草稿框（可显隐）
[添加 Key] [保存]
```

状态：

- Provider：现有 `keys[p.id]` 单 string 草稿 → 改为 `keyDrafts: Record<string, string[]>`（空数组 = 无草稿行）
- Custom：每 source 的 `apiKey` string 草稿 → `srcKeyDrafts: Record<string, string[]>`；**保存时仅提交非空草稿**，不与逗号 split 混用
- 已存行**不提供完整显隐**（服务端无明文）；草稿行保留 eye 切换
- 「添加 Key」→ push `''` 并聚焦
- **保存**：合并所有非空草稿 → 一次请求（provider: `appendKeys`；source: `appendSourceKeys` 一次多把）
- **删除**：点击立即 POST `removeKeyIndex` / `removeSourceKey`；成功后刷新该来源的 `keyMeta`
- 保存按钮：仅当存在至少一个非空草稿时可点；与删除可并存（忙碌态互斥，同一时刻一个操作）

**文案**：

- 移除中英「逗号分隔多个 / comma-separated」相关 placeholder（`settings.sources.pastePlaceholder` / `pasteExisting` / `settings.custom.apiKeyPlaceholder` / `apiKeyExisting`）
- 新增：`settings.sources.addKey`、`settings.sources.keyHint`（aria）等按实现补齐

### 错误处理

- 400/404 → toast 错误文案（复用 `settings.gateway.opFailed` 模式或 sources 现有 error）
- 删除成功 → 刷新该 provider/source 的 `keyMeta`（重新 GET config 或乐观更新 hint 列表）
- 与 `credentialError` 并存展示

### 测试

**server**

- config：多 Key → `keyMeta` 长度/hint；legacy 单 Key → 一项；custom `apiKey` string/array → 一致
- `appendKeys` 合并、不回明文
- `removeKeyIndex` 删除、越界 400
- `appendSourceKeys` / `removeSourceKey` 正常与 400/404
- 与 `clearCredentials` 优先级

**ui（vitest）**

- 「添加 Key」出现草稿输入框
- 保存调用带 `appendKeys` / `appendSourceKeys`
- 删除点击触发 `removeKeyIndex` / `removeSourceKey`
- placeholder 不再含「逗号分隔」
- 自定义源同一套行为

## 问题 2 设计

### 改动点（均在 `openai.ts`，除非注明）

1. **`detectRequestModality` 文本图片意图**

   - 新增中英文关键词/正则（与 `VIDEO_KEYWORDS` 同级风格）
   - 中文示例：`生成|绘制|画|创作|做` + `图|图片|照片|插画|壁纸|头像|海报` 等组合，避免「地图」「图形界面」类误伤（用更紧的搭配，如「生成.{0,6}图」「画一?张」「来一张.{0,4}(图|照片)」）
   - 英文示例：`generate|draw|create|make` + `image|picture|photo|illustration` 等
   - 优先级：已有 image part → `image`；video 关键词 → `video`；再图片文本意图 → `image`；否则 `text`
   - 纯上传图与 video 行为不变

2. **`auto` + `image` 选模**（~284-299）

   - `ar.imageModel` 已配置 → 使用（现状）
   - **未配置** → 自动发现：遍历 registry 可用模型，按「model id 含 image 或已知生图 provider 能力」（可复用 `:301` inferredCaps 启发式 / capabilities）选第一个启用且非冷却者；找到 → 替换 `chatReq.model`
   - 都找不到 → 保持 `auto`，走原文本链路（不 500）

3. **确保路由到的模型走 `generateImage`**（~301-321）

   - 自动发现选出的 id 应满足现有触发条件（id 含 `image` 或 capabilities）
   - 若新选 id 不含 `image` 字样但 capabilities 标明可生图，需让 `:301` 判断同时认 capabilities（若现状已认则只补发现逻辑）

4. **文案**（可选，低优先级）：`settings.autoRoute.modality.desc` 注明纯文本图片意图也会识别

### 不改

- 视频关键词、textTiers、AutoRouter 限流 fallback、Anthropic/Gemini 的 auto

### 测试

**server**

- `detectRequestModality`：中文图片意图、英文图片意图、普通问答不误判、与 image part / video 关键词优先级
- auto + 图片意图 + 已配 imageModel → 换成该模型
- auto + 图片意图 + 未配置 → 自动发现选中生图模型（fixture 注入）
- auto + 图片意图 + 无任何生图模型 → 仍可走文本（不抛错）

## 架构关系

两问题独立，可分 PR/分 commit：

| 模块 | 问题1 | 问题2 |
|------|-------|-------|
| `packages/server/src/server.ts` | config keyMeta、POST 增删字段 | 无 |
| `packages/server/src/routes/openai.ts` | 无 | detectRequestModality、auto image 分支 |
| `packages/ui/SettingsView.tsx` | 多 Key UI | 无 |
| `packages/ui/i18n.tsx` | placeholder/按钮文案 | modality.desc（可选） |
| `packages/core` | 无（除非复用能力推断工具） | 若抽公共 `inferImageCapability` 可放 core |

## 范围外

- 网关密钥（gateway keys）已有独立 UI，不动
- Onboarding 流程对 apiKeys 的写入保持兼容
- 多自定义源增删（已存在）
- 对话测试页直接内嵌生图预览（仍由 auto 转到生图模型响应）

## 验收标准

1. 设置页 Provider 显示每把已存 Key 的 `…xxxx` 掩码，可删除（立即生效），可「添加 Key」后保存
2. 自定义源同样支持多 Key 掩码列表；「添加源」仍可用
3. 配置响应与错误响应均不出现 Key 明文（除用户新输入）
4. 对话测试 `auto` +「生成小猫图片」（及英文等价句）路由到生图模型；已配 `imageModel` 优先，未配则自动发现，无法发现则不崩溃
5. `pnpm lint`、`pnpm typecheck`、core/server/ui 测试通过
