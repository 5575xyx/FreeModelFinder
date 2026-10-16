/**
 * server 已经对上游错误做过 redact，这里是第二道防线：上游偶尔把令牌片段
 * 拼进错误文案，UI 兜底保证它不会出现在屏幕上（更不会被截图传播）。
 * 三家 OAuth 令牌都带 `rt-`/`sk-` 一类前缀且往往短于 40 字符，所以除了长
 * base64 串之外，还要按前缀形状匹配。
 */
export function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(refresh_token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:rt|sk|pk|key|token)[-_][A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
}
