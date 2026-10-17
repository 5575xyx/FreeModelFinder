/**
 * Google（Cloud Code / cloudcode-pa 订阅）可用模型目录。
 *
 * 静态列表：cloudcode-pa 的 `v1internal:streamGenerateContent` 不接受通用的
 * `/models` 查询，官方客户端把模型清单随包下发。此处取自参考实现
 * CLIProxyAPI `internal/registry/models/models.json` 的 `antigravity` 段
 * （models.json:3944-4261）——该段正是 cloudcode-pa 网关的权威清单：
 *
 * - `gemini-4-argon-high`（models.json:4042-4074，context_length 1048576）
 * - `gemini-3.8-flash-high`（models.json:4076-4108，context_length 1048576）
 * - `gemini-3-flash`（models.json:4110-4143，context_length 1048576）
 * - `gemini-3.1-flash-lite`（models.json:4192-4226，context_length 1048576）
 * - `gemini-3.5-flash-lite`（models.json:4228-4261，context_length 1048576）
 *
 * 只收录 Google 品牌（`gemini-*`）的文本条目：同段的 claude-* / gpt-oss-* 由各自的
 * provider 负责，`gemini-3.1-flash-image` 是图像模型，均不在此列（对应提供方的
 * listModels 只声明 `capabilities: ['text']`）。
 */
export interface GoogleCatalogModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
}

export const GOOGLE_CATALOG_MODELS: GoogleCatalogModel[] = [
  { id: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon', contextWindow: 1_048_576 },
  { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', contextWindow: 1_048_576 },
  { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', contextWindow: 1_048_576 },
];
