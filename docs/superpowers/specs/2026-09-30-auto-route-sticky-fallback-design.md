# auto 路由：结构化档位 + 会话粘性 fallback 链 设计

日期：2026-09-30
状态：已批准（brainstorming 通过，用户授权按调研结论定稿）

## 背景

`model: "auto"` 文本兜底路径自 2026-09-23 起为「打分 → Top-3 → 池内 round-robin」。
实践中暴露两个确定性缺陷：

1. **打分只匹配模型 id 字符串**（`heuristicCapabilityScore`，`auto-router.ts:120`）：
   - `if/else if` 链让高档正则截胡低档特征 —— `cpa:gpt-4o-mini` 命中 95 档的 `gpt-4o` 而非 65 档的 `mini`；`glm-4-flash` 命中 80 档的 `glm-4`；`glm-4.5-flash` 命中 95 档
   - 参数量子串无边界（`40b` 命中 `140b`）
   - 同分按 `localeCompare` 字母序决胜（`registry.ts:500`）→ `cpa:gpt-4o` 排在 `cpa:gpt-5.5` 前面
   - 实测 99 模型的 Top-3 = `custom:3`，Top-8 仍 = `custom:8` —— 单纯扩大 `slice(N)` 无效
2. **round-robin 与业界主流相悖**：Copilot 官方明确反对中途换模型（cache 成本），Windsurf 教用户"粘住"，Kilo Efficient 档"相关轮次粘同一模型"。同类场景（免费模型池）的 Kilo Auto Free 档虽做池内分流，但同样带会话粘性。
3. **上下文超限是反应式处理**：2026-09-30 的 B1 修复让 `context_length_exceeded` 触发 failover + 60s 冷却，但仍要**先发出去、收 400、再换**。LiteLLM `enable_context_window_escalation`（默认开、`0.95` buffer）是发送前预检的少数派做法，省一次失败调用。

调研覆盖 OpenRouter / LiteLLM / Portkey / Cursor / Copilot / Windsurf / Zed / Trae / Kiro / Claude Code / Codex CLI / Gemini CLI / Cline / Aider / OpenCode / Roo / Kilo 共 17 个系统，跨系统共识：

- 没有任何一家用字符串正则给模型 id 打分；模型身份靠结构化查表（catalog / per-model 配置 / litellm JSON）
- **先过滤（硬约束）后排序（软偏好）**
- 选中结果是**主选 + 有序 fallback 链**，不是单一 Top-1；不同错误类型走不同处理
- 路由自身必须 fail-open（分类/排名故障降级到默认集，请求不因路由设施失败）

## 已确认的需求决策

| 决策点       | 选择                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| 打分改造深度 | **乙：结构化档位查表**（弃 id 正则子串，改为 profile 解析 + 档位→分数表）                                        |
| 池策略       | **会话粘性 + 失败才换**（替代 round-robin，OpenRouter/LiteLLM/Claude Code 同构）                                 |
| 池内构成     | **同 provider 最多 2 席**（在 fallback 链上生效，防止单厂垄断链首与链身）                                        |
| 上下文超限   | **发送前预检剔除**（`0.95 × contextWindow`），保留 B1 的收 400 兜底                                              |
| 错误分类     | B1 的 `kind: 'context'` 不变；400 请求形状错误仍不切换                                                           |
| 策略覆盖     | 只改 `capability` 策略；`speed`、`rate-limit` 策略与 `profile.*Score` 覆盖语义一律不动                           |
| 分数值域     | 保持 `95 / 80 / 65 / 45 / 30 / 50` + `contextWindow ≥ 128k 时 +5`，`score-model.test.ts` S1–S10 全部必须继续通过 |

## 行为规格

### §1 结构化档位解析（新建 `packages/core/src/model-tier.ts`）

