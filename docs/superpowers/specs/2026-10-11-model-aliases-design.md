# 模型别名（Model Aliases）设计

日期：2026-10-11

## 背景与目标

对外接口暴露的模型 id 都带内部前缀（如 `cline:cline-free/deepseek-v4.1-flash`、
`opencode:mimo-v2.6-flash-free`）。本功能允许用户为模型配置一个简洁的对外别名
（如 `my-model`），外部调用方只看到/只用别名，网关内部路由到真实模型 id。

## 已确认的需求决策

1. `/v1/models` 列表中：设置了别名的模型，**别名替换原始 id**（原始带前缀 id 不出现）。
   没有别名的模型，id 保持原样（即"没有配置别名时，模型 id 本身就是对外名称"）。
2. 响应中的 `model` 字段（非流式 `payload.model`、流式 chunk `model`）**统一回显别名**；
   无别名的模型回显真实 id。
3. 原始带前缀 id **继续可用**（别名是新增入口，不破坏已有调用方）。
4. 本机 UI（模型选择器、对话测试）显示「别名 (真实id)」，本机调试可见真实 id。

## 方案选型

采用 **registry 层别名表**（方案 A）：

- `AppConfig` 顶层新增 `modelAliases?: Record<string, string>`（别名 → 真实模型 id）。
- `ProviderRegistry.resolveModel` 顶部查表递归解析。这是所有入口的单一汇聚点：
  OpenAI/Anthropic/Gemini 三协议 + 图片/视频/探活 + CLI 直连 registry 都自动认得别名。
- 拒绝方案 B（server 层拦截）：CLI 等直连 registry 的入口不认别名，且每条路由都要
  加归一化+回显样板。
- 拒绝方案 C（虚拟目录条目）：目录刷新会冲掉别名，需每次 refresh 后重注入；虚拟条目
  让自动路由/配额统计按别名建模，语义变脏。

## 第 1 节：配置与类型

### Schema

`packages/core/src/types.ts`，`AppConfig` 新增顶层字段：

```ts
export interface AppConfig {
  // ...现有字段
  modelAliases?: Record<string, string>; // 别名 -> 真实模型 id
}
```

存储在 `~/.freemodelfinder/config.json`，非敏感、无需加密。`normalizeConfig` 的
`{ ...DEFAULT_CONFIG, ...input }` 展开写法天然保留该字段，只需补类型。

### 别名命名校验（保存时执行，不合法返回 400）

| 规则                                | 理由                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------ |
| trim 后非空，长度 ≥ 1               | 基本                                                                     |
| 不含 `:`                            | gemini 路由按最后一个 `:` 拆模型/动作；`provider:model` 前缀解析会被污染 |
| 不等于 `auto` / `default`           | 保留字                                                                   |
| 不与已存在的真实模型 id 冲突        | `/v1/models` 替换规则需要唯一映射                                        |
| 值（真实 id）不必强制存在于当前目录 | 目录动态刷新，允许先配别名等模型上线；解析失败时报 model not found       |

## 第 2 节：解析链路

### 别名表挂点（registry.ts，`resolveModel` 函数最顶部）

```ts
resolveModel(modelId, opts) {
  const alias = this.config.modelAliases?.[modelId];
  if (alias && alias !== modelId) {
    return this.resolveModel(alias, opts); // 递归解析
  }
  // ...现有逻辑（auto/default/前缀/启发式/兜底 openrouter）
}
```

### registry 新增辅助方法

```ts
/** 只做别名查表（不递归进 resolveModel）。无别名时返回入参本身。 */
resolveAlias(modelId: string): string;

/** 反查：若有别名指向 realId，返回该别名；否则返回 realId 本身。 */
toClientFacingModel(realId: string): string;
```

`toClientFacingModel` 线性扫 `modelAliases` 反查即可（别名数量小，无性能问题）。

### 路由层归一化（消除冷却表错位）

在三个协议路由入口，把请求模型名归一为真实 id，同时保留原始名：

```ts
const requestedModel = String(body.model); // 保留原始名（回显别名用）
chatReq.model = reg.resolveAlias(chatReq.model); // 归一为真实 id
```

- OpenAI：`openai.ts` 中 `chatReq.model` 赋值后（约 :540 附近）。
- Anthropic：`anthropic.ts` 约 :88。
- Gemini：`gemini.ts` 的 `parseModelAction` 后（注意其按最后一个 `:` 拆分，
  别名规则禁止 `:` 已规避冲突）。

