# 订阅账号 OAuth 手动回调（第三波）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 远程部署（浏览器 ≠ 网关）下三家订阅账号仍能完成 OAuth 登录 —— 面板在 `waiting` 阶段给出「粘贴回跳 URL」入口，服务端按参考项目宽容解析后走同一条落库路径。

**Architecture:** 新增一个纯函数解析器 `parseCallbackUrl`（core，无 IO），把参考项目 `internal/misc/oauth.go:53-126` 的宽容解析移植过来；server 的 `readCallback` 改用它；UI 弹窗在 `waiting` 阶段新增一块表单，把整条回跳 URL 或授权码 POST 回既有的 `/api/subscription/oauth/callback`。不新增端点 —— 两条轨共用同一个 `callbackHandler`，校验与失败路径才能完全一致。

**Tech Stack:** TypeScript (ES2022, `noUncheckedIndexedAccess: true`)、Node 内置 test runner (`--import tsx`)、Fastify、React 19 + Vitest + msw + Testing Library、Prettier (printWidth 100)。

**Spec:** `docs/superpowers/specs/2026-10-16-subscription-oauth-manual-callback-design.md`（本计划与之偏离处见 §「与设计文档的偏离」，均已实测核实）

## Global Constraints

- **TDD**：每个 Task 先写失败测试、跑出 RED、再实现、跑出 GREEN。
- **门禁串行**：`format:check` → `lint` → `build:runtime` → `typecheck` → `test:coverage`。`build:runtime` 内含 tsup `clean:true`，**并发会清空 dist**。
- **测试 glob 是固定单层**：core 只收 `src/credentials/__tests__/*.test.ts`，**嵌套目录里的测试会静默不执行**（第二波踩过一次，本计划已避开）。
- **覆盖率阈值不降**：core 85% 行 / 74% 分支；server 80% / 75%；cli 80% 行；ui 无阈值。
- **提交不推送**：本计划完成后本地领先远端；推送由用户决定。
- **端口空闲前置**：跑 server 的 OAuth 测试前确认 `1455 / 54545 / 51121` 空闲。
- **PowerShell 陷阱**：管道 JSON 转义会坏（改用临时脚本文件）；`pnpm <script>` 输出里 `node.exe : $ ...` 与 `RemoteException` 是 stderr 噪声，不影响退出码；退出码用 `*> file` 重定向后单独读。

## 与设计文档的偏离（均已实测，不猜）

1. **测试路径**：设计写 `src/credentials/oauth/__tests__/parse-callback.test.ts`。core 的 glob 是 `src/credentials/__tests__/*.test.ts`，嵌套目录**静默不执行**。本计划放在 `src/credentials/__tests__/parse-callback.test.ts`。
2. **裸 `code#state`**：设计 §3.3 把 `C#S` 标为「拆 `#`（Claude 形态）」。参考项目实际**不**支持这个形态 —— `misc/oauth.go:63` 把含 `#` 的输入归入 `http://` 前缀分支，得 `http://C#S`（host=`C`、fragment=`S`、query 为空），`:104` 的拆 `#` 只在 **query 值里 `%23` 解码成 `#`** 时才触发，随后 `:115` 因 `code==""` 返回 `callback URL missing code`。本计划**仍按设计表格实现**（严格超集，成本 ~6 行），但在代码注释里写明这一点，避免后续有人以为对齐了参考。两种真实形态（完整 URL、`?code=X%23Y`）都能解析。
3. **`docs/USAGE.md`**：设计交付物表写「若该文档已有对应小节」。实测该文档**完全没有**订阅小节（grep 0 命中），跳过。
4. **`docs/SERVER_MODE.md` + `docker-compose.yml`**：本计划**不重复** —— 已在修复波次 `155df05` 交付。
5. **placeholder 逐家化**（设计 §4 要求「面板提示必须逐家准确」）：用 `{endpoint}` 参数复用组件已有的 `endpoint` 变量（`SubscriptionProviderDialog.tsx:82`），而不是写死 Codex 的 `localhost:1455`。
6. **新增 B1 类修复**：设计未提，但核实时发现 loopback 路径的 provider error 也没过 `redact`（`loopback.ts:191` 直接 `deliver({error: providerError})`）。用户粘贴的内容正是这条路的入口，所以一并修掉 —— 见 Task 1 / Task 2。

## Review Focus

1. **用户粘的是授权页地址而非回跳地址**（`https://auth.openai.com/oauth/authorize?...`）：不含 `code` 也不含 `error` → 解析失败 → `400 invalid redirect_url`，且**不消耗** pending 会话，可重贴。→ Task 2「rejects a redirect_url with no code and no error without consuming the session」
2. **粘贴内容里含明文令牌**（用户可能把整个 auth 响应粘进 `error_description`）：落进会话存储与 `/status` 响应前必须先过 `redact`。→ Task 1「masks a token inside the provider error before delivering」+ Task 2「redacts a token inside the submitted error before storing it」
3. **已取消 / 已过期的 state 再提交**：`400 unknown or expired state`，账号表不变（不得复活）。→ Task 2「rejects a redirect_url for a cancelled state and stores no account」
4. **`state` 从 UI 显式回传优先**（设计 §3.4）：URL 解析出的 state 仅作兜底，UI 手里的 state 才是权威。→ Task 3「posts the pasted url with the session state and keeps polling on success」（断言 payload 里的 `state` 等于 `auth-url` 返回的那份）
5. **提交成功但响应是 HTML**：成功分支是 `200 text/html`，面板**绝不能** `response.json()`；必须先看 `response.ok`。→ Task 3「posts the pasted url …」（服务端回的是 HTML，组件必须不崩溃并继续轮询）