```
parseModelProfile(id) -> { tier, generation }
  归一化: 先 id.replace(/_/g, '-')，下述全部匹配与 generation 解析都用归一后的值
  tier: 'flagship' | 'large' | 'standard' | 'small' | 'minor' | 'tiny'
  generation: 数值代际，解析不到为 null

判定顺序（第一个命中即止）：
  1. 缩小标记（tiny 档）:  tiny | \b(?:1|2|3)b\b
  2. 缩小标记（minor 档）: small | nano | \b(?:7|8|9|10)b\b
  3. 缩小标记（small 档）: \bmini\b | flash | haiku | \blite\b | mixtral | command-r
                           | \b(?:13|14|20)b\b
  4. 扩大标记（flagship）: opus | gpt-5 | gpt-4o | deepseek-r1 | deepseek-v3
                           | glm-4\.5 | qwen-max | gemini-2\.5-pro | claude-3\.5
                           | \b(?:65|70|72|80|405)b\b
  5. 扩大标记（large）:    gpt-4 | glm-4 | gemini-2\.0 | deepseek-v2 | qwen-plus
                           | sonnet | \b(?:30|32|34|40)b\b
  6. 全部未命中 → standard
     注一: \b 必需 —— gemini 自下标 2 起含子串 mini，无边界会把 gemini-2.5-pro 判成 small。
     注二: 参数桶之外的超大参数量（120b / 140b / 235b / 480b 等）同样落 standard(50)，
           要进 flagship 必须另有显式标志（gpt-5 / deepseek-v3 / qwen-max 等）。

tier → capability 分数：
  flagship 95 | large 80 | small 65 | minor 45 | tiny 30 | standard 50
  contextWindow >= 128_000 → +5

generation 解析（同分次级排序键，降序）：
  gpt-5.5 → 5.5, gpt-4o → 4, claude-3.5 → 3.5, glm-4.5 → 4.5,
  deepseek-v3 → 3, gemini-2.5 → 2.5, qwen3 → 3, llama-3.1 → 3.1
  解析不到 → null（排在所有数值之后），三级键仍是 id 字母序
```

**关键语义：缩小标记优先于扩大标记**（步骤 1–3 在 4–5 之前判定），这一条直接消除截胡：

| 模型 id             | 现状分数 | 新分数 | 原因                                                                   |
| ------------------- | -------- | ------ | ---------------------------------------------------------------------- |
| `cpa:gpt-4o-mini`   | 95       | **65** | `mini` 在缩小标记集先命中                                              |
| `glm-4-flash`       | 80       | **65** | `flash` 先命中                                                         |
| `glm-4.5-flash`     | 95       | **65** | `flash` 先命中                                                         |
| `claude-3.5-haiku`  | 95       | **65** | `haiku` 先命中                                                         |
| `claude-3.5-sonnet` | 95       | 95     | `claude-3.5` 在 flagship 步先于 `sonnet`（large 步）命中，判定顺序所致 |
| `cpa:gpt-4o`        | 95       | 95     | 无缩小标记                                                             |
| `cpa:gpt-5.5`       | 95       | 95     | 无缩小标记，但 `generation 5.5 > 4` → 排序升到 `gpt-4o` 之前           |
| `llama-3.1-70b`     | 95       | 95     | S1 保持                                                                |
| `qwen2.5-3b`        | 30       | 30     | S2 保持                                                                |

### §2 候选链构建（替换 `registry.ts:pickFromScoredPool`）

```
buildFallbackChain(candidates, strategy, profile, estInputTokens)
  1. 硬过滤（先过滤后排序）：
     a. provider 共享配额冷却 → 剔除（现状已有）
     b. 模型冷却 / 永久剔除 → 剔除（现状已有）
     c. 【新】estInputTokens > 0.95 × contextWindow → 剔除
        contextWindow 缺失 → 不过滤（LiteLLM「窗口未知则不动」）
     d. 【新】c 全部剔空 → 放宽到「contextWindow 最大的前几个」，不返回空链
  2. 软排序：scoreModel(desc) → generation(desc) → 同 provider 最多 2 席 → id(asc)
  3. 取前 5 作为有序 fallback 链
```

`同 provider 最多 2 席` 的实现为**排序后的贪心筛选**：遍历已按分数排好的列表，某 provider 已入链 2 个则跳过，直到链满 5 或耗尽。

**链的作用域（重要，与失败切换的区别）**：候选链（含同厂 2 席、取前 5）**只约束初始主选与 §5 上报的 `pool`**。失败切换（B1 的 `advanceFailover`）走的是独立通道 —— `AutoRouter.rankCandidates()`：**全池、无席位上限**，同序 `score → generation → id`（本次让两者 generation 序统一，消除「主选按 generation 排、切换按 id 排」导致切换跳过候选的不一致）。
因此：

