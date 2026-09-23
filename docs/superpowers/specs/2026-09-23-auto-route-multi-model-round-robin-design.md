# Auto-Route 多选模型 + 每档轮询 设计

日期：2026-09-23

## 目标

自动路由（autoRoute）的 5 个模型配置项（图片生成、视频生成、文本 simple/medium/complex 三档）从单个文本框改为**多选下拉**；同一档配置多个模型时，按请求**独立轮询**选择模型。

## 范围

- 全部 5 项配置均改多选（用户已确认）。
- 下拉选项来自**本地已添加模型目录**（registry 缓存/快照 + 自定义源已添加 models），**不再向厂商拉取**；按能力过滤。
- 每档独立轮询游标，互不影响。
- 旧的单字符串配置兼容读取。

不在范围内：权重轮询、故障摘除、游标持久化。

## 配置类型（core）

`packages/core/src/types.ts` 中 `AutoRouteSettings`：

```ts
imageModel?: string[];
videoModel?: string[];
textTiers?: {
  simple?: string[];
  medium?: string[];
  complex?: string[];
};
```

读取侧统一经 helper `asModelList(v)` 兼容旧格式：

- `string` → `[v]`（若非空串）
- `string[]` → 过滤空串、去重后返回
- 其他 → `[]`

保存侧（POST `/api/auto-route`）始终写入 `string[]`：去重、去空串；空数组表示清空该字段。

## 轮询游标（server）

`packages/server/src/routes/openai.ts` 模态路由处：

- 模块级 `Map<string, number>`，key：`image` / `video` / `text:simple` / `text:medium` / `text:complex`。
- 命中某档且 `pool.length > 0` 时：`model = pool[cursor % pool.length]`，随后 `cursor = (cursor + 1) % pool.length`。
- 进程内存，不持久化；重启从 0 开始（与 provider keyPool 行为一致）。
- 每次请求只推进实际使用的那一档的游标。

## 能力过滤（UI 选项）

- 数据源：SettingsView 新增拉取 `GET ${GATEWAY}/v1/models`（`ModelsResponse`），与 Finder/ImageGenerator/Tester 同源。
- 选项值：`modelValue(item)`（`provider:id`，与 `ImageGeneratorView`/`TesterView` 一致），配置里存完整路由 id（如 `custom:grok:claude-sonnet-4-6`）。
- 已选 id 不在当前列表（模型下线）时仍显示为已选项，避免静默丢配置。

| 档位     | 过滤规则                                                                             |
| -------- | ------------------------------------------------------------------------------------ |
| 图片     | `capabilities` 含 `image`，或裸 id 匹配 `/image/i`（与 `findImageModelId` 一致）     |
| 视频     | `capabilities` 含 `video`，或裸 id 匹配 `/video/i`                                   |
| 文本三档 | 有 `text` 能力、无 `capabilities`、或裸 id 不落入 image/video 关键字（保留通用模型） |

## UI

- 5 处文本框替换为多选下拉：checkbox 列表 + 已选数量/chips，沿用 Settings 现有样式与 i18n（可复用自定义源「获取模型列表」的 picker 交互思路）。
- Settings 在自动路由区块挂载时请求**本地** `model-options`（见上），不调用 `/v1/models`、不触发厂商刷新；失败则下拉为空并保留已选显示。
- 变更即保存（沿用现有 `saveAutoRoute`，body 中字段为 `string[]`）。
- `AutoRouteInfo` 本地类型改为 `string[]` / 三档 `string[]`。
- 空选择 = 未配置该档，回落原行为（图片自动发现 / 原文本链路）。
- 单选一个 = 与旧单模型行为一致。

## 错误与边界

- 数组含无效 id：不做过滤跳过，交给现有模型解析报错（与今日单模型打错字行为一致）。
- 保存时 `Array.from(new Set(ids.filter(Boolean)))`。
- GET `/api/auto-route` 返回数组；`asModelList` 兜底旧配置文件里的字符串。

## 测试

- **core**：`asModelList` — 字符串、数组、空串、null、去重。
- **server**：
  - 连续请求多模型档轮询到不同模型；每档游标独立；旧字符串配置仍可路由；空数组回落。
  - `model-options`：合并快照 + 自定义源已添加模型；**断言不调用** `listAllModels(true)` / provider `listModels`（spy/mock 计数为 0）。
- **ui**：多选下拉渲染、能力过滤、保存 payload 为数组、空选择清空、数据来自 model-options 而非 `/v1/models`。
