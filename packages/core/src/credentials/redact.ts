/**
 * 抹掉错误文案里可能夹带的凭据。
 *
 * 上游 OAuth 端点出错时回的是 **JSON body**，形如
 * `{"error":"invalid_grant","refresh_token":"1//0eXa…"}`。这种形状既不匹配
 * `k=v`（键与值之间是 `":` 而不是 `=`），Google 的 `1//…` 刷新令牌又往往短于
 * 40 字符，所以 `k=v` 与长 base64 两条规则都漏 —— 必须单独按 JSON 值形态匹配。
 *
 * 只抹固定几个凭据键：`error` / `error_description` 这类是**用户唯一能拿去判断**
 * 的信息，必须原样留着。
 */
const JSON_SECRET_KEYS = 'refresh_token|access_token|id_token|client_secret|code_verifier';

export function redact(message: string): string {
  return message
    .replace(new RegExp(`("(?:${JSON_SECRET_KEYS})"\\s*:\\s*")[^"]*(")`, 'gi'), '$1[REDACTED]$2')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(refresh_token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
}