- 单 provider 目录下初始链最多 2 项，但失败切换仍能遍历该 provider 的全部候选；
- `pool` 是「初始链」而非「切换可走集合」，两者不必相等；
- 失败切换成功后写入的粘性，若目标不在当前链内，下一轮会被 §3 的链成员校验清除并重选 —— 这是预期行为，不是缺陷。

### §3 会话粘性（新表，模块级，与 `autoPoolCursor` 同级）

```
sessionKey = hash(首条 user 消息的 role + content)
  content 按 `ChatMessageSchema` 恒为 string，直接参与 hash；
  可选的 `contentParts`（图片等多模态分片）不参与指纹 —— 图片内容逐轮变化，
  纳入会导致同会话指纹漂移。
  （协议无 session_id 字段；同一会话多轮时首条 user 消息不变 → 指纹稳定；
    不同会话首条不同 → 自然隔离）
  回退语义：无任何 user 消息时取 `messages[0]`（role + content 一并入指纹）；
    连 messages 也为空则返回常量 `'empty'`。畸形请求才走到这里，影响可忽略。

pickAutoModel(request):
  1. 取 sessionKey → 查粘性表 { provider, modelId, expiresAt }
     - 命中、未过期、且**仍在当前候选链内**（§2 构建的链）→ 直接返回，不重算链
     - 命中但已不健康或**跌出候选链**（冷却/剔除/窗口不够/超出同厂 2 席或前 5）→ 删除该条，继续步骤 2
  2. 未命中 → 构建 fallback 链 → 链首为主选 → 写入粘性表
  3. fallback 成功后 → 用成功的模型更新该 session 的粘性表

TTL = 5 分钟（对齐 OpenRouter 的 provider 缓存 TTL）
容量上限 = 1000 条，超出按插入序淘汰最旧条目（FIFO，不做访问刷新）
进程级内存表，不持久化 —— 重启丢失可接受（fail-open）

粘性表刻意做成 `auto-router.ts` 文件级单例（与 `autoPoolCursor` 同级），
语义上比 `cooldowns` 实例字段更"长命"：设置页保存配置会 `new ProviderRegistry()`，
粘性表**跨实例存活**，换取会话在配置热重载后仍连续。陈旧条目无害 ——
命中后必过 §2 链成员校验（不在当前链即删除重算），不会粘到已失效模型。
```

### §4 上下文预检（增强 B1，反应式 → 预检式）

```
estimateInputTokens(request) =
    ceil((messages 文本总字符 + JSON.stringify(tools ?? []).length) / 3)
  messages 文本 = 各条 content（string）+ contentParts 中 text 分片 + tool_calls 的 arguments
  （不含 tool_calls 的 name —— 测试硬规格钉 200，差 1 token 无影响；非 text 部件如 image_url 计 0）
  （Cline 同款保守系数 CHARS_PER_TOKEN = 3；`ChatRequest.tools` 为可选字段，缺省时只计 messages）

命中 §2-1-c 时：该候选被剔除，**不产生任何上游调用**
若请求最终仍因上下文超限被上游 400 拒绝 → 走 B1 既有路径
  （kind: 'context' → failover + 60s model 级冷却 + SwitchNotice cause='context'）
```

即：**预检是前置优化，B1 是保底兜底**，两者共存不互斥。

### §5 可观测

`fmf_auto_route` 附加字段扩展为 `{ pool: [...], picked, strategy, sticky: boolean }`，
`sticky: true` 表示本次命中粘性表未重算链。切换通知 `SwitchNotice` 结构不变。

## 不做的事（YAGNI）

- 不引入 prompt 分类 / 小模型分类器（调研的丙方案，改动面过大，留待后续）
- 不引入加权随机采样（保持确定性，便于测试与复现）
- 不持久化粘性表 / 不引入 Redis
- 不改 `speed`、`rate-limit` 策略，不改 `profile.capabilityScore/speedScore/rpmLimit` 覆盖语义
- 不改模态池（image/video）路径 —— 打分池只服务文本兜底
- 不改 UI（无新配置项、池大小不做成可配置）
- 不改 `preflight` / `maybeSwitchBack` 的 429 兜底逻辑
- 不做跨进程会话共享（单实例内存表足够）

## 测试面

**新增 `packages/core/src/__tests__/model-tier.test.ts`**

