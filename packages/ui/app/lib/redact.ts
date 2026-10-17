/**
 * server 已经对上游错误做过 redact，这里是第二道防线：上游偶尔把令牌片段
 * 拼进错误文案，UI 兜底保证它不会出现在屏幕上（更不会被截图传播）。
 * 三家 OAuth 令牌都带 `rt-`/`sk-` 一类前缀且往往短于 40 字符，所以除了长
 * base64 串之外，还要按前缀形状匹配。
 *
 * ⚠️ 与 `packages/core/src/credentials/redact.ts` 是**有意为之的副本**（UI 包不依赖
 * core，否则会把 `node:fs` 一类服务端代码拖进浏览器 bundle）。改一侧必须同步改另一侧，
 * 并同步改两边的测试。
 */

/** 上游 token 端点的 JSON 错误体里的凭据键；`error` 一类诊断信息必须留着。 */
const JSON_SECRET_KEYS = 'refresh_token|access_token|id_token|client_secret|code_verifier';

export function redactSecrets(message: string): string {
  return message
    .replace(new RegExp(`("(?:${JSON_SECRET_KEYS})"\\s*:\\s*")[^"]*(")`, 'gi'), '$1[REDACTED]$2')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(refresh_token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:rt|sk|pk|key|token)[-_][A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
}