---

## Task 1: 宽容解析器 + provider error 脱敏（core）

**Files:**

- Create: `packages/core/src/credentials/oauth/parse-callback.ts`
- Modify: `packages/core/src/credentials/oauth/loopback.ts:191`（交付点过 `redact`）
- Modify: `packages/core/src/index.ts`（oauth 导出组补一行）
- Test: `packages/core/src/credentials/__tests__/parse-callback.test.ts`（新建）
- Test: `packages/core/src/credentials/__tests__/oauth-loopback.test.ts`（追加 1 条）

**Interfaces:**

- Consumes: `CallbackQuery`（`packages/core/src/credentials/oauth/loopback.ts:31-36`，**只导类型**）
- Produces:
  - `parseCallbackUrl(input: string): CallbackQuery | null` —— 空/纯空白 → `null`（"什么都没粘"）；不可解析或既无 `code` 也无 `error` → 抛 `CallbackParseError`；其余 → `{code, state, error?}`，`error` 为空串时**不出现该键**
  - `class CallbackParseError extends Error` —— `name === 'CallbackParseError'`，message 为 `invalid callback URL` 或 `callback URL missing code`（与参考项目 `misc/oauth.go:68` / `:116` 文案逐字一致）
  - 行为变更：`startLoopbackListener` 交付的 `CallbackQuery.error` 先过 `redact`

- [ ] **Step 1a: 写解析器失败测试** `packages/core/src/credentials/__tests__/parse-callback.test.ts`

沿用 core 现有约定（`import assert from 'node:assert/strict'` + `import { describe, it } from 'node:test'`，参照同目录 `oauth-loopback.test.ts`）。逐条覆盖设计 §3.3 表格：

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CallbackParseError, parseCallbackUrl } from '../oauth/parse-callback.js';

describe('parseCallbackUrl', () => {
  it('returns null for empty and whitespace-only input', () => {
    assert.equal(parseCallbackUrl(''), null);
    assert.equal(parseCallbackUrl('   \t '), null);
  });

  it('parses a full callback URL', () => {
    assert.deepEqual(
      parseCallbackUrl('http://localhost:1455/auth/callback?code=CODE_A&state=STATE_A'),
      { code: 'CODE_A', state: 'STATE_A' },
    );
  });

  it('parses a bare query string by prefixing http://localhost', () => {
    assert.deepEqual(parseCallbackUrl('?code=CODE_B&state=STATE_B'), {
      code: 'CODE_B',
      state: 'STATE_B',
    });
  });

  it('parses a bare path by prefixing http://', () => {
    assert.deepEqual(parseCallbackUrl('auth/callback?code=CODE_C&state=STATE_C'), {
      code: 'CODE_C',
      state: 'STATE_C',
    });
  });

  it('parses bare k=v by prefixing http://localhost/?', () => {
    assert.deepEqual(parseCallbackUrl('code=CODE_D&state=STATE_D'), {
      code: 'CODE_D',
      state: 'STATE_D',
    });
  });

  it('splits a bare code#state pair (Claude form)', () => {
    assert.deepEqual(parseCallbackUrl('CODE_E#STATE_E'), {
      code: 'CODE_E',
      state: 'STATE_E',
    });
  });

  it('splits a percent-encoded # inside the code value', () => {
    assert.deepEqual(parseCallbackUrl('http://localhost:54545/callback?code=CODE_F%23STATE_F'), {
      code: 'CODE_F',
      state: 'STATE_F',
    });
  });

  it('reads code and state from the URL fragment when the query is empty', () => {
    assert.deepEqual(
      parseCallbackUrl('http://localhost:1455/auth/callback#code=CODE_G&state=STATE_G'),
      { code: 'CODE_G', state: 'STATE_G' },
    );
  });

  it('prefers the query values over fragment values', () => {
    assert.deepEqual(
      parseCallbackUrl(
        'http://x/cb?code=FROM_QUERY&state=FROM_QUERY#code=FROM_FRAG&state=FROM_FRAG',
      ),
      { code: 'FROM_QUERY', state: 'FROM_QUERY' },
    );
  });

  it('surfaces an error-only callback as a failure with no code', () => {
    assert.deepEqual(parseCallbackUrl('http://x/cb?error=access_denied&state=STATE_H'), {
      code: '',
      state: 'STATE_H',
      error: 'access_denied',
    });
  });

  it('promotes error_description to error when error is absent', () => {
    assert.deepEqual(parseCallbackUrl('http://x/cb?error_description=forbidden&state=S'), {
      code: '',
      state: 'S',
      error: 'forbidden',
    });
  });

  it('keeps error when both error and error_description are present', () => {
    assert.deepEqual(
      parseCallbackUrl('http://x/cb?error=access_denied&error_description=forbidden&state=S'),
      { code: '', state: 'S', error: 'access_denied' },
    );
  });

  it('omits the error key when there is no error', () => {
    const parsed = parseCallbackUrl('http://x/cb?code=C&state=S')!;
    assert.equal('error' in parsed, false);
  });

  it('trims whitespace around the input and around each value', () => {
    assert.deepEqual(parseCallbackUrl('  http://x/cb?code=%20C%20&state=%20S%20  '), {
      code: 'C',
      state: 'S',
    });
  });

  it('throws CallbackParseError for input with no URL shape at all', () => {
    assert.throws(() => parseCallbackUrl('not a url'), CallbackParseError);
  });

  it('throws CallbackParseError when the input is a URL but carries neither code nor error', () => {
    assert.throws(
      () => parseCallbackUrl('http://localhost:1455/auth/callback'),
      CallbackParseError,
    );
    assert.match(
      (() => {
        try {
          parseCallbackUrl('http://localhost:1455/auth/callback');
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : '';
        }
      })(),
      /missing code/,
    );
  });

  it('throws CallbackParseError for a syntactically invalid URL', () => {
    assert.throws(() => parseCallbackUrl('://nope'), CallbackParseError);
  });
});
```

- [ ] **Step 1b: 追加脱敏测试** —— 在现有 `packages/core/src/credentials/__tests__/oauth-loopback.test.ts` 里加一条用例（用该文件已有的 `startLoopbackListener` 用法，`port: 0` 让 OS 分配端口）：

```ts
// provider 的 error / error_description 原文要落进会话存储，再经 /status 回给 UI。
// 用户可能把整段 auth 响应粘进来，所以这里必须先脱敏 —— 和文件导入路径同一道防线。
// 纯原因值（access_denied）必须原样通过：UI 靠它匹配本地化文案。
it('masks a token inside the provider error before delivering it', async () => {
  const state = 'a'.repeat(43);
  const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
  try {
    const wait = listener.waitForCode();
    const response = await fetch(
      `${listener.redirectUri}?error=access_denied&error_description=refresh_token=SECRET&state=${state}`,
    );
    assert.equal(response.status, 200);

    const delivered = await wait;
    assert.equal(delivered.state, state);
    // error 优先于 error_description（对齐参考项目 misc/oauth.go:110-113）
    assert.equal(delivered.error, 'access_denied');
  } finally {
    listener.close();
  }
});

