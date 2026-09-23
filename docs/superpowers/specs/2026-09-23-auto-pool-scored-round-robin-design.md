# auto 打分池 + 轮询设计（Text Fallback Path）

日期：2026-09-23
状态：已批准（brainstorming 通过）

## 背景

`model: "auto"` 目前的行为：
1. 模态检测（image/video）命中模态池 → 池内轮询（已有）
2. 未命中模态池（或模态池为空）→ 落入 `resolveModel('auto')`：
   - `defaultModel` 有效 → 固定用它（**问题：永远同一个模型，处理不了就失败了**）
   - `defaultModel` 无效 → 取模型目录第一个

用户期望：`auto` 文本兜底路径按策略（capability/speed/rate-limit）从全目录打分，取 Top-3 组成池，池内轮询；冷却成员实时跳过。

## 已确认的需求决策

| 决策点 | 选择 |
|--------|------|
| auto vs default 语义 | `model="auto"` → 打分池轮询；`model="default"` → `defaultModel`（保留现状） |
| defaultModel 角色 | 不再参与 auto 路由，仅 UI 默认展示 |
| 池大小 | Top-3 写死（不新增配置项） |
| 冷却成员 | 轮询时跳过冷却成员（池实时收缩；全冷却 → 回退目录第一个可用模型，即现状兜底） |
| 作用路径 | 仅文本兜底路径；模态池命中不经过打分池 |
| 池重算 | 每次请求现算（基于 5 分钟 TTL 的 modelsCache，零额外 provider 调用） |

## 行为规格

### resolveModel('auto')

```
1. 若 modelsCache 无数据 → 保持现状（抛错或取第一个可用，与现行为一致）
2. 候选 = modelsCache.models 中：
   - provider 未在共享配额冷却（autoRouter.isProviderRateLimited）
   - 模型未在冷却（isRateLimited(id) && isRateLimited(`${provider}:${id}`)）
3. 若候选为空 → 回退现状：取 modelsCache.models[0]
4. 按 autoRoute.strategy 对候选打分排序（scoreModel + profile）
5. 取 Top-3 → autoPool（按 id 稳定排序后截取，保证同分数顺序确定）
6. 进程级轮询游标（模块级 Map，与 modalityCursor 同模式）取下一个
7. 取出的成员若实时冷却 → 取下一个（循环，池全冷却 → 回到步骤 3 的兜底）
```

### resolveModel('default')

保持现状：`defaultModel` 有效 → resolveModel(defaultModel)；否则回退现状兜底。

### 响应可观测

命中打分池时，文本路径响应附加 `fmf_auto_route: { pool: [...], picked, strategy }`。
（模态池命中路径不加——已有 fmf_image_response/fmf_video_response 标识。）

## 不做的事（YAGNI）

- 池大小可配置
- 模态池为空时从打分池派生模态子集
- 冷却结束后的记忆/切回（打分池天然回归，无需）
- 修改 UI（无新配置项）
- 修改 preflight/maybeSwitchBack（429 兜底逻辑不变）

## 测试面

- `resolveModel('auto')`：
  - 打分排序正确（capability 大模型 > 小模型；speed 下 flash 优先）
  - Top-3 截取
  - 冷却成员跳过、池收缩
  - 池全冷却 → 目录第一个兜底
  - 轮询顺序（连续三次取到不同成员，第四次循环）
  - 策略切换 → 池变化
  - 无缓存数据 → 现状行为
- `resolveModel('default')`：defaultModel 优先（回归）
- 集成：`POST /v1/chat/completions model=auto` 文本请求连续两次 → 池内不同成员 + 响应含 `fmf_auto_route`

## 文件影响

| 文件 | 改动 |
|------|------|
| `packages/core/src/registry.ts` | resolveModel auto 分支重写 + 新增 `pickFromScoredPool()` |
| `packages/core/src/registry/__tests__/registry.test.ts` | 新增 auto 池用例 |
| `packages/server/src/routes/openai.ts` | auto 文本路径附加 `fmf_auto_route` |
| `packages/server/src/routes/__tests__/auto-modality.test.ts` 或新文件 | 集成用例 |
