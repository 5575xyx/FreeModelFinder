# 通过 cline-free 接入 Cline 免费额度

## cline-free 是什么

cline-free 是一个把 Cline 的免费额度封装成本地 OpenAI 兼容反代的服务：在本机启动一个常驻进程后，它监听 `http://localhost:8787/v1`，并接受形如 `sk-cline-*` 的 API Key。任何 OpenAI 兼容客户端（包括 FreeModelFinder）都可以把 Base URL 指向这个本地地址，由 cline-free 转发到上游并复用 Cline 的免费额度。

它的特点是：

- **本地进程**：需要先自行启动 cline-free，FreeModelFinder 才能连通；
- **OpenAI 兼容**：提供 `/v1/chat/completions` 等常规接口，无需专用适配；
- **Key 是本地占位符**：`sk-cline-*` 只用于通过本地反代的校验，不是向上游平台注册的密钥；
- **模型清单以运行时为准**：实际可用型号由 cline-free 决定，可能随上游变化。

在接入前可以先直接验证反代本身可用：

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-cline-***' \
  -d '{
    "model": "<cline-free 暴露的模型 ID>",
    "messages": [{"role": "user", "content": "hi"}],
    "max_tokens": 1
  }'
```

## 接入 FreeModelFinder

FreeModelFinder **不把 cline-free 内置为一等 Provider**，而是通过"自定义来源"零代码接入：

1. 启动 cline-free，确认上一节的 `curl` 可以正常返回；
2. 打开 Dashboard 的 **设置 → 自定义来源（Custom Sources）**，新增一个来源；
3. 按下表填写：

   | 字段       | 值                                                         |
   | ---------- | ---------------------------------------------------------- |
   | 来源名称   | 任意易识别的名称（会生成稳定的来源 ID）                    |
   | Base URL   | `http://localhost:8787/v1`                                 |
   | API Key    | `sk-cline-*`（按 cline-free 实际生成的值填写）             |
   | 模型列表   | cline-free 实际暴露的模型 ID，手填，不要照抄其他来源的型号 |
   | 显示名称   | 可选                                                       |
   | 上下文窗口 | 可选，按实际模型能力填写                                   |

4. 保存后，该来源的模型会以 `custom:<来源 ID>:<模型 ID>` 的形式进入模型目录，可以被设为默认模型，也可以在启用自动路由后参与 `auto` 切换。

配置步骤与[使用指南](USAGE.md)第 9 节「自定义 OpenAI-compatible 来源」完全一致。

## 风险与限制

- **灰色接口**：cline-free 依赖逆向得到的上游协议，随时可能变更；一旦上游调整，反代可能直接失效。
- **依赖本机常驻进程**：需要保持 cline-free 与 FreeModelFinder 同时运行；进程退出、端口被占用或启动顺序不对，都会导致该来源请求失败。
- **额度与清单不稳定**：免费额度、可用模型和限速都可能随时变化，需在 cline-free 侧自行确认，FreeModelFinder 无法感知其配额。
- **不经过免费目录审核**：自定义来源不参与项目的每日免费模型审计，价格、隐私、内容政策和协议兼容性都需要自行判断。
- **失败表现**：显式指定该来源的模型时，只有限流会触发一次备用切换，其余错误直接报错；使用 `auto` 或 `default` 时，连接被拒绝、进程退出等上游错误同样会被自动路由绕开到其他候选。
- **只应监听本机**：请确认 cline-free 仅绑定 `127.0.0.1`；如果它暴露到局域网或公网，任何可达主机都能直接用这个 Key 消耗你的免费额度。

## 为什么不做成一等 Provider

内置 Provider 需要稳定的官方接口、明确的免费规则和可审计的模型目录。cline-free 同时缺少这三点：协议是逆向的、免费额度不可承诺、模型清单无法静态审核，而且要求本机常驻一个额外进程。因此它走自定义来源接入，既不进入内置 Provider 列表，也不出现在每日发布的免费模型清单中。

如果上游将来提供**稳定的官方 API**，会再评估将其升级为一等 Provider：纳入目录审计、免费规则、`auto` 路由评分与故障降级逻辑。

## 常见问题

### Dashboard 中该来源的请求全部失败

先确认 cline-free 进程仍在运行、`http://localhost:8787/v1` 端口没有被其他程序占用，并用上文的 `curl` 直接验证反代本身可用。FreeModelFinder 侧只需确认 Base URL 和 Key 与本地配置一致。

### 提示模型不存在或返回 4xx

模型 ID 必须与 cline-free 当时实际暴露的清单一致：上游下线或改名后，自定义来源里手填的旧 ID 仍然保留，需要手动更新模型列表。该项目不会自动同步 cline-free 的模型目录。

### `auto` 没有切换到该来源

确认来源已保存成功、模型出现在目录中，且自动路由已启用。使用 `auto` 时，连接被拒绝、进程退出等上游错误也会被自动绕开到其他候选；只有显式指定该来源模型的请求才在限流之外直接报错。
