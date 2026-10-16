import { randomBytes } from 'node:crypto';

/** 32 字节 base64url 恰好是 43 个字符，且全部落在 [A-Za-z0-9_-] 内。 */
const STATE_BYTES = 32;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * 生成 OAuth `state`（防 CSRF + 会话定位）。
 *
 * 与参考项目 `misc.GenerateRandomState` 同职责：调用方拿它拼授权 URL，
 * 回调时再原样比对。
 */
export function generateState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}

/**
 * 校验 `state` 形状。
 *
 * 先做形状检查再查会话表，是为了让明显伪造的输入不去碰会话存储
 * （参考项目 `ValidateOAuthState` 同样是先验后查）。
 */
export function isValidState(state: string): boolean {
  return STATE_PATTERN.test(state);
}