- 截胡回归：`gpt-4o-mini→65`、`glm-4-flash→65`、`glm-4.5-flash→65`、`claude-3.5-haiku→65`
- 扩大标记正常：`gpt-4o→95`、`gpt-5.5→95`、`opus→95`、`llama-70b→95`、`sonnet→80`
- 参数量边界：`3b→30`、`10b→45`、`20b→65`、`40b→80`、`70b→95`、**`140b` 不得被 `40b` 命中**
- 代际：`gpt-5.5 generation 5.5` > `gpt-4o generation 4`；解析不到 → null
- contextWindow ≥128k → +5

**改 `score-model.test.ts`**

- S1–S10 必须原样通过（约束见「需求决策」表）
- 新增：同分时 generation 降序生效

**改 `registry.test.ts`「auto scored pool」段（`315–461` 行）**

- 删除/改写：`round-robins across the scored pool`、`wraps the pool cursor around`（轮换语义不复存在）
- 保留：`skips cooling-down members`、`falls back to the first catalog model when whole pool cooling`、`recomputes the pool when strategy changes`
- 新增：
  - 同一会话连续两次请求 → 同一模型（粘性命中）
  - 不同首条消息 → 可进入不同模型
  - 粘住的模型被冷却 → 下次重选并更新粘性
  - fallback 成功 → 粘性表更新为成功模型
  - 同 provider 在链中不超过 2 席
  - 链含 >2 个 provider（垄断被打破）
  - 预检：`estInputTokens > 0.95 × window` 的候选不进链
  - 全部候选被预检剔除 → 回退到最大窗口候选，不返回空

**新增 server e2e（`packages/server/src/__tests__/`）**

- `POST /v1/chat/completions model=auto` 同一用户首条消息连发两次 → 两次命中同一模型
- 响应含 `fmf_auto_route.sticky`
- 模拟上游 `context_length_exceeded` 且预检无法提前发现（窗口未知）→ 仍走 B1 failover（回归）

## 文件影响

| 文件                                                     | 改动                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/model-tier.ts`                        | **新建**：`parseModelProfile` + tier→分数查表 + generation 解析                                                           |
| `packages/core/src/context-estimate.ts`                  | **新建**：`estimateInputTokens`（字符/3 + tools）                                                                         |
| `packages/core/src/router/auto-router.ts`                | `heuristicCapabilityScore` 改为调用 `model-tier`；新增粘性表（`stickyStore`）与 TTL/LRU；新增 `pickSticky` 语义；预检过滤 |
| `packages/core/src/registry.ts`                          | `pickFromScoredPool` → `buildFallbackChain` + 粘性查表；排序键加 generation 与同厂 2 席；移除 `autoPoolCursor`            |
| `packages/core/src/index.ts`                             | 导出 `parseModelProfile`、`estimateInputTokens`                                                                           |
| `packages/core/src/__tests__/model-tier.test.ts`         | 新建                                                                                                                      |
| `packages/core/src/registry/__tests__/registry.test.ts`  | 改写轮换段为粘性/链语义                                                                                                   |
| `packages/core/src/router/__tests__/score-model.test.ts` | 新增代际排序用例，S1–S10 保持                                                                                             |
| `packages/server/src/__tests__/`（新文件）               | e2e 粘性 + 预检 + B1 回归                                                                                                 |

## 风险与回退

- **风险 1**：粘性让同一会话长时间固定模型，若该模型静默降质，用户在 TTL 内无法自动跳出。
  缓解：粘性仅在模型**健康**时生效；B1 的 context/429/unavailable 冷却会立即打破粘性。
- **风险 2**：首条消息指纹把「同一模板的多次新会话」判成同一 session（内容相同）。
  影响仅是它们共享同一主选，无正确性问题；TTL 5 分钟后自然解绑。
- **风险 3**：预检的字符/3 估算对中文偏乐观（中文 1 字 ≈ 1 token 而非 1/3）。
  缓解：预检只是**剔除明显装不下的候选**，且保留 B1 的 400 兜底；估算偏差不会造成请求失败。
- **风险 4**：含图消息的文本会被计两遍 —— `content` 已含归一化文本，`contentParts` 又含同批 text 分片。
  这是本公式字面要求 +「宁可略高」的允许方向，属**已知保守偏差**，不要当 bug 修；
  真要消除需改动协议归一化逻辑，风险远大于收益。
- **回退**：粘性表与预检过滤各自独立开关点（`pickAutoModel` 内两个 if 分支），
  紧急情况下删除粘性分支即回到「链 + 每次重算」，行为仍优于现状 round-robin。