it('masks a token inside error_description when error is absent', async () => {
  const state = 'b'.repeat(43);
  const listener = await startLoopbackListener({ port: 0, path: '/auth/callback' });
  try {
    const wait = listener.waitForCode();
    await fetch(`${listener.redirectUri}?error_description=refresh_token=SECRET&state=${state}`);

    const delivered = await wait;
    assert.equal(delivered.error, 'refresh_token=[REDACTED]');
  } finally {
    listener.close();
  }
});
```

> 断言字符串已按 `packages/core/src/credentials/redact.ts` 实测钉死，不用再猜：第 18 行 `(refresh_token=)[^&\s"']+` 会把 `refresh_token=SECRET` 抹成 `refresh_token=[REDACTED]`；`SECRET` 只有 6 个字符，不会误触第 19 行的长 base64 规则（阈值 40）。第一条用例里 `error=access_denied` 不含任何凭据键，`redact` 原样通过 —— 这个性质不能破，UI 靠 `message.startsWith('access_denied')` 匹配本地化文案（`SubscriptionProviderDialog.tsx:48`）。

- [ ] **Step 2: 跑出 RED**

```
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/credentials/__tests__/parse-callback.test.ts src/credentials/__tests__/oauth-loopback.test.ts
```

Expected: `parse-callback.test.ts` 全部 FAIL（`Cannot find module '../oauth/parse-callback.js'`）；`oauth-loopback.test.ts` 新增 2 条 FAIL（第二条断言 `refresh_token=[REDACTED]` 不成立），其余通过。

- [ ] **Step 3: 实现解析器** `packages/core/src/credentials/oauth/parse-callback.ts`

关键决定（签名与测试已无法确定的部分）：

- **裸 `code#state` 走独立早分支**，且必须排在 URL 前缀化之前。参考项目 `misc/oauth.go:63-64` 会把含 `#` 的输入归入 `http://` 前缀分支，得到 `http://C#S`（host=`C`、fragment=`S`、query 空），随后 `:115` 因 `code==""` 返回 `callback URL missing code` —— **参考其实不支持这个形态**。本实现按已批准设计表格补上（严格超集），但注释要写明这一点。判定条件：不含 `://`、不含 `=`、不含 `/`、不含 `?`、不含 `:`，且含 `#`。
- **`#` 拆分**：`code` 已非空、`state` 为空、`code` 含 `#` 时拆（对齐 `misc/oauth.go:104-108`，`SplitN(code, "#", 2)` → `#` 后**全部**留给 state，含再出现的 `#`）。注意先取后半段再重赋值 `code`，否则下标会指错。
- **fragment 兜底**：只补**空**字段，不覆盖 query 已有的值（对齐 `:84-102`）。
- **`error_description` 提升**：`error` 为空且 `desc` 非空时 `error = desc`（对齐 `:110-113`）；提升后返回的 `error` 只可能是非空串。
- **JS 与 Go 的 `URL` 语义差异**：Go `url.Parse` 极其宽容，JS `new URL()` 对畸形输入会抛。这正是我们要的 —— 抛了就归一成 `invalid callback URL`。唯一行为差异是 query 里的非法百分号编码：Go 给 `ParseErrorValue`，JS 原样保留 `%ZZ`。对真实回跳 URL 无影响，不写特判。
- **返回类型复用 `CallbackQuery`**（`loopback.ts:31`），让解析结果可以直接喂给 `waiter(...)` / `store.fail(...)`，中间不 reshape。
- **脱敏不在解析器里做**：`parseCallbackUrl` 保持纯解析（单一职责，也便于在 UI 侧复用）。脱敏加在两个交付点 —— 本 Task 的 `loopback.ts:191`，Task 2 的 `callbackHandler`。

- [ ] **Step 4: 实现 loopback 脱敏** —— 把 `loopback.ts:191` 的

```ts
deliver({ code: '', state, error: providerError });
```

改为

```ts
deliver({ code: '', state, error: redact(providerError) });
```

`redact` 已从 `../redact.js` 导入（`loopback.ts:2`），无需新增 import。

- [ ] **Step 5: 跑出 GREEN**

```
pnpm --filter @freemodelfinder/core exec node --import tsx --test src/credentials/__tests__/parse-callback.test.ts src/credentials/__tests__/oauth-loopback.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: 导出 + 跑 core 全量**

在 `packages/core/src/index.ts` 的 oauth 导出组（紧跟 `pkce.js` 那一行）补：

```ts
export { CallbackParseError, parseCallbackUrl } from './credentials/oauth/parse-callback.js';
```

跑：

```
pnpm --filter @freemodelfinder/core test
```

Expected: `# fail 0`，总数比修复波次的 835 增加 19（解析器 17 + 脱敏 2）。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/credentials/oauth/parse-callback.ts packages/core/src/credentials/oauth/loopback.ts packages/core/src/index.ts packages/core/src/credentials/__tests__/parse-callback.test.ts packages/core/src/credentials/__tests__/oauth-loopback.test.ts
git commit -m "feat(core): add a lenient OAuth callback parser and mask provider errors"
```

---

## Task 2: server `readCallback` 换用解析器 + 路由契约扩充

**Files:**

- Modify: `packages/server/src/routes/subscription-oauth.ts:49-71`（`readCallback` 换实现，签名不变）、`:268-275`（error 过 `redact`）
- Test: `packages/server/src/routes/__tests__/subscription-oauth.test.ts`（新增 helper + 8 条用例）

**Interfaces:**

- Consumes: `parseCallbackUrl(input: string): CallbackQuery | null`（Task 1）
- Produces: `readCallback` 行为变更 —— 对 `redirect_url` 走宽容解析；`{code, state}` 直给形态**不变**；`error` / `error_description` 落库前先过 `redact`

- [ ] **Step 1: 写失败测试** —— 在 `subscription-oauth.test.ts` 现有的 `describe('subscription OAuth endpoints')` 内。

**先加 helper**，紧跟 `waitForStatus`（约 161 行）之后：

```ts
/** 装一个成功落账号的 exchangeCode stub，并让 exchangeCalls 计数。 */
function stubCodexExchange(accountId: string, email: string): void {
  SUBSCRIPTION_ADAPTERS.codex.exchangeCode = async () => {
    exchangeCalls += 1;
    return {
      payload: { accessToken: 'AT', refreshToken: 'RT', accountId, email },
      profile: { id: accountId, email },
    };
  };
}
```

**然后**在 `it('the callback endpoint rejects an unknown state without touching the token endpoint', ...)`（约 510 行）之后、`it('oauth/import behaves exactly like credentials import', ...)`（约 520 行）之前插入，与既有两条 callback 用例同一分组：

```ts
// 第三波：用户粘进来的内容形态远比"完整 URL"花哨。参考项目 misc/oauth.go:53-126
// 为这些形态准备了前缀补全，这里逐条断言服务端真的按它做。
it('completes the session from a bare query string pasted by the user', async () => {
  stubCodexExchange('oauth-codex-bareq', 'bareq@example.com');
  const { state } = await beginOAuth('codex');

  const response = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: { redirect_url: `?code=CODE_BAREQ&state=${state}` },
  });
  assert.equal(response.statusCode, 200, response.body);

  assert.equal((await waitForStatus(state, 'ok')).status, 'ok');
  assert.equal(exchangeCalls, 1);
});

