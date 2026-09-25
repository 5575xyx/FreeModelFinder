# Auto 全量候选 Failover 设计

日期：2026-09-25
状态：已批准（设计经用户逐节确认）

## 背景

生产环境 `model: "auto"` 请求反复撞到上游已废弃的模型（如 ModelScope 的
`DeepSeek-V3.1` 返回 400 `has no provider supported`）。`af55ddf` 已引入
"不可用识别 + 10 分钟冷却 + 最多 4 次切换"，但与目标行为仍有差距：

1. 切换次数固定为 4，未覆盖"直到可回答或候选穷尽"的完整语义；
2. 不可用模型冷却 10 分钟后会重新进入打分池，再次被撞到；
3. 限流失败只切换一次，之后直接报错。

## 需求决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 不可用标记生命周期 | 进程内永久剔除，gateway 重启恢复；UI"清除冷却"可手动恢复 |
| 单次请求尝试上限 | 无上限，试完全部候选才报错 |
| 适用范围 | 仅 openai 兼容路由的 `model: "auto" \| "default"`；显式指定模型失败直接报错 |
| 限流标记 | 冷却到期自动重新参与打分（维持现状） |

## 设计

### 1. 候选序列（core / registry）

- 打分排序逻辑（capability/speed/rpm 策略）不变；
- 新方法生成完整降序候选序列，起点 = 现有 Top-3 轮询游标 `p`，
  序列 = `sorted[p..n-1] + sorted[0..p-1]`（环绕，保留负载均衡）；
- 请求开始时取序列快照 + `excluded` 集合；失败 → 游标后移（跳过已试）；
  绕回起点 = 候选穷尽；
- 过滤条件不变：冷却中的（限流未到期 / 已永久剔除）不进序列。

### 2. 失败分类与标记（core / auto-router）

| 失败类型 | 判定 | 标记 | 请求内动作 |
|---|---|---|---|
| 不可用（no provider supported 等） | `parseModelUnavailableError` | 永久剔除（`resetAt = Infinity`） | 换下一个 |
| 限流 429 | `parseRateLimitError` | 冷却到期自动回池（现状） | 换下一个（不再限一次） |
| 参数类 4xx（非不可用模式） | 其余 4xx | 不标记 | 直接报错（换模型无用） |
| 5xx / 网络 / 超时 / 未知错误 | 其余 | 不标记 | 换下一个（同请求内不重试已试） |
| max_tokens | 现有判定 | 不标记 | 同模型截断重试一次（不动） |
| vision | 现有判定 | 不标记 | vision 候选切换（不动） |

实现要点：

- `markModelUnavailable` 默认 `resetAt = Infinity`，删除
  `MODEL_UNAVAILABLE_COOLDOWN_MS`（10 分钟）语义；
- 复用现有 `cooldowns` map：`gc` 只删 `resetAt <= now`，`Infinity` 永不过期，
  过滤/`isRateLimited`/诊断接口零改动；
- 兼容两处显示：
  - core `formatResetTime`：非有限值 → 返回"已永久剔除"；
  - UI `SettingsView` 冷却列表：`resetAt` 非有限 → 显示"永久"文案（i18n 中英）。

### 3. 执行层（server / openai.ts）

- **非流式** `dispatchWithAutoRoute`：循环条件改为「auto 请求 && 候选未穷尽」，
  删除 `MAX_MODEL_UNAVAILABLE_RETRIES`；
- **流式**：外层 auto 循环包住单模型尝试，`catch` 分类 → 标记 → 取下一候选；
  **已输出 chunk 后不切换**（保护已发出内容），照旧直接报错；
- 共享 helper `classifyFailure(err)` → `'switch' | 'retrySame' | 'fail'`，
  流式/非流式共用；`switch` 仅对 auto 请求生效，显式请求分类后照常标记
  但直接报错；
- 每次切换发 `fmf_route_notice`，新增 `reason` 字段：
  `unavailable` / `rate-limit` / `upstream`；
- 候选穷尽报错：HTTP 503 / SSE error envelope，message 含分类摘要
  `tried N models: x unavailable, y rate-limited, z upstream errors`。

### 4. 范围边界

- 仅 openai 兼容路由 + `auto`/`default`；显式指定模型失败直接报错，
  但**照常标记**（后续 auto 请求受益）；
- anthropic/gemini 路由既有的一次 rate-limit 切换、preflight、vision 候选：
  均不动；openai 路由显式请求的既有 preflight 限流切换同样不动；
- `af55ddf` 的 unavailable failover 被本设计取代（仅 auto + 永久标记 + 无上限）。

## 测试

**core**

- 序列生成：起点为轮询位置、完整降序、跳过冷却/已标记、环绕穷尽；
- 永久剔除 vs 限流冷却（到期后重新参与打分）；
- `formatResetTime(Infinity)` 返回"已永久剔除"。

**server**

- 3 坏 1 好 → 成功且 3 个被永久剔除；
- 全坏 → 穷尽报错，message 含分类摘要；
- 显式指定失败 → 不切换但被标记；
- 限流失败 → 标记冷却且继续往后选；
- 流式同上 + `wroteChunk` 后不切换；
- 既有回归：vision failover、max_tokens 重试、stream error envelope、
  auto modality 轮询。

## 风险

- **冷启动最坏延迟**：第一次请求可能连续撞到多个坏模型（每次 200-300ms），
  但失败即永久剔除，只拖累一次，可接受（用户已确认无上限）；
- **永久剔除误伤**：上游临时故障被识别为"不可用"会误剔除——由
  `parseModelUnavailableError` 模式严格限定（仅 no provider / model_not_found /
  no available channel 等明确语义），网络超时等不入此类；
- **池规模缩小**：大量永久剔除后候选变少，UI 冷却列表可查看与手动清除。
