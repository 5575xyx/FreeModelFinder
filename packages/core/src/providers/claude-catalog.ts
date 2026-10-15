/**
 * Claude（Claude Pro/Max 订阅）可用模型目录。
 *
 * 静态列表：`api.anthropic.com/v1/messages` 对 OAuth 凭据不提供公开 /models 查询，
 * 官方 Claude Code 客户端把模型清单随包下发。此处收录参考实现
 * （CLIProxyAPI `internal/registry/models/models.json` 的 `claude` 段与
 * `claude_executor_cloaking.go` 的官方 id/别名集合）中的主线 sonnet / opus /
 * haiku 条目，contextWindow 亦取自该清单，保持精简、可核对。
 */
export interface ClaudeCatalogModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
}

/** Anthropic Messages 协议要求 `max_tokens` 必填；请求未提供时的兜底值。 */
export const DEFAULT_MAX_TOKENS = 8192;

export const CLAUDE_CATALOG_MODELS: ClaudeCatalogModel[] = [
  { id: 'claude-sonnet-4-5', displayName: 'Claude 4.5 Sonnet', contextWindow: 200_000 },
  { id: 'claude-opus-4-1', displayName: 'Claude 4.1 Opus', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5', displayName: 'Claude 4.5 Haiku', contextWindow: 200_000 },
  { id: 'claude-opus-4-5', displayName: 'Claude 4.5 Opus', contextWindow: 200_000 },
  { id: 'claude-sonnet-4-6', displayName: 'Claude 4.6 Sonnet', contextWindow: 200_000 },
  { id: 'claude-opus-4-6', displayName: 'Claude 4.6 Opus', contextWindow: 1_000_000 },
];