效果：

- `router.preflight` 冷却查表用真实 id，精确匹配。
- `markRateLimited(realModelId)` 冷却键是真实 id。
- `rememberPreference(requestedModel)` 用原始名；`maybeSwitchBack` 匹配时同样走
  `resolveAlias` 归一。
- `isAutoRequest` / `body.model === 'auto'` 判断基于原始名：别名≠'auto'，不会误触
  pool-walk / fmf_auto_route 元数据（别名指向具体模型时应 fail-fast）。

## 第 3 节：呈现层

### `/v1/models`（server/routes/openai.ts :473）

`id: m.id` 处过一遍 `reg.toClientFacingModel(m.id)`：

- 有别名指向该模型 → 输出别名 id（其余字段 `display_name`、`context_window` 等不变）。
- 无别名 → 输出原始 id（"没有配置别名时，模型 id 就是对外名称"）。

### 响应回显

| 位置                                                    | 改法                                                      |
| ------------------------------------------------------- | --------------------------------------------------------- |
| openai.ts 非流式 `payload.model = finalModel`           | `reg.toClientFacingModel(finalModel)`                     |
| openai.ts chat 内嵌图片/视频应答 `model: chatReq.model` | 用 `requestedModel`（原始请求名）                         |
| openai.ts 流式 `streamChunkToOpenAI(chunk)` 输出后      | 覆盖 `payload.model = requestedModel`（请求用的是别名时） |
| anthropic.ts 非流式 `payload.model = finalModel`        | `reg.toClientFacingModel(finalModel)`                     |
| anthropic.ts 流式 `message_start` 的 `model`            | 同理                                                      |
| gemini                                                  | 响应不含 model 字段，无需改                               |
| `/v1/images/generations`、`/v1/videos`                  | `body.model` 原样回显已是请求名，不动                     |

### 诊断元数据保留真实 id

`SwitchNotice`（from/to）、`fmf_auto_route.picked` 等网关内部路由诊断信息保留
真实 id（`provider:realId`），便于限流切换时定位真实模型。唯一例外：
`requestedModel === 'auto'` 时不改写。

## 第 4 节：管理 API、UI、测试

### 管理端点（仿照 `POST /api/auto-route` 模式，加在 server.ts）

- `GET /api/model-aliases` → `{ modelAliases: Record<string, string> }`
- `POST /api/model-aliases` → body 为完整别名表 `{ modelAliases: Record<string, string> }`，
  **整体替换**（非增量合并；删除别名 = 从表中去掉该键后提交）。服务端校验（第 1 节规则），
  通过后 `updateConfig` + `registry.updateConfig(next, { preserveModels: true })`
  保存并热更新。沿用管理 API 的本地 UI origin 守卫。

### UI 设置 section（SettingsView.tsx，按现有折叠 section 模板）

- 新增「模型别名」折叠 section。
- 每行：别名输入框 + 真实模型下拉框（从 `/v1/models` 取）+ 删除按钮；顶部
  「添加别名」按钮。
- 模型选择器/对话测试显示「别名 (provider:真实id)」：基于 `/v1/models` 返回的
  别名 id 与该条目自带的真实信息拼装（`/v1/models` 条目需携带反查所需的真实 id，
  见下）。

### `/v1/models` 条目补充字段

别名替换后原始 id 消失，UI 拼装「别名 (真实id)」需要知道真实 id。因此别名条目
额外携带 `alias_of: realId` 字段（无别名的条目不带该字段）。这是管理面板用的
扩展字段，不影响标准 OpenAI 客户端。

### 测试策略

- **core**：`resolveModel` 别名递归解析；`resolveAlias` 查表；`toClientFacingModel`
  反查与无别名回退；别名校验拒绝 `:` / `auto` / `default` / 空 / 冲突。
- **server**：三协议入口归一化；`/v1/models` 别名替换与 `alias_of` 字段；响应回显
  别名；`/api/model-aliases` 端点校验与热更新。
- **ui**：设置 section 渲染、增删行、保存调用；i18n zh/en 键集一致性。

## 范围外

- 别名指向 `auto` 或另一个别名：允许 alias→alias 递归（resolveModel 天然支持），
  但不允许别名的键等于 `auto`/`default`。
- 不做别名的正则/通配匹配。
- 不改变配额统计维度（统计仍按真实模型 id 记录）。
