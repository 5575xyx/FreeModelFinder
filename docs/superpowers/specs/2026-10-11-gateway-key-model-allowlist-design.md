# Gateway Key 模型白名单功能设计

## 背景与意图

FreeModelFinder 是一个本机 LLM 网关，把多家 provider 的免费模型聚合到一个
OpenAI / Anthropic / Gemini 兼容接口后面。用户会用同一个网关跑多个自己写的
脚本和应用，但这些应用共用一个接口时会产生两个问题：

1. **可见性** —— 下游程序拉 `GET /v1/models` 会拿到网关上所有模型，其中
   大部分是它用不到的，容易选错。
2. **争抢** —— 某个应用跑得太猛会把共享免费模型的额度吃光，其他应用跟着被
   限流或排队。

**本功能只解决可见性。** 争抢问题（跨应用配额/统计隔离）留待后续，因为那
需要改配额键控方式，工作量和风险完全不同。

需求（原话）：

> 对外接口这里的 key，是不是可以添加一些配置呢？比如该 key 可以调用的模型；
> 然后用这个 key 后获取到的模型就是我们配置的，如果没有配置就默认是这里
> 全部的可用模型都能获取

## 目标

- 每个 gateway key 可以配置一份**模型白名单**。
- 用该 key 调 `GET /v1/models` 只返回白名单内的模型。
- 用该 key 调用白名单外的模型返回 403。
- **不配置 = 不限制**，即保持现有行为（所有可用模型）。
- 设置页「对外接口」区块可编辑每个 key 的白名单。

## 非目标

- **不做配额隔离**。现有的 `dailyRequestLimit` / `dailyTokenLimit` 已经按 key
  统计，本功能不改动它们，也不做"按 key + 模型"的二维配额。
- **不做别名隔离**。别名（上一功能）仍然对所有 key 生效。
- **不做 provider 级白名单**，只有模型级。
- **不做通配符 / glob**。白名单是精确的模型 id 列表，UI 从下拉选择，不接受
  手输模式串。
- **不约束本机 UI**。本机 UI 不带 gateway key，在 preHandler 的
  `isTrustedUiRequest` 分支就 early-return 了，天然不受限制。
- **不限制 `/v1/videos/status` 和 `/v1/videos/proxy`**。视频任务在创建时已
  授权，轮询和代理不需要重复校验（无法从 task id 反查模型）。

## 反目标（做出来也算失败）

- 一个未配置白名单的 key 的行为**必须与现在完全一致**。这是最容易出回归的
  地方：任何"顺手优化"都不能改变空白名单的语义。
- 不能因为白名单把 `/v1/models` 变成空列表而让客户端崩溃——空列表是合法
  响应（`data: []`）。

## 关键设计决策（由我定，非用户确认）

### 1. 白名单按「真实组合 id」存

条目形如 `custom:fx:fast`、`openrouter:gpt-4o-mini`、
`opencode:mimo-v2.6-flash-free`，即 `composeModelId(provider, id)` 的结果。

理由：UI 的下拉数据源 `/api/auto-route/model-options` 返回的正是组合 id，
存这个形态不需要额外的往返转换。而 `listAllModels()` 返回的 `m.id` 对
OpenAI 兼容 provider 是裸名（`gpt-4o-mini`）、对 custom 是 `fx:fast`，
所以比对时必须先 `composeModelId(m.provider, m.id)`。

### 2. 空数组 = 不限

`modelAllowlist` 缺省或为 `[]` 都表示不限制。不为"限制到空"另设一个
开关——配置白名单的人不会想配置成零个模型。

### 3. 限制 key 的 `auto` / `default` 请求直接 403

`auto` 由路由器自选模型，无法保证落在白名单内。让它静默降级等于绕过
白名单。403 的报错文案会明确说明原因。

（"让路由器在白名单内选"是更优雅的做法，但要把 allowed 集合管道贯通到
`AutoRouter` 的候选池遍历，改动面大得多，本功能不做。）

### 4. 越权返回 403，不是 404

404 会让调用方误以为模型不存在而去换模型，403 明确表达"你有这个网关但
没有这个模型的权限"。与现有网关的 401/429 风格一致。

### 5. `/v1/models` 的 `fmf` 元数据块不过滤

`fmf.enabled_providers` / `succeeded_providers` 描述的是网关状态，不是 key
状态，保持不变。这样已有客户端不受影响；代价是受限 key 会看到自己用不到
的 provider 名，信息略有泄露但不敏感。

### 6. 白名单检查放在 preHandler

key 匹配、日限额检查已经在 `preHandler` 里，白名单检查紧跟其后，单一
执行点。代价是需要从 body / URL 提取模型名（各协议位置不同）。

## 数据流

```
请求 → preHandler
        ├─ 非本机 UI / 需鉴权
        │    ├─ findMatchingGatewayKey  → 401
        │    ├─ 日限额                  → 429
        │    └─ 白名单（本功能新增）    → 403
        └─ 本机 UI → early return，不限制

GET /v1/models
  listAllModels() → 按白名单过滤 → 别名替换（toClientFacingModel）→ 响应

POST /v1/chat/completions 等
  preHandler 白名单校验通过后 → 既有逻辑（别名归一化 → 路由 → 回显别名）
```

## 白名单与别名的交互

别名把对外名映射到真实 id。两者的关系：

- 白名单按**真实 id** 存储和比对。
- 客户端可以用别名请求白名单内的模型：`my-model` → `custom:fx:fast`，
  目标在白名单内则放行。
- 客户端用原始 id 请求同理。
- `GET /v1/models` 先按白名单过滤，再走别名替换，所以受限 key 看到的
  仍然是别名（若已配置）。

比对必须做**完整解析**（`resolveModel`，会递归走完别名链），不能用只走一
跳的 `resolveAlias`。

## 接口契约

### 配置

```ts
export interface GatewayKeyEntry {
  id: string;
  key: string;
  label?: string;
  createdAt: number;
  expiresAt?: number;
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  /** Composed real model ids this key may access. Omit or [] = unrestricted. */
  modelAllowlist?: string[];
}
```

### `GET /api/gateway`

每个 key 增加 `modelAllowlist: string[]`（总是返回数组，未配置返回 `[]`，
避免 UI 在 `null` / 缺省之间分叉）。

### `POST /api/gateway`

`create` / `update` 动作接受 `modelAllowlist?: string[]`：

- 元素必须是字符串；非字符串或空白元素忽略。
- 去重。
- `update` 时传入 `[]` 表示**清空**白名单（不限制），与不传区分开。
- 不做"模型必须存在"的校验——模型目录会变化，白名单应能指向尚未出现的
  模型（比如临时禁用的 provider 恢复后）。

### 越权响应

```json
{
  "error": {
    "message": "This API key is not allowed to use model \"x\". Allowed models: a, b.",
    "type": "permission_error",
    "code": "model_not_allowed"
  }
}
```

403。

## 实现要点（给执行者）

- 比对集合必须用 `composeModelId(m.provider, m.id)` 规范化，见「决策 1」。
- 新增的 key 解析函数放在 `packages/server/src/routes/openai.ts`
  `resolveGatewayKeyId` 旁边（`extractBearer` / `keyMatches` 也在这一簇）。
- 需要 core 重新 `pnpm build:runtime`，否则 server 侧报 `is not a
function`——那是构建产物过期，不是代码问题。
- Windows 上 `prettier --check` 因 CRLF 全仓报警，属历史遗留；不要为行尾
  跑 `--write` 整个大文件。
