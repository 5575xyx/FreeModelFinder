import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionAccountsPanel } from '../SubscriptionAccountsPanel';
import { gateway, server } from '../../../test/server';
import { I18nProvider, en, zh } from '../../i18n';

const credentialsUrl = `${gateway}/api/subscription/credentials`;
const authUrl = `${gateway}/api/subscription/oauth/auth-url`;
const statusUrl = `${gateway}/api/subscription/oauth/status`;
const sessionUrl = `${gateway}/api/subscription/oauth/session`;
const switchProjectUrl = `${gateway}/api/subscription/quota-exceeded/switch-project`;

const state = 'a'.repeat(43);

function accountUrl(provider: string, id: string): string {
  return `${credentialsUrl}?provider=${provider}&id=${id}`;
}

function refreshUrl(): string {
  return `${credentialsUrl}/refresh`;
}

const codexAccount = {
  provider: 'codex',
  id: 'acc-codex',
  label: 'ada@example.com',
  email: 'ada@example.com',
  plan: 'pro',
  status: 'active',
  addedAt: 1_700_000_000_000,
};

const invalidAccount = {
  provider: 'codex',
  id: 'acc-stale',
  label: 'stale@example.com',
  email: 'stale@example.com',
  status: 'invalid',
  addedAt: 1_699_999_000_000,
};

/** 打开某家的弹窗：每家一个独立弹窗，所以这里必须指定 provider。 */
async function openDialog(
  user: ReturnType<typeof userEvent.setup>,
  provider: 'codex' | 'claude' | 'google',
): Promise<HTMLElement> {
  await user.click(screen.getByTestId(`subscription-connect-${provider}`));
  return await screen.findByRole('dialog');
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem('fmf-language');
});