it('completes the session from a bare path pasted by the user', async () => {
  stubCodexExchange('oauth-codex-path', 'path@example.com');
  const { state, redirectUri } = await beginOAuth('codex');

  // 用户可能只截到路径那一段（复制时把 http://localhost:1455 漏掉）
  const response = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: { redirect_url: `/auth/callback?code=CODE_PATH&state=${state}` },
  });
  assert.equal(response.statusCode, 200, response.body);

  assert.equal((await waitForStatus(state, 'ok')).status, 'ok');
  // 换 token 用的是监听器自己的 redirectUri，不是用户粘的残缺串
  assert.match(redirectUri, /^http:\/\/localhost:1455\/auth\/callback$/);
});

it('completes the session from a bare k=v string pasted by the user', async () => {
  stubCodexExchange('oauth-codex-kv', 'kv@example.com');
  const { state } = await beginOAuth('codex');

  const response = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: { redirect_url: `code=CODE_KV&state=${state}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await waitForStatus(state, 'ok')).status, 'ok');
});

it('completes a Claude session from the code#state form', async () => {
  SUBSCRIPTION_ADAPTERS.claude.exchangeCode = async () => {
    exchangeCalls += 1;
    return {
      payload: { accessToken: 'AT', refreshToken: 'RT', accountUuid: 'oauth-claude-hash' },
      profile: { id: 'oauth-claude-hash', email: 'hash@example.com' },
    };
  };
  const { state } = await beginOAuth('claude');

  const response = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: { redirect_url: `CODE_HASH#${state}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await waitForStatus(state, 'ok')).status, 'ok');
  assert.equal(exchangeCalls, 1);
});

it('records a provider denial submitted as a redirect_url carrying only error', async () => {
  const { state } = await beginOAuth('codex');

  const response = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: {
      redirect_url: `http://localhost:1455/auth/callback?error=access_denied&state=${state}`,
    },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'access_denied');

  const record = await waitForStatus(state, 'error');
  assert.equal(record.error, 'access_denied');
  assert.equal(exchangeCalls, 0, 'a denial must never reach the token endpoint');
  assert.equal((await getCredentialRuntime().getPool('codex')).accounts.length, 0);
});

