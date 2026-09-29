# Cline 动态模型清单 — 设计

日期：2026-09-29
状态：已获用户逐节批准，待实施
前置：Cline 凭据体系设计（`2026-09-27-cline-credentials-design.md`，v4，已实施）

## 背景

ClineProvider 当前的模型清单是编译期常量（`providers/cline.ts` 的 `BUILTIN_MODELS`，4 个），`listModels()` 静态返回、不触网。实测上游已换过一轮免费模型：官方 `free` 分组当前 5 个模型与内置 4 个仅 1 个重叠，静态清单已过时。

源码核查（cline-free `worker.js`）确认上游存在**免鉴权**的公开端点：

| 端点                                                           | 内容                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` | 分组推荐：`recommended` / `free` / `clinePass` / `clineCloud` |
| `GET https://api.cline.bot/api/v1/ai/cline/models`             | 全目录约 446 条（本次不使用）                                 |

请求只需 `Accept: application/json` + UA 头，无 token。模型字段：`id` / `name` / `description` / `tags` / `context_length` / `pricing`。

分组语义（本设计的关键裁决依据）：

- `free` — 官方标注「免费额度，不需要 credits」，真免费
- `recommended` — 「默认走免费额度」，含 claude-opus-5.5 等大牌，免费额度耗尽可能吃付费余额（上游有 402 错误）
- `clinePass` — 需订阅；`clineCloud` — 走云端额度
- 上游**不暴露**账号订阅状态（cline-free 只有 credits 余额查询，无 pass 订阅字段）——无法按订阅过滤

## 已批准的决策

| 决策点   | 结论                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 暴露范围 | **仅 `free` 组 + 内置 `BUILTIN_MODELS` 4 个的并集**；付费三组不暴露（上游无订阅状态可依，且与免费聚合定位冲突）                     |
| 刷新时机 | **惰性拉取 + 30 分钟 TTL 内存缓存**；无预热、无后台定时                                                                             |
| 元数据   | `id` + `context_length` + `name/description`；**不带** `pricing`（credits 定价非免费价，误导）、**不带** `tags`（防与免费规则冲突） |
| 开关     | **可关闭配置，默认开**；缺省 `undefined` = 开，老配置零迁移                                                                         |
| 架构     | **方案 B**：独立模块 `providers/cline-catalog.ts`，协议层零新增网络调用                                                             |

## 1. 架构

新增 `packages/core/src/providers/cline-catalog.ts`，单一职责：

```
listClineCatalogModels(opts): Promise<ClineCatalogModel[] | null>
  // ClineCatalogModel = { id, name?, description?, contextWindow? }，裸 id（无 cline: 前缀）
  ├─ opts.dynamicModels === false → 立即返回 null（零网络、不查缓存）
  ├─ 内存缓存 { models, at, inflight } —— TTL 30min、inflight 合并
  ├─ fetchUpstreamJson(RECOMMENDED_URL, 15s 超时)   // Accept + UA 两头
  ├─ parse：仅取 raw.free；其余三组丢弃；normalize 字段
  └─ 失败：有旧缓存退旧缓存；无缓存返回 null
```

`ClineProvider.listModels()` 变为委托：

```ts
async listModels(): Promise<ModelInfo[]> {
  const dynamic = await listClineCatalogModels({ dynamicModels, fetchImpl: this.ctx.fetchImpl });
  const merged = dedupeById([
    ...(dynamic ?? []),
    ...BUILTIN_MODELS.map((id) => ({ id })),   // 内置条目无附加元数据
  ]);
  return merged.map(toModelInfo);   // 加 cline: 前缀、free:true、capabilities:['text']
}
```

开关管道：`ProviderSettings.dynamicModels?: boolean` → `ProviderContext.dynamicModels?: boolean` → `registry.getProvider` 构造 ctx 时从 `config.providers.cline` 注入（与既有 `credentialRuntime` 注入点同处）。

## 2. 数据流与失败语义

调用链不变，无新端点：`UI / GET /v1/models / ModelWatcher → registry.listAllModels() → ClineProvider.listModels() → listClineCatalogModels() → 并集 → ModelInfo[]`。

| 情形               | 行为                                         |
| ------------------ | -------------------------------------------- |
| 缓存新鲜（<30min） | 直接返回，零网络                             |
| 缓存过期           | 拉上游成功→替换；失败→退旧缓存（stale 可用） |
| 冷启动且端点失败   | 返回 `null` → 回退仅内置 4 个                |
| 并发同时过期       | inflight 合并，只发一次                      |
| 开关关闭           | 短路，纯内置 4 个                            |

不变式：

1. `listModels()` **永不因网络失败抛错**——上游故障时网关模型列表始终可服务
2. 并集去重以裸 id 为准；**内置 4 个恒在列表**（即使上游 free 组已移除）
3. 缓存为进程内存态，重启即冷（可接受）

明确不做：磁盘持久化缓存、主动预热、后台定时刷新、ModelWatcher 改动。

## 3. 元数据映射与免费语义

| ModelInfo 字段  | 来源                                                         |
| --------------- | ------------------------------------------------------------ |
| `id`            | `cline:` + 上游裸 id（composeModelId 惯例，防双前缀）        |
| `displayName`   | 上游 `name`，缺失回退裸 id                                   |
| `description`   | 上游 `description`（可选字段，缺失不填）                     |
| `contextWindow` | 上游 `context_length`（0 或缺失不填，UI 显示「上下文未知」） |
| `free`          | 恒 `true`                                                    |
| `capabilities`  | 恒 `['text']`（不做 tags 能力推断）                          |

免费系统咬合：`free: true` 使免费判定规则零改动；规范 id 不变使路由/防双前缀/quota 三层键/auto-router 已闭环路径全部自动适用。

过滤：只认 `raw.free` 数组；响应结构异常（无 `free` 键/空数组）按上游失败处理（走回退链，不视为「免费模型为 0」）。

## 4. 配置、UI 与测试

配置：`ProviderSettings.dynamicModels?: boolean`（缺省=开）；保存走现有 `POST /api/providers`（server zod schema 加可选字段）；`GET /api/config` 白名单透传供 UI 回显。

UI：cline 卡片加勾选框「动态同步上游免费模型」（默认勾上），走现有 enabled 同款保存流与 `onChanged→refreshConfig` 刷新链；i18n 双语；Finder 侧零改动。

测试（TDD，mock fetch，不打真上游）：

- `cline-catalog.test.ts`：free 解析/三组丢弃、TTL 命中、过期刷新、失败退旧缓存、冷启动失败 null、inflight 合并、开关短路零网络、空 free 按失败处理、字段 normalize 回退
- `cline.test.ts` 扩展：并集去重、内置恒在、开关关=纯内置、上下文/描述映射
- registry/server：`dynamicModels` 保存→回显→ctx 注入
- ui：勾选框渲染/保存/回显

文档：`docs/CLINE_FREE.md` 增补「模型清单动态同步」小节。

## 边界（明确不做）

付费三组暴露、订阅状态探测、402 试探、磁盘缓存、`tags`/`pricing` 带入、daily-audit 接入、通用 remote-catalog 基础设施（YAGNI，等第二个消费者再抽）。
