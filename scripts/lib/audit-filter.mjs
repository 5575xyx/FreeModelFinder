// 订阅账号（ChatGPT/Codex、Claude、Google）走的是用户已付费的订阅额度，
// 不是免费 API key：把它们的模型列进 FREE_MODELS.md 会让读者误以为可以直接
// 白嫖。因此免费审计必须同时挡住两件事——订阅 provider 被启用，以及任何
// 带 subscription 标记的模型行（哪怕它的 free 字段是 true）。
export const SUBSCRIPTION_PROVIDERS = Object.freeze(['codex', 'claude', 'google']);

/**
 * 免费审计是否应该保留这个模型。
 * @param {{ id?: unknown, free?: unknown, subscription?: unknown } | null | undefined} model
 */
export function isFreeAuditModel(model) {
  if (!model || model.free !== true) return false;
  if (model.subscription === true) return false;
  return typeof model.id === 'string' && model.id.trim().length > 0;
}

/** 免费审计是否应该抓取这个 provider 的目录。 */
export function isFreeAuditProvider(id) {
  return !SUBSCRIPTION_PROVIDERS.includes(id);
}