describe('SubscriptionAccountsPanel tiles', () => {
  it('renders one tile per provider with an add button and no shared paste box', async () => {
    render(<SubscriptionAccountsPanel />);

    for (const provider of ['codex', 'claude', 'google'] as const) {
      const tile = screen.getByTestId(`subscription-tile-${provider}`);
      expect(within(tile).getByTestId(`subscription-connect-${provider}`).textContent).toContain(
        '连接账号',
      );
    }
    // 共用粘贴框已移除：凭据只在各家的弹窗里进
    expect(screen.queryByLabelText('或粘贴凭据内容')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the per-provider connection count on each tile', async () => {
    server.use(http.get(credentialsUrl, () => HttpResponse.json({ accounts: [codexAccount] })));
    render(<SubscriptionAccountsPanel />);

    const codexTile = await screen.findByTestId('subscription-tile-codex');
    await waitFor(() => expect(codexTile.textContent).toContain('已连接 1 个账号'));
    expect(screen.getByTestId('subscription-tile-claude').textContent).toContain('未连接');
  });

  it('opens exactly one dialog and closes it again', async () => {
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'claude');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog').textContent).toContain('Claude 订阅账号');

    await user.click(screen.getByTestId('subscription-close-claude'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SubscriptionProviderDialog per-provider differences', () => {
  it('opens the Codex dialog with its own port, mechanism badge and auto-read fields', async () => {
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const dialog = await openDialog(user, 'codex');
    expect(dialog.textContent).toContain('Codex 订阅账号');
    // 授权机制：Codex 走 PKCE S256
    expect(dialog.textContent).toContain('OAuth + PKCE S256');
    // 本机回调端口是逐家的（参考项目三家各不相同）
    expect(dialog.textContent).toContain('localhost:1455/auth/callback');
    // 登录后自动读取的字段：邮箱 / 套餐 / 账号 ID
    expect(dialog.textContent).toContain('邮箱');
    expect(dialog.textContent).toContain('套餐');
    expect(dialog.textContent).toContain('账号 ID');
    expect(dialog.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('opens the Claude dialog with the organization field and the 54545 callback', async () => {
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const dialog = await openDialog(user, 'claude');
    expect(dialog.textContent).toContain('Claude 订阅账号');
    expect(dialog.textContent).toContain('localhost:54545/callback');
    expect(dialog.textContent).toContain('组织');
    expect(dialog.textContent).toContain('账号 UUID');
    // 这三家的字段集合必须真的不同 —— Claude 不该出现 Codex 的套餐
    expect(dialog.textContent).not.toContain('套餐');
  });

  it('opens the Google dialog with the GCP project field and no PKCE', async () => {
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const dialog = await openDialog(user, 'google');
    expect(dialog.textContent).toContain('Gemini 订阅账号');
    expect(dialog.textContent).toContain('localhost:51121/oauth-callback');
    expect(dialog.textContent).toContain('GCP 项目');
    expect(dialog.textContent).toContain('OAuth（无 PKCE）');
    expect(dialog.textContent).not.toContain('PKCE S256');
  });
});

describe('SubscriptionProviderDialog OAuth flow', () => {
  it('opens the browser with the returned url and polls until the provider reports ok', async () => {
    // window.open 必须在点击的同一个 tick 里被调用（否则会被弹窗拦截器拦掉），
    // 拿到 URL 之后再写它的 location。
    const fakeWindow = { location: { href: '' }, close: vi.fn() };
    const openSpy = vi.fn(() => fakeWindow);
    vi.stubGlobal('open', openSpy);
    const polled: string[] = [];
    server.use(
      http.get(authUrl, ({ request }) => {
        const provider = new URL(request.url).searchParams.get('provider');
        return HttpResponse.json({
          status: 'ok',
          url: `https://auth.example.com/${provider}?state=${state}`,
          state,
        });
      }),
      http.get(statusUrl, ({ request }) => {
        polled.push(new URL(request.url).searchParams.get('state') ?? '');
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel onChanged={onChanged} />);

    await openDialog(user, 'codex');
    await user.click(screen.getByTestId('subscription-start-codex'));

    const expectedUrl = `https://auth.example.com/codex?state=${state}`;
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('', '_blank'));
    await waitFor(() => expect(fakeWindow.location.href).toBe(expectedUrl));
    await waitFor(() => expect(polled).toEqual([state]));
    expect(await screen.findByText('授权成功，账号已添加')).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('keeps polling while the session is pending, then stops once it is ok', async () => {
    vi.stubGlobal('open', vi.fn());
    let polls = 0;
    server.use(
      http.get(authUrl, () => HttpResponse.json({ status: 'ok', url: 'https://x/y', state })),
      http.get(statusUrl, () => {
        polls += 1;
        return HttpResponse.json({ status: polls < 2 ? 'wait' : 'ok' });
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'google');
    await user.click(screen.getByTestId('subscription-start-google'));

    expect(await screen.findByText(/等待授权中/)).toBeTruthy();
    // 弹窗被拦下来时用户还有一条路：等待行里的链接指向同一个地址
    expect(screen.getByTestId('subscription-reopen-google').getAttribute('href')).toBe(
      'https://x/y',
    );
    expect(await screen.findByText('授权成功，账号已添加', {}, { timeout: 8000 })).toBeTruthy();
    expect(polls).toBe(2);

    // ok 之后必须停表：再等一个轮询周期，不应再有新的状态查询
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(polls).toBe(2);
  });

  it('cancels the pending session with DELETE and returns to idle', async () => {
    vi.stubGlobal('open', vi.fn());
    const deleted: string[] = [];
    let polls = 0;
    server.use(
      http.get(authUrl, () => HttpResponse.json({ status: 'ok', url: 'https://x/y', state })),
      http.get(statusUrl, () => {
        polls += 1;
        return HttpResponse.json({ status: 'wait' });
      }),
      http.delete(sessionUrl, ({ request }) => {
        deleted.push(new URL(request.url).searchParams.get('state') ?? '');
        return HttpResponse.json({ status: 'ok', cancelled: true });
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'claude');
    await user.click(screen.getByTestId('subscription-start-claude'));
    expect(await screen.findByText(/等待授权中/)).toBeTruthy();

    await user.click(screen.getByTestId('subscription-cancel-claude'));
    await waitFor(() => expect(deleted).toEqual([state]));
    await waitFor(() => expect(screen.queryByText(/等待授权中/)).toBeNull());

    // 取消后必须停表，否则会一直打状态接口
    const after = polls;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(polls).toBe(after);
  });

  it('renders a localized timeout error from the status endpoint', async () => {
    vi.stubGlobal('open', vi.fn());
    server.use(
      http.get(authUrl, () => HttpResponse.json({ status: 'ok', url: 'https://x/y', state })),
      http.get(statusUrl, () => HttpResponse.json({ status: 'error', error: 'timeout' })),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'codex');
    await user.click(screen.getByTestId('subscription-start-codex'));

    expect(await screen.findByText(/授权超时/)).toBeTruthy();
    expect(screen.queryByText(/等待授权中/)).toBeNull();
  });

  // 用户在授权页点了「拒绝」：服务端把 provider 回的 access_denied 原样带回来，
  // UI 不该把这种明确的用户操作显示成一句英文报错。
  it('renders a localized denial when the provider reports access_denied', async () => {
    vi.stubGlobal('open', vi.fn());
    server.use(
      http.get(authUrl, () => HttpResponse.json({ status: 'ok', url: 'https://x/y', state })),
      http.get(statusUrl, () => HttpResponse.json({ status: 'error', error: 'access_denied' })),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'google');
    await user.click(screen.getByTestId('subscription-start-google'));

    expect(await screen.findByText(/授权被拒绝/)).toBeTruthy();
  });

  it('turns a busy callback port into a provider-scoped, actionable error', async () => {
    vi.stubGlobal('open', vi.fn());
    server.use(
      http.get(authUrl, () =>
        HttpResponse.json(
          {
            status: 'error',
            error:
              'port 1455 is already in use; close whatever is listening on it (usually the official CLI) and retry',
          },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'codex');
    await user.click(screen.getByTestId('subscription-start-codex'));

    const error = await screen.findByText(/登录失败/);
    expect(error.textContent).toContain('1455');
    expect(error.textContent).toContain('端口');
    expect(screen.getByRole('dialog').textContent).toContain('1455');
  });

  it('surfaces an unknown provider failure without leaking the payload', async () => {
    vi.stubGlobal('open', vi.fn());
    server.use(
      http.get(authUrl, () =>
        HttpResponse.json({ status: 'error', error: 'provider_not_found' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'claude');
    await user.click(screen.getByTestId('subscription-start-claude'));

    expect(await screen.findByText(/provider_not_found/)).toBeTruthy();
  });
});

describe('SubscriptionProviderDialog file import', () => {
  it('posts the selected file content to the credentials route with the provider', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const providers: Array<string | null> = [];
    let imported = false;
    server.use(
      http.get(credentialsUrl, () =>
        HttpResponse.json({ accounts: imported ? [codexAccount] : [] }),
      ),
      http.post(credentialsUrl, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        providers.push(new URL(request.url).searchParams.get('provider'));
        imported = true;
        return HttpResponse.json({
          ok: true,
          account: { provider: 'codex', id: 'acc-codex', email: 'ada@example.com' },
        });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel onChanged={onChanged} />);

    const dialog = await openDialog(user, 'codex');
    const file = new File(['{"tokens":{"access_token":"AT_SECRET"}}'], 'auth.json', {
      type: 'application/json',
    });
    await user.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, file);

    await waitFor(() =>
      expect(bodies).toEqual([{ raw: '{"tokens":{"access_token":"AT_SECRET"}}' }]),
    );
    expect(providers).toEqual(['codex']);
    expect(await screen.findByText(/已导入 ada@example.com/)).toBeTruthy();
    // 导入成功后面板自己的列表也要立刻反映出来
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
  });

  it('imports through the auto-detected default path of that provider', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const providers: Array<string | null> = [];
    server.use(
      http.post(credentialsUrl, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        providers.push(new URL(request.url).searchParams.get('provider'));
        return HttpResponse.json({ ok: true, account: { provider: 'google', id: 'acc-g' } });
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await openDialog(user, 'google');
    await user.click(screen.getByTestId('subscription-detect-google'));

    await waitFor(() => expect(bodies).toEqual([{ path: '~/.gemini/oauth_creds.json' }]));
    expect(providers).toEqual(['google']);
  });

  it('shows an import failure inside the dialog and stays usable', async () => {
    server.use(
      http.post(credentialsUrl, () =>
        HttpResponse.json({ error: 'invalid credential file' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const dialog = await openDialog(user, 'google');
    const file = new File(['nope'], 'oauth_creds.json', { type: 'application/json' });
    await user.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, file);

    expect(await screen.findByText(/导入失败：invalid credential file/)).toBeTruthy();
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });

  it('never pastes a secret into the DOM when the import response echoes one back', async () => {
    server.use(
      http.post(credentialsUrl, () =>
        HttpResponse.json({ error: 'bad refresh_token=rt-secret-abcdef123456' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const dialog = await openDialog(user, 'codex');
    const file = new File(['x'], 'auth.json', { type: 'application/json' });
    await user.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, file);

    const message = await screen.findByText(/导入失败/);
    expect(message.textContent).not.toContain('rt-secret-abcdef123456');
  });
});

describe('SubscriptionProviderDialog isolation', () => {
  // 三家弹窗必须"不串味"：Claude 的弹窗只能发 claude 的请求。
  it("never issues another provider's requests from one dialog", async () => {
    vi.stubGlobal('open', vi.fn());
    const seen: string[] = [];
    server.use(
      http.get(authUrl, ({ request }) => {
        seen.push(`auth-url:${new URL(request.url).searchParams.get('provider')}`);
        return HttpResponse.json({ status: 'ok', url: 'https://x/y', state });
      }),
      http.get(statusUrl, () => {
        seen.push('status');
        return HttpResponse.json({ status: 'ok' });
      }),
      http.post(credentialsUrl, async ({ request }) => {
        seen.push(`import:${new URL(request.url).searchParams.get('provider')}`);
        return HttpResponse.json({ ok: true, account: { provider: 'claude', id: 'acc-c' } });
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const dialog = await openDialog(user, 'claude');
    await user.click(screen.getByTestId('subscription-start-claude'));
    await screen.findByText('授权成功，账号已添加');
    const file = new File(['x'], 'creds.json', { type: 'application/json' });
    await user.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, file);

    await waitFor(() => expect(seen).toEqual(['auth-url:claude', 'status', 'import:claude']));
    expect(screen.queryByTestId('subscription-start-codex')).toBeNull();
    expect(screen.queryByTestId('subscription-start-google')).toBeNull();
  });
});

describe('SubscriptionAccountsPanel quota-exceeded switch-project', () => {
  it('reads the stored value and PUTs the new one through the switch', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get(switchProjectUrl, () => HttpResponse.json({ 'switch-project': false })),
      http.put(switchProjectUrl, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return HttpResponse.json({ 'switch-project': body['switch-project'] });
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const toggle = (await screen.findByRole('switch', {
      name: '额度超限时自动切换 GCP 项目',
    })) as HTMLInputElement;
    // 初值来自服务端，不能假定 false
    await waitFor(() => expect(toggle.checked).toBe(false));

    await user.click(toggle);
    await waitFor(() => expect(bodies).toEqual([{ 'switch-project': true }]));
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it('reflects an already-enabled server value on mount', async () => {
    server.use(http.get(switchProjectUrl, () => HttpResponse.json({ 'switch-project': true })));
    render(<SubscriptionAccountsPanel />);

    const toggle = (await screen.findByRole('switch', {
      name: '额度超限时自动切换 GCP 项目',
    })) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it('rolls the switch back and reports when the PUT fails', async () => {
    server.use(
      http.get(switchProjectUrl, () => HttpResponse.json({ 'switch-project': false })),
      http.put(switchProjectUrl, () =>
        HttpResponse.json({ error: 'invalid body' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const toggle = (await screen.findByRole('switch', {
      name: '额度超限时自动切换 GCP 项目',
    })) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(false));

    await user.click(toggle);

    expect(await screen.findByText(/invalid body/)).toBeTruthy();
    await waitFor(() => expect(toggle.checked).toBe(false));
  });
});

describe('subscription copy', () => {
  // 语言由 I18nProvider 在 effect 里落地，所以这里只等本地化文本出现，不假定首帧。
  it.each(['zh', 'en'] as const)('renders the panel and a dialog in %s', async (language) => {
    window.localStorage.setItem('fmf-language', language);
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <SubscriptionAccountsPanel />
      </I18nProvider>,
    );

    const expectedTitle = language === 'zh' ? 'Codex 订阅账号' : 'Codex subscription account';
    await user.click(await screen.findByTestId('subscription-connect-codex'));
    expect(await screen.findByText(expectedTitle)).toBeTruthy();

    // 缺翻译时会直接渲染原始 key —— 这里就是那道闸门
    expect(document.body.textContent ?? '').not.toContain('settings.subscription.');
  });
});

describe('SubscriptionAccountsPanel account list', () => {
  it('renders active and invalid badges from the account list', async () => {
    server.use(
      http.get(credentialsUrl, () =>
        HttpResponse.json({ accounts: [codexAccount, invalidAccount] }),
      ),
    );
    render(<SubscriptionAccountsPanel />);

    const activeRow = (await screen.findByText('ada@example.com')).closest('li');
    expect(activeRow).not.toBeNull();
    expect(activeRow!.textContent).toContain('codex');
    expect(activeRow!.textContent).toContain('可用');

    const invalidRow = screen.getByText('stale@example.com').closest('li');
    expect(invalidRow).not.toBeNull();
    expect(invalidRow!.textContent).toContain('需重新登录');
  });

  it('reports a failed account list without dropping the tiles', async () => {
    server.use(
      http.get(credentialsUrl, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );
    render(<SubscriptionAccountsPanel />);

    expect(await screen.findByText(/账号列表加载失败/)).toBeTruthy();
    expect(screen.getByTestId('subscription-tile-codex')).toBeTruthy();
  });

  it('renders the plan, expiry and usage numbers on an account card', async () => {
    server.use(
      http.get(credentialsUrl, () =>
        HttpResponse.json({
          accounts: [
            {
              ...codexAccount,
              expiresAt: '2027-01-02T03:04:05.000Z',
              usage: { requests: 1234, promptTokens: 56_789, completionTokens: 1_011 },
            },
          ],
        }),
      ),
    );
    render(<SubscriptionAccountsPanel />);

    const row = (await screen.findByText('ada@example.com')).closest('li');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('pro');
    expect(row!.textContent).toContain('1,234');
    expect(row!.textContent).toContain('56,789');
    expect(row!.textContent).toContain('1,011');
    // 过期时间必须以本地可读格式出现，而不是裸 ISO 串
    expect(row!.textContent).toContain(new Date('2027-01-02T03:04:05.000Z').toLocaleString());
  });

  it('tells the user to re-import an invalid account', async () => {
    server.use(http.get(credentialsUrl, () => HttpResponse.json({ accounts: [invalidAccount] })));
    render(<SubscriptionAccountsPanel />);

    const row = (await screen.findByText('stale@example.com')).closest('li');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('需重新登录');
    expect(row!.textContent).toContain('请重新导入凭据');
  });

  it('removes an account only after confirmation, then reloads the list', async () => {
    const deletions: string[] = [];
    let removed = false;
    server.use(
      http.get(credentialsUrl, () =>
        HttpResponse.json({ accounts: removed ? [] : [codexAccount] }),
      ),
      http.delete(accountUrl('codex', 'acc-codex'), () => {
        deletions.push('codex:acc-codex');
        removed = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel onChanged={onChanged} />);

    const row = (await screen.findByText('ada@example.com')).closest('li')!;
    const removeButton = () =>
      row.querySelector('button[data-testid="subscription-remove-acc-codex"]') as HTMLButtonElement;

    // 第一次点击只进入确认态，不发请求
    await user.click(removeButton());
    expect(deletions).toEqual([]);
    expect(removeButton().textContent).toContain('确认移除');

    // 第二次点击才真的 DELETE
    await user.click(removeButton());
    await waitFor(() => expect(deletions).toEqual(['codex:acc-codex']));
    await waitFor(() => expect(screen.queryByText('ada@example.com')).toBeNull());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('refreshes an account on demand and reports success', async () => {
    let refreshed = 0;
    server.use(
      http.get(credentialsUrl, () => HttpResponse.json({ accounts: [invalidAccount] })),
      http.post(refreshUrl(), () => {
        refreshed += 1;
        return HttpResponse.json({ ok: true, account: { email: 'stale@example.com' } });
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const row = (await screen.findByText('stale@example.com')).closest('li')!;
    await user.click(row.querySelector('button[data-testid="subscription-refresh"]')!);

    await waitFor(() => expect(refreshed).toBe(1));
    expect(await screen.findByText(/已刷新 stale@example.com/)).toBeTruthy();
  });

  // 上游报错可能回带令牌片段；面板只显示消息，且必须把明文挡掉。
  it('shows a refresh failure without leaking the token', async () => {
    server.use(
      http.get(credentialsUrl, () => HttpResponse.json({ accounts: [invalidAccount] })),
      http.post(refreshUrl(), () =>
        HttpResponse.json(
          { error: 'refresh_token_reused for rt-secret-abcdef123456' },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    const row = (await screen.findByText('stale@example.com')).closest('li')!;
    await user.click(row.querySelector('button[data-testid="subscription-refresh"]')!);

    const message = await screen.findByText(/刷新失败/);
    expect(message.textContent).not.toContain('rt-secret-abcdef123456');
  });
});

describe('subscription i18n keys', () => {
  const SUBSCRIPTION_KEYS = [
    'settings.aria.subscription',
    'settings.section.subscription',
    'settings.subscription.hint',
    'settings.subscription.provider.codex',
    'settings.subscription.provider.claude',
    'settings.subscription.provider.google',
    'settings.subscription.imported',
    'settings.subscription.importFailed',
    'settings.subscription.tos',
    'settings.subscription.accounts.empty',
    'settings.subscription.accounts.loadFailed',
    'settings.subscription.status.active',
    'settings.subscription.status.invalid',
    'settings.subscription.reimport',
    'settings.subscription.expires',
    'settings.subscription.addedAt',
    'settings.subscription.plan',
    'settings.subscription.usage',
    'settings.subscription.lastError',
    'settings.subscription.remove',
    'settings.subscription.remove.confirm',
    'settings.subscription.removed',
    'settings.subscription.refresh',
    'settings.subscription.refreshed',
    'settings.subscription.refreshFailed',
    'settings.subscription.actionFailed',
    // 第二波：逐家磁贴 + 弹窗
    'settings.subscription.tile.connect',
    'settings.subscription.tile.connected',
    'settings.subscription.tile.empty',
    'settings.subscription.dialog.title',
    'settings.subscription.dialog.close',
    'settings.subscription.badge.pkce',
    'settings.subscription.badge.nopkce',
    'settings.subscription.dialog.login.heading',
    'settings.subscription.dialog.login.desc.codex',
    'settings.subscription.dialog.login.desc.claude',
    'settings.subscription.dialog.login.desc.google',
    'settings.subscription.dialog.login.open',
    'settings.subscription.dialog.login.endpoint',
    'settings.subscription.dialog.login.waiting',
    'settings.subscription.dialog.login.cancel',
    'settings.subscription.dialog.login.ok',
    'settings.subscription.dialog.autoRead.heading',
    'settings.subscription.field.email',
    'settings.subscription.field.plan',
    'settings.subscription.field.accountId',
    'settings.subscription.field.organization',
    'settings.subscription.field.accountUuid',
    'settings.subscription.field.gcpProject',
    'settings.subscription.dialog.gcpNote',
    'settings.subscription.dialog.import.heading',
    'settings.subscription.dialog.import.detect',
    'settings.subscription.dialog.error',
    'settings.subscription.oauth.error.timeout',
    'settings.subscription.oauth.error.portBusy',
    'settings.subscription.oauth.error.pending',
    'settings.subscription.oauth.error.state',
    'settings.subscription.oauth.error.denied',
    'settings.subscription.quotaExceeded.switchProject',
    'settings.subscription.quotaExceeded.switchProject.hint',
  ];

  it('ships every subscription string in zh and en', () => {
    for (const key of SUBSCRIPTION_KEYS) {
      expect(zh[key], `zh missing ${key}`).toBeTruthy();
      expect(en[key], `en missing ${key}`).toBeTruthy();
      expect(zh[key], `zh ${key} falls back to the raw key`).not.toBe(key);
      expect(en[key], `en ${key} falls back to the raw key`).not.toBe(key);
    }
  });
});