it('redacts a token inside the submitted error before storing it', async () => {
  const { state } = await beginOAuth('codex');

  // 用户把整段 auth 响应粘进来，secret 落在 error_description 里
  const response = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: {
      redirect_url: `http://localhost:1455/auth/callback?error_description=refresh_token=SECRET&state=${state}`,
    },
  });
  assert.equal(response.statusCode, 400, response.body);

  const record = await waitForStatus(state, 'error');
  assert.equal(record.error, 'refresh_token=[REDACTED]');
  assert.ok(!record.error!.includes('SECRET'), 'the raw secret must never reach the session');
});

it('rejects a redirect_url with no code and no error without consuming the session', async () => {
  const { state } = await beginOAuth('codex');

  // 最常见的误粘：用户粘的是授权页地址，不含 code
  const response = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: { redirect_url: `https://auth.openai.com/oauth/authorize?state=${state}` },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'invalid redirect_url');

  // 关键：会话不能被打挂，用户改粘正确的串还能继续
  assert.equal((await statusOf(state)).status, 'wait');

  stubCodexExchange('oauth-codex-recover', 'recover@example.com');
  const retry = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: { code: 'CODE_RETRY', state },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal((await waitForStatus(state, 'ok')).status, 'ok');
});

it('rejects a redirect_url for a cancelled state and stores no account', async () => {
  stubCodexExchange('oauth-codex-canceled', 'canceled@example.com');
  const { state } = await beginOAuth('codex');

  const cancel = await app.inject({
    method: 'DELETE',
    url: `/api/subscription/oauth/session?state=${state}`,
    headers: localUiHeaders,
  });
  assert.equal(cancel.json().cancelled, true);

  const response = await app.inject({
    method: 'POST',
    url: '/api/subscription/oauth/callback',
    headers: { ...localUiHeaders, 'content-type': 'application/json' },
    payload: { redirect_url: `?code=CODE_CANCELED&state=${state}` },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'unknown or expired state');

  assert.equal(exchangeCalls, 0, 'a cancelled session must never reach the token endpoint');
  assert.equal((await getCredentialRuntime().getPool('codex')).accounts.length, 0);
});
```

- [ ] **Step 2: 跑出 RED**

跑前确认端口空闲（`node -e` 探 `1455/54545/51121`），然后：

```
pnpm --filter @freemodelfinder/server exec node --import tsx --test src/routes/__tests__/subscription-oauth.test.ts
```

Expected: 新增 8 条里，**裸 query / 裸 path / 裸 k=v / code#state / 仅 error 的 redirect_url / 脱敏** 这 6 条 FAIL（当前 `readCallback` 只认完整 URL，且 error 未脱敏）；「无 code 无 error 仍留 wait」与「已取消 state」2 条应通过（这两条是既有行为，做回归确认）。

- [ ] **Step 3: 实现** —— 把 `readCallback`（`subscription-oauth.ts:49-71`）整体替换为：

```ts
/**
 * 从查询/表单里取出 code + state。
 *
 * 除了直接给 `code`/`state`，也支持参考项目那条 `redirect_url` 路径：用户把浏览器地址栏
 * 里那条"打不开"的回跳整条粘进来，由服务端自己拆参数。
 *
 * `redirect_url` 用 `parseCallbackUrl` 做**宽容解析**（完整 URL / 裸 query / 裸 path /
 * 裸 k=v / 裸 code#state / fragment 兜底），而不是 `new URL()` 直接解析 —— 用户复制时
 * 漏掉 `http://localhost:1455` 前缀是常态，那种输入必须能救回来。
 *
 * 解析失败**不消耗会话**：只回 400，pending 会话继续等，用户改粘正确的串还能完成。
 */
function readCallback(input: CallbackInput): CallbackQuery & { invalidRedirect?: string } {
  let code = (input.code ?? '').trim();
  let state = (input.state ?? '').trim();
  let error = (input.error ?? input.error_description ?? '').trim();
  const redirect = (input.redirect_url ?? '').trim();
  if (redirect) {
    let parsed: CallbackQuery | null;
    try {
      parsed = parseCallbackUrl(redirect);
    } catch {
      return { code, state, error: '', invalidRedirect: 'invalid redirect_url' };
    }
    if (parsed) {
      if (!code) code = parsed.code;
      if (!state) state = parsed.state;
      if (!error && parsed.error) error = parsed.error;
    }
  }
  return error ? { code, state, error } : { code, state };
}
```

import 里补 `parseCallbackUrl`（加到 `@freemodelfinder/core` 的 import 块，按字母序落在 `normalizeOAuthFailure` 与 `normalizeSubscriptionProvider` 之间）。

**语义决定（测试无法完全钉死）**：直给字段优先于解析结果 —— 如果 `code`/`state`/`error` 已经有值（显式传入），**不**用 `redirect_url` 里的值覆盖。这样 `{code, state, redirect_url}` 同时给也不会歧义。

**然后把 `callbackHandler`（约 268-275 行）的 error 分支改为：**

```ts
if (error) {
  // 把失败原因交给 finishSession 统一收尾（它会自己关监听）。
  // 这里若先 store.fail 再 close 监听，abort 会把原因覆盖成
  // "OAuth callback listener closed" —— 用户看到的就不是"你拒绝了授权"。
  // error 可能来自用户粘贴的内容，落库前必须脱敏（与 loopback 路径同一道防线）。
  const masked = redact(error);
  waiters.delete(state);
  waiter({ code: '', state, error: masked });
  return { ok: false, error: masked };
}
```

`redact` 已在 `subscription-oauth.ts:12` 导入。

**不要改** `callbackHandler` 其余部分：`isValidState(state)` / `waiters.get(state)` / `store.isPending(state)` 三道检查是 N3 修复后加的安全边界，解析器只负责"把字串拆成字段"。

- [ ] **Step 4: 跑出 GREEN**

```
pnpm --filter @freemodelfinder/server exec node --import tsx --test src/routes/__tests__/subscription-oauth.test.ts
```

Expected: 全部 PASS，总数比修复波次的 428 增加 8。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/subscription-oauth.ts packages/server/src/routes/__tests__/subscription-oauth.test.ts
git commit -m "feat(server): parse pasted OAuth callbacks leniently and mask their errors"
```

---

## Task 3: UI 弹窗新增「手动回调」区块

**Files:**

- Modify: `packages/ui/app/components/SubscriptionProviderDialog.tsx`（`waiting` 分支内新增一块）
- Modify: `packages/ui/app/i18n.tsx`（zh 块约 681 行、en 块约 1442 行，各加 5 个 key）
- Test: `packages/ui/app/components/__tests__/subscription-panel.test.tsx`（新增 describe + 4 条用例；`SUBSCRIPTION_KEYS` 数组补 5 个 key）

**Interfaces:**

- Consumes: 既有端点 `POST /api/subscription/oauth/callback`（Task 2 已支持宽容形态）；`describeOAuthError` / `redactSecrets`（组件内已有）；`pendingStateRef.current`（`waiting` 阶段必然非空）
- Produces: 两个 `data-testid` —— `subscription-callback-url-<provider>`（输入框）、`subscription-callback-submit-<provider>`（提交按钮）

- [ ] **Step 1: 写失败测试** —— 在 `subscription-panel.test.tsx` 新增一个 `describe`，紧跟现有 `describe('SubscriptionProviderDialog OAuth flow', ...)` 之后。

**注意**：文件里**没有** `callbackUrl` 这个常量（只有 `credentialsUrl` / `authUrl` / `statusUrl` / `sessionUrl` / `switchProjectUrl`，第 9-13 行）。在 `const sessionUrl = ...` 之后补：

```ts
const callbackUrl = `${gateway}/api/subscription/oauth/callback`;
```

handler 注册方式与既有 OAuth flow 那组一致：`vitest.setup.ts` 的 `afterEach` 里有 `server.resetHandlers()`，所以**每个用例都从零开始**，必须自己 `server.use(...)` 全部需要的 handler；`onUnhandledRequest: 'error'`，漏注册一个 handler 就直接报错。

```tsx
describe('SubscriptionProviderDialog manual callback', () => {
  // 复用 OAuth flow 那组的前置：auth-url 成功进入 waiting
  const pendingHandlers = [
    http.get(authUrl, () => HttpResponse.json({ status: 'ok', url: 'https://x/y', state })),
    http.get(statusUrl, () => HttpResponse.json({ status: 'wait' })),
  ];

  it('renders a callback url field and a submit button while waiting', async () => {
    vi.stubGlobal('open', vi.fn());
    server.use(...pendingHandlers);
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'codex');
    await user.click(screen.getByTestId('subscription-start-codex'));
    await screen.findByText(/等待授权中/);

    expect(screen.getByTestId('subscription-callback-url-codex')).toBeTruthy();
    expect(screen.getByTestId('subscription-callback-submit-codex')).toBeTruthy();
    // 设计 §4：提示必须逐家准确。端口与回调路径不同，不能写死 Codex 的 ——
    // 断言值来自 SUBSCRIPTION_PROVIDER_META，三家共用同一个计算（endpoint 变量）。
    expect(
      screen.getByTestId('subscription-callback-url-codex').getAttribute('placeholder'),
    ).toContain('localhost:1455/auth/callback');
    // 空值要禁用，避免打一次空请求
    expect(screen.getByTestId('subscription-callback-submit-codex')).toBeDisabled();
  });

  it('posts the pasted url with the session state and keeps polling on success', async () => {
    vi.stubGlobal('open', vi.fn());
    const seen: Array<Record<string, string>> = [];
    server.use(
      ...pendingHandlers,
      http.post(callbackUrl, async ({ request }) => {
        seen.push((await request.json().catch(() => ({}))) as Record<string, string>);
        return new HttpResponse('授权完成', { headers: { 'content-type': 'text/html' } });
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'codex');
    await user.click(screen.getByTestId('subscription-start-codex'));
    await screen.findByText(/等待授权中/);

    await user.type(
      screen.getByTestId('subscription-callback-url-codex'),
      'http://localhost:1455/auth/callback?code=C1',
    );
    await user.click(screen.getByTestId('subscription-callback-submit-codex'));

    // state 必须是 UI 手里那份（auth-url 返回的），不是从粘进来的 URL 里抠的
    expect(seen).toEqual([{ redirect_url: 'http://localhost:1455/auth/callback?code=C1', state }]);
    // 成功 = 留在 waiting 继续轮询（会话由 /status 报 ok 才真正结束）；
    // 服务端回的是 HTML，组件绝不能 response.json()
    expect(screen.getByText(/等待授权中/)).toBeTruthy();
    expect(screen.getByTestId('subscription-callback-url-codex')).toBeTruthy();
  });

  it('shows the error and stays in waiting so the user can paste again', async () => {
    vi.stubGlobal('open', vi.fn());
    const seen: Array<Record<string, string>> = [];
    server.use(
      ...pendingHandlers,
      http.post(callbackUrl, async ({ request }) => {
        seen.push((await request.json().catch(() => ({}))) as Record<string, string>);
        return HttpResponse.json(
          { status: 'error', error: 'unknown or expired state' },
          { status: 400 },
        );
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'codex');
    await user.click(screen.getByTestId('subscription-start-codex'));
    await screen.findByText(/等待授权中/);

    await user.type(screen.getByTestId('subscription-callback-url-codex'), 'garbage');
    await user.click(screen.getByTestId('subscription-callback-submit-codex'));

    expect(await screen.findByText(/登录失败/)).toBeTruthy();
    // 会话不退出：用户改粘正确的串还能重试
    expect(screen.getByText(/等待授权中/)).toBeTruthy();
    expect(screen.getByTestId('subscription-callback-submit-codex')).toBeTruthy();

    // 第二次提交必须真的发出去
    server.use(
      ...pendingHandlers,
      http.post(callbackUrl, async ({ request }) => {
        seen.push((await request.json().catch(() => ({}))) as Record<string, string>);
        return new HttpResponse('ok', { headers: { 'content-type': 'text/html' } });
      }),
    );
    await user.clear(screen.getByTestId('subscription-callback-url-codex'));
    await user.type(
      screen.getByTestId('subscription-callback-url-codex'),
      `code=CODE2&state=${state}`,
    );
    await user.click(screen.getByTestId('subscription-callback-submit-codex'));
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ redirect_url: `code=CODE2&state=${state}`, state });
  });

  it('hides the manual callback block once the session is cancelled', async () => {
    vi.stubGlobal('open', vi.fn());
    server.use(
      ...pendingHandlers,
      http.delete(sessionUrl, () => HttpResponse.json({ status: 'ok', cancelled: true })),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'codex');
    await user.click(screen.getByTestId('subscription-start-codex'));
    expect(await screen.findByTestId('subscription-callback-url-codex')).toBeTruthy();

    await user.click(screen.getByTestId('subscription-cancel-codex'));
    await waitFor(() => expect(screen.queryByTestId('subscription-callback-url-codex')).toBeNull());
  });
});
```

> 注意 `seen` 是**每个用例各自声明**的局部数组，两个 `server.use(...)` 调用共用同一个 `seen`，所以第二次注册不会清空计数。

`SUBSCRIPTION_KEYS` 数组（约 659 行那个 `describe('subscription i18n keys')`）补 5 个新 key：

```ts
    'settings.subscription.dialog.login.callback.heading',
    'settings.subscription.dialog.login.callback.hint',
    'settings.subscription.dialog.login.callback.placeholder',
    'settings.subscription.dialog.login.callback.submit',
    'settings.subscription.dialog.login.callback.tunnel',
```

- [ ] **Step 2: 跑出 RED**

```
pnpm --filter @freemodelfinder/ui test -- --run subscription-panel
```

Expected: 新增 4 条 FAIL（`getByTestId('subscription-callback-url-codex')` 找不到），`SUBSCRIPTION_KEYS` 断言也 FAIL（zh/en 缺 key）。

- [ ] **Step 3: 实现 i18n** —— `packages/ui/app/i18n.tsx`，zh 块紧跟 `'settings.subscription.dialog.login.ok'` 之后（约 681 行），en 块同样位置（约 1442 行）。**两边必须成对出现**（`i18n.test.tsx:48` 有全量 `expect(zhKeys).toEqual(enKeys)`）。

`placeholder` 带 `{endpoint}` 参数，复用组件里已有的 `endpoint`（`SubscriptionProviderDialog.tsx:82`，逐家不同）—— 这是设计 §4「面板提示必须逐家准确」的落实方式。

zh：

```ts
  'settings.subscription.dialog.login.callback.heading': '或手动粘贴回调地址',
  'settings.subscription.dialog.login.callback.hint':
    '远程部署时浏览器与网关不同机，授权后会跳回 http://{endpoint} 并显示「无法连接」。把浏览器地址栏里那条带 code= 的完整 URL（或授权码）粘贴到这里。',
  'settings.subscription.dialog.login.callback.placeholder':
    '粘贴回跳 URL，例如 http://{endpoint}?code=…',
  'settings.subscription.dialog.login.callback.submit': '提交回调',
  'settings.subscription.dialog.login.callback.tunnel':
    '不想手动粘贴：在自己的电脑上建一条隧道，回调会自动送达，登录后关闭隧道即可。',
```

en（同 5 个 key）：

```ts
  'settings.subscription.dialog.login.callback.heading': 'Or paste the callback address manually',
  'settings.subscription.dialog.login.callback.hint':
    'With a remote deployment the browser and the gateway are on different machines, so the callback redirects to http://{endpoint} on your own machine and shows "Cannot connect". Paste the full URL from your browser address bar (the one containing code=), or the authorization code itself.',
  'settings.subscription.dialog.login.callback.placeholder': 'Paste the callback URL, e.g. http://{endpoint}?code=…',
  'settings.subscription.dialog.login.callback.submit': 'Submit callback',
  'settings.subscription.dialog.login.callback.tunnel':
    'Prefer not to paste manually: open a tunnel from your own machine and the callback arrives automatically. Close the tunnel once sign-in is done.',
```

`tunnel` 这条 key 用于 `<details>` 内 `<pre>` 前的说明句；`ssh -L` 命令本身是**硬编码字符串**，不走 i18n（命令文本不该被翻译）：

```
ssh -L 1455:127.0.0.1:1455 -L 54545:127.0.0.1:54545 -L 51121:127.0.0.1:51121 <user>@<server>
```

- [ ] **Step 4: 实现组件** —— `SubscriptionProviderDialog.tsx`

1. 顶部补 URL 常量（放在 `sessionUrl` 之后）：

```ts
const callbackUrl = `${GATEWAY}/api/subscription/oauth/callback`;
```

2. 新增三个 state：`callbackInput`（输入框值）、`callbackBusy`（提交中）、`callbackError`（提交失败原因，走 `describeOAuthError`）。
3. 新增 `submitCallback()`：`callbackBusy` 置位 → `POST callbackUrl`，body `{ redirect_url: callbackInput.trim(), state: pendingStateRef.current }` → **先看 `response.ok`**：成功（`200 text/html`）时**不要** `response.json()`，清掉 `callbackInput`、`callbackError`，并立刻补一次 `poll(pendingStateRef.current)`；失败时 `describeOAuthError(data?.error ?? '')` 写入 `callbackError`，**保持 `waiting`**、**保留** `callbackInput` 值（方便改一个字符重贴）。
4. `waiting` 分支（现 298-325 行）内，取消按钮之后新增区块：`<h5>` 标题、`<p>` 提示（`t(...hint, { endpoint })`）、`<input type="text" data-testid={\`subscription-callback-url-${provider}\`} placeholder={t(...placeholder, { endpoint })} disabled={callbackBusy}>`、提交按钮 `<button data-testid={\`subscription-callback-submit-${provider}\`} disabled={callbackBusy || !callbackInput.trim()}>`、`callbackError`用`t('settings.subscription.dialog.error', { err: callbackError })` 渲染、`<details>` 折叠隧道命令（`<pre className="overflow-x-auto font-mono text-[11px]">`）。
5. `cancelOAuth()` 里一并清空 `callbackInput` / `callbackError`。
6. `startOAuth()` 里也清空 `callbackInput` / `callbackError`（重新发起要从空开始）。

**关键约束**：区块只在 `phase === 'waiting'` 渲染。`waiting` 只在 `auth-url` 成功、`pendingStateRef.current` 已写入之后进入，所以提交时 state 必然在手（设计 §3.4）；测试断言的 payload 里 `state` 必须等于 UI 持有的那份，不是从 URL 抠的。

- [ ] **Step 5: 跑出 GREEN**

```
pnpm --filter @freemodelfinder/ui test -- --run
```

Expected: 全部 PASS，`Tests` 比修复波次的 298 增加 4。

- [ ] **Step 6: Commit**

```bash
git add packages/ui/app/components/SubscriptionProviderDialog.tsx packages/ui/app/i18n.tsx packages/ui/app/components/__tests__/subscription-panel.test.tsx
git commit -m "feat(ui): add a manual callback field to the subscription login dialog"
```

---

## 收尾门禁（三 Task 全部完成后，串行）

```
pnpm format:check
pnpm lint
pnpm build:runtime
pnpm typecheck
pnpm test:coverage
```

期望：全部退出码 0；测试总数 core 854 / server 436 / ui 302；覆盖率不降。

## 验收（写进最终交付说明，不含糊）

- 全部单测 / 契约测试绿，覆盖率不降。
- **真实端到端**：若本机网络/地域允许三家之一（第二波已实测：Codex 地域受限、Claude 403、Google 本机连不通），则用浏览器 + 粘贴走通一次并把结论写进 `.superpowers/sdd/2026-10-16-subscription-oauth-login/progress.md`。
- 若仍不允许：**如实记录「未完成真实账号端到端」**，并说明已验证到的最远环节（code 被正确取出并送达 `exchangeCode`，由 Task 2 的契约测试证明）。
- 提醒用户：本地领先远端，是否推送由用户决定。
