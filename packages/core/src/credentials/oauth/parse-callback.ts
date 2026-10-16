import type { CallbackQuery } from './loopback.js';

/**
 * 回调粘贴框的输入解析失败。
 *
 * 两种文案刻意固定，UI 侧可以直接匹配；与参考项目 `misc/oauth.go:68` / `:116`
 * 逐字一致。
 */
export class CallbackParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallbackParseError';
  }
}

/**
 * 宽容地解析用户粘贴的 OAuth 回调 URL。
 *
 * 用户在「授权完成后粘贴回调」这一步的输入五花八门：完整 URL、只有 query、
 * 只有 path、只有 `k=v` 串、甚至 Claude 的 `code#state` 形态。这个函数把这些
 * 形态都解析成同一个 `CallbackQuery`，供会话存储与等待方直接消费，中间不 reshape。
 *
 * 单一职责：只做解析。脱敏（`redact`）在交付点做，这样 UI 侧也能复用这个
 * 解析器而不引入会话语义。
 *
 * 返回约定：空串 / 纯空白 → `null`（表示「什么都没粘」，与「粘了但解析不出」
 * 区分开）；解析不出 URL 或既无 `code` 也无 `error` → 抛 `CallbackParseError`；
 * 其余 → `{code, state, error?}`，`error` 为空串时该键**不出现**。
 */
export function parseCallbackUrl(input: string): CallbackQuery | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 裸 `code#state`（Claude 形态）：独立早分支，必须排在 URL 前缀化之前。
  //
  // ⚠️ 参考项目 `misc/oauth.go:63-64` 会把含 `#` 的输入归入 `http://` 前缀分支，
  // 得到 `http://C#S`（host=`C`、fragment=`S`、query 空），随后 `:115` 因
  // `code==""` 返回 `callback URL missing code` —— 参考其实**不支持**这个形态。
  // 这里按已批准设计表格补上（严格超集），判定条件刻意收紧：不含 `://`、`=`、`/`、
  // `?`、`:` 且含 `#`，避免把真正的 URL 误判成裸对。
  if (
    trimmed.includes('#') &&
    !trimmed.includes('://') &&
    !trimmed.includes('=') &&
    !trimmed.includes('/') &&
    !trimmed.includes('?') &&
    !trimmed.includes(':')
  ) {
    const [code, state] = trimmed.split('#', 2);
    return { code: code ?? '', state: state ?? '' };
  }

  // URL 前缀化（对齐 `misc/oauth.go:58-64`）：用户常常只粘了回跳 URL 的尾部片段。
  let candidate: string;
  if (trimmed.startsWith('?')) {
    candidate = 'http://localhost' + trimmed;
  } else if (trimmed.includes('://')) {
    candidate = trimmed;
  } else if (trimmed.includes('/')) {
    candidate = 'http://' + trimmed;
  } else if (trimmed.includes('=')) {
    candidate = 'http://localhost/?' + trimmed;
  } else {
    candidate = 'http://' + trimmed;
  }

  let url: URL;
  try {
    // Go 的 `url.Parse` 对畸形输入极其宽容；JS 的 `new URL()` 会抛，抛了就归一
    // 成 `invalid callback URL`。唯一行为差异是 query 里的非法百分号编码（Go 给
    // `ParseErrorValue`，JS 原样保留 `%ZZ`）—— 对真实回跳 URL 无影响，不写特判。
    url = new URL(candidate);
  } catch {
    throw new CallbackParseError('invalid callback URL');
  }

  const query = url.searchParams;
  let code = (query.get('code') ?? '').trim();
  let state = (query.get('state') ?? '').trim();
  let error = (query.get('error') ?? '').trim();
  const description = (query.get('error_description') ?? '').trim();

  // fragment 兜底（对齐 `:84-102`）：有些 provider 把 code/state 放进 fragment。
  // 只补**空**字段，不覆盖 query 已有的值。
  if (url.hash) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (!code) code = (fragment.get('code') ?? '').trim();
    if (!state) state = (fragment.get('state') ?? '').trim();
  }

  // `code` 里夹着 `#`：`CODE%23STATE` 解出来是 `CODE#STATE`（对齐 `:104-108`，
  // Go 的 `SplitN(code, "#", 2)`）。`#` 后**全部**留给 state，含再出现的 `#`。
  // 先取后半段再重赋值 code，否则下标会指错。
  if (code && !state && code.includes('#')) {
    const parts = code.split('#', 2);
    state = parts[1] ?? '';
    code = parts[0] ?? '';
  }

  // `error_description` 提升为 `error`（对齐 `:110-113`）：只回 description 的
  // provider 也要能显示原因。提升后返回的 `error` 只可能是非空串。
  if (!error && description) error = description;

  if (!code && !error) {
    throw new CallbackParseError('callback URL missing code');
  }

  const result: CallbackQuery = { code, state };
  if (error) result.error = error;
  return result;
}
