/**
 * Codex（ChatGPT 订阅）可用模型目录。
 *
 * 静态列表：Codex CLI 的 Responses 网关不接受公开 /models 查询，官方客户端把
 * 模型清单随包下发（参考实现 internal/registry/models/codex_client_models.json）。
 * 这里只收录 visibility=list 且 supported_in_api=true 的对外可用条目，保持精简。
 */
export interface CodexCatalogModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
}

export const CODEX_CATALOG_MODELS: CodexCatalogModel[] = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', contextWindow: 500_000 },
  { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', contextWindow: 272_000 },
  { id: 'gpt-6-sol', displayName: 'GPT-6-Sol', contextWindow: 272_000 },
  { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', contextWindow: 272_000 },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', contextWindow: 272_000 },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', contextWindow: 272_000 },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', contextWindow: 272_000 },
  { id: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 272_000 },
];
