import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ClineAccountsPanel } from '../ClineAccountsPanel';
import { SettingsView } from '../SettingsView';
import { configPayload, gateway, server } from '../../../test/server';
import { en, zh } from '../../i18n';

const accountsUrl = `${gateway}/api/cline/accounts`;
const startUrl = `${gateway}/api/cline/login/start`;
const pollUrl = `${gateway}/api/cline/login/poll`;
const providersUrl = `${gateway}/api/providers`;

const activeAccount = {
  id: 'acc-active',
  label: 'ada@example.com',
  status: 'active',
  addedAt: 1_700_000_000_000,
  lastUsedAt: 1_700_000_600_000,
  cooldowns: [],
  usage: { requests: 3, promptTokens: 10, completionTokens: 5 },
};

const coolingAccount = {
  id: 'acc-cooling',
  label: 'lin@example.com',
  status: 'active',
  addedAt: 1_700_000_100_000,
  lastUsedAt: null,
  cooldowns: [{ model: 'deepseek/deepseek-v4-flash', resetAt: Date.now() + 90_000 }],
  usage: {
    requests: 1,
    promptTokens: 2,
    completionTokens: 3,
    lastError: 'upstream refused Bearer [REDACTED]',
  },
};

const invalidAccount = {
  id: 'acc-invalid',
  label: 'old@example.com',
  status: 'invalid',
  addedAt: 1_699_999_000_000,
  lastUsedAt: null,
  cooldowns: [],
  usage: { requests: 0, promptTokens: 0, completionTokens: 0 },
};

function clineConfig(cline: { enabled: boolean; hasKey: boolean; dynamicModels?: boolean }) {
  const { dynamicModels, ...rest } = cline;
  return {
    ...configPayload,
    providers: {
      ...configPayload.providers,
      cline: {
        ...rest,
        keyCount: 0,
        keyMeta: [],
        ...(dynamicModels === undefined ? {} : { dynamicModels }),
      },
    },
  };
}

describe('ClineAccountsPanel', () => {
  it('renders active, cooling and invalid accounts with usage detail', async () => {
    server.use(
      http.get(accountsUrl, () =>
        HttpResponse.json({ accounts: [activeAccount, coolingAccount, invalidAccount] }),
      ),
    );
    render(<ClineAccountsPanel enabled onChanged={() => undefined} />);

    const activeRow = (await screen.findByText('ada@example.com')).closest('li');
    expect(activeRow).not.toBeNull();
    expect(within(activeRow as HTMLElement).getByText('可用')).toBeTruthy();
    expect(within(activeRow as HTMLElement).getByText(/请求 3 · 输入 10 · 输出 5/)).toBeTruthy();
    expect(within(activeRow as HTMLElement).getByText(/添加于/)).toBeTruthy();
    expect(within(activeRow as HTMLElement).getByText(/最近使用/)).toBeTruthy();

    const coolingRow = screen.getByText('lin@example.com').closest('li');
    expect(coolingRow).not.toBeNull();
    expect(within(coolingRow as HTMLElement).getByText('可用')).toBeTruthy();
    expect(within(coolingRow as HTMLElement).getByText('冷却中')).toBeTruthy();
    expect(
      within(coolingRow as HTMLElement).getByText(/deepseek\/deepseek-v4-flash 冷却中/),
    ).toBeTruthy();
    expect(within(coolingRow as HTMLElement).getByText(/最近错误：/)).toBeTruthy();
    expect(
      within(coolingRow as HTMLElement).getByRole('button', { name: '解除冷却' }),
    ).toBeTruthy();

    const invalidRow = screen.getByText('old@example.com').closest('li');
    expect(invalidRow).not.toBeNull();
    expect(within(invalidRow as HTMLElement).getByText('需重新登录')).toBeTruthy();
    expect(
      within(invalidRow as HTMLElement).queryByRole('button', { name: '解除冷却' }),
    ).toBeNull();

    expect(screen.getAllByRole('button', { name: '登出' })).toHaveLength(3);
    const toggle = screen.getByRole('checkbox', { name: '启用 Cline' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('3 个')).toBeTruthy();
  });

  it('shows the empty state with a login action when no account exists', async () => {
    server.use(http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })));
    render(<ClineAccountsPanel />);

    expect(await screen.findByText(/暂无账号/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: '登录 Cline 账号' })).toBeTruthy();
    const toggle = screen.getByRole('checkbox', { name: '启用 Cline' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('reports a failed account list without dropping the panel', async () => {
    server.use(http.get(accountsUrl, () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    render(<ClineAccountsPanel />);
    expect(await screen.findByText(/账号列表加载失败/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: '登录 Cline 账号' })).toBeTruthy();
  });

  it('clears cooldowns for a single account', async () => {
    let cooldownsLeft = true;
    const clears: string[] = [];
    server.use(
      http.get(accountsUrl, () =>
        HttpResponse.json({ accounts: cooldownsLeft ? [coolingAccount] : [] }),
      ),
      http.post(`${accountsUrl}/acc-cooling/cooldowns/clear`, async () => {
        clears.push('acc-cooling');
        cooldownsLeft = false;
        return HttpResponse.json({ cleared: 1 });
      }),
    );
    const user = userEvent.setup();
    render(<ClineAccountsPanel enabled />);

    await user.click(await screen.findByRole('button', { name: '解除冷却' }));
    expect(await screen.findByText('已解除 1 条冷却')).toBeTruthy();
    await waitFor(() => expect(clears).toEqual(['acc-cooling']));
    expect(screen.queryByText(/冷却中，/)).toBeNull();
  });

  it('requires a second click to log an account out', async () => {
    let loggedOut = false;
    const logoutCalls: string[] = [];
    server.use(
      http.get(accountsUrl, () =>
        HttpResponse.json({ accounts: loggedOut ? [] : [activeAccount] }),
      ),
      http.post(`${accountsUrl}/acc-active/logout`, () => {
        logoutCalls.push('acc-active');
        loggedOut = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<ClineAccountsPanel enabled />);

    const row = (await screen.findByText('ada@example.com')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: '登出' }));
    expect(within(row).getByRole('button', { name: '确认登出' })).toBeTruthy();
    expect(logoutCalls).toHaveLength(0);
    await user.click(within(row).getByRole('button', { name: '确认登出' }));
    await waitFor(() => expect(logoutCalls).toEqual(['acc-active']));
    expect(await screen.findByText(/暂无账号/)).toBeTruthy();
  });

  it('POSTs the enabled flag when the toggle flips', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })),
      http.post(providersUrl, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<ClineAccountsPanel onChanged={onChanged} />);

    await user.click(await screen.findByRole('checkbox', { name: '启用 Cline' }));
    await waitFor(() => expect(writes[0]).toMatchObject({ provider: 'cline', enabled: true }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('walks the login wizard from pending to complete', async () => {
    let polls = 0;
    let loggedIn = false;
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: loggedIn ? [activeAccount] : [] })),
      http.post(startUrl, () =>
        HttpResponse.json({
          flowId: 'flow-1',
          code: 'ABCD-EFGH',
          userUrl: 'https://example.com/activate?user_code=ABCD-EFGH',
          expiresAt: Date.now() + 300_000,
        }),
      ),
      http.post(pollUrl, () => {
        polls += 1;
        if (polls === 1) return HttpResponse.json({ status: 'pending' });
        loggedIn = true;
        return HttpResponse.json({
          status: 'complete',
          account: { id: 'acc-active', label: 'ada@example.com', status: 'active' },
        });
      }),
      http.post(providersUrl, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<ClineAccountsPanel onChanged={onChanged} />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(await screen.findByText(/等待在授权页确认/)).toBeTruthy();
    const openLink = screen.getByRole('link', { name: /打开授权页/ });
    expect(openLink.getAttribute('href')).toBe('https://example.com/activate?user_code=ABCD-EFGH');

    expect(await screen.findByText('ada@example.com', {}, { timeout: 6000 })).toBeTruthy();
    expect(await screen.findByText(/登录成功：ada@example.com/)).toBeTruthy();
    await waitFor(() => expect(polls).toBe(2), { timeout: 6000 });
    await waitFor(() => expect(writes).toContainEqual({ provider: 'cline', enabled: true }), {
      timeout: 6000,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled(), { timeout: 6000 });
  });

  it('stops on an expired flow and restarts from the retry action', async () => {
    let startCalls = 0;
    let expiredOnce = false;
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })),
      http.post(startUrl, () => {
        startCalls += 1;
        return HttpResponse.json({
          flowId: `flow-${startCalls}`,
          code: 'CODE-0001',
          userUrl: 'https://example.com/activate',
          expiresAt: Date.now() + 300_000,
        });
      }),
      http.post(pollUrl, () => {
        if (expiredOnce) return HttpResponse.json({ status: 'pending' });
        expiredOnce = true;
        return HttpResponse.json({ status: 'expired' });
      }),
    );
    const user = userEvent.setup();
    render(<ClineAccountsPanel />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('授权已过期，请重试')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('CODE-0001')).toBeTruthy();
    expect(startCalls).toBe(2);
  });

  it('stops on a denied flow', async () => {
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })),
      http.post(startUrl, () =>
        HttpResponse.json({
          flowId: 'flow-denied',
          code: 'CODE-0002',
          userUrl: 'https://example.com/activate',
          expiresAt: Date.now() + 300_000,
        }),
      ),
      http.post(pollUrl, () => HttpResponse.json({ status: 'denied' })),
    );
    const user = userEvent.setup();
    render(<ClineAccountsPanel />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('授权被拒绝，请重试')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('keeps polling stopped after the panel unmounts', async () => {
    let polls = 0;
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })),
      http.post(startUrl, () =>
        HttpResponse.json({
          flowId: 'flow-unmount',
          code: 'CODE-0003',
          userUrl: 'https://example.com/activate',
          expiresAt: Date.now() + 300_000,
        }),
      ),
      http.post(pollUrl, () => {
        polls += 1;
        return HttpResponse.json({ status: 'pending' });
      }),
    );
    const user = userEvent.setup();
    const { unmount } = render(<ClineAccountsPanel />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('CODE-0003')).toBeTruthy();
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(1));
    unmount();
    const pollsAtUnmount = polls;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(polls).toBe(pollsAtUnmount);
  }, 15_000);

  it('ignores a poll that lands after the sign-in was cancelled', async () => {
    let polls = 0;
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })),
      http.post(startUrl, () =>
        HttpResponse.json({
          flowId: 'flow-cancel',
          code: 'CODE-0004',
          userUrl: 'https://example.com/activate',
          expiresAt: Date.now() + 300_000,
        }),
      ),
      http.post(pollUrl, async () => {
        polls += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return HttpResponse.json({
          status: 'complete',
          account: { id: 'acc-active', label: 'ada@example.com', status: 'active' },
        });
      }),
    );
    const user = userEvent.setup();
    render(<ClineAccountsPanel />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('CODE-0004')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消登录' }));
    expect(await screen.findByRole('button', { name: '登录 Cline 账号' })).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(polls).toBe(1);
    expect(screen.queryByText('登录成功：ada@example.com')).toBeNull();
    expect(screen.queryByText('CODE-0004')).toBeNull();
  }, 10_000);

  it('reports a failed auto-enable after a successful sign-in', async () => {
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [activeAccount] })),
      http.post(startUrl, () =>
        HttpResponse.json({
          flowId: 'flow-enable',
          code: 'CODE-0005',
          userUrl: 'https://example.com/activate',
          expiresAt: Date.now() + 300_000,
        }),
      ),
      http.post(pollUrl, () =>
        HttpResponse.json({
          status: 'complete',
          account: { id: 'acc-active', label: 'ada@example.com', status: 'active' },
        }),
      ),
      http.post(providersUrl, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );
    const user = userEvent.setup();
    render(<ClineAccountsPanel />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('登录成功：ada@example.com')).toBeTruthy();
    expect(await screen.findByText(/已登录，但自动启用失败/)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '启用 Cline' }) as HTMLInputElement).checked).toBe(
      false,
    );
  }, 10_000);

  it('ends the wizard with an error when the poll endpoint fails', async () => {
    let polls = 0;
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })),
      http.post(startUrl, () =>
        HttpResponse.json({
          flowId: 'flow-poll-fail',
          code: 'CODE-0006',
          userUrl: 'https://example.com/activate',
          expiresAt: Date.now() + 300_000,
        }),
      ),
      http.post(pollUrl, () => {
        polls += 1;
        return HttpResponse.json({ error: 'upstream broke' }, { status: 502 });
      }),
    );
    const user = userEvent.setup();
    render(<ClineAccountsPanel />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('登录失败：upstream broke')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByText('CODE-0006')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(polls).toBe(1);
  }, 10_000);

  it('expires the flow from the clock when polling never returns a terminal state', async () => {
    let polls = 0;
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })),
      http.post(startUrl, () =>
        HttpResponse.json({
          flowId: 'flow-watchdog',
          code: 'CODE-0007',
          userUrl: 'https://example.com/activate',
          expiresAt: Date.now() + 1500,
        }),
      ),
      http.post(pollUrl, () => {
        polls += 1;
        return new Promise<never>(() => undefined);
      }),
    );
    const user = userEvent.setup();
    render(<ClineAccountsPanel />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('CODE-0007')).toBeTruthy();
    expect(await screen.findByText('授权已过期，请重试', {}, { timeout: 5000 })).toBeTruthy();
    expect(polls).toBe(1);
    expect(screen.queryByText(/登录失败/)).toBeNull();
  }, 10_000);

  it('disarms the logout confirmation on its own', async () => {
    server.use(http.get(accountsUrl, () => HttpResponse.json({ accounts: [activeAccount] })));
    const user = userEvent.setup();
    render(<ClineAccountsPanel enabled />);

    const row = (await screen.findByText('ada@example.com')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: '登出' }));
    expect(within(row).getByRole('button', { name: '确认登出' })).toBeTruthy();

    await waitFor(
      () => expect(within(row).queryByRole('button', { name: '确认登出' })).toBeNull(),
      { timeout: 6000, interval: 200 },
    );
    expect(within(row).getByRole('button', { name: '登出' })).toBeTruthy();
  }, 10_000);
});

describe('cline card state', () => {
  it.each([
    [{ enabled: true, hasKey: true }, '已配置'],
    [{ enabled: true, hasKey: false }, '未配置'],
    [{ enabled: false, hasKey: true }, '未配置'],
  ])('renders the key badge for enabled=%s hasKey=%s as %s', async (cline, expected) => {
    server.use(http.get(`${gateway}/api/config`, () => HttpResponse.json(clineConfig(cline))));
    render(<SettingsView />);
    const badgeInCard = () => {
      const label = screen.getByText('Cline');
      const card = label.closest('.rounded-lg');
      expect(card).not.toBeNull();
      return within(card as HTMLElement);
    };
    await waitFor(() => expect(badgeInCard().getByText(expected)).toBeTruthy());
    expect(badgeInCard().getByTestId('cline-panel')).toBeTruthy();
  });

  it('moves the card to configured after a completed login', async () => {
    let configCalls = 0;
    let polls = 0;
    let loggedIn = false;
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () => {
        configCalls += 1;
        return HttpResponse.json(
          configCalls <= 1
            ? clineConfig({ enabled: false, hasKey: false })
            : clineConfig({ enabled: true, hasKey: true }),
        );
      }),
      http.get(accountsUrl, () => HttpResponse.json({ accounts: loggedIn ? [activeAccount] : [] })),
      http.post(startUrl, () =>
        HttpResponse.json({
          flowId: 'flow-card',
          code: 'CARD-0001',
          userUrl: 'https://example.com/activate',
          expiresAt: Date.now() + 300_000,
        }),
      ),
      http.post(pollUrl, () => {
        polls += 1;
        if (polls === 1) return HttpResponse.json({ status: 'pending' });
        loggedIn = true;
        return HttpResponse.json({
          status: 'complete',
          account: { id: 'acc-active', label: 'ada@example.com', status: 'active' },
        });
      }),
      http.post(providersUrl, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(await screen.findByRole('button', { name: '登录 Cline 账号' }));
    expect(await screen.findByText('CARD-0001')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('已配置')).toHaveLength(1), { timeout: 6000 });
    await waitFor(() => expect(configCalls).toBeGreaterThanOrEqual(2), { timeout: 6000 });
    await waitFor(
      () => {
        const toast = document.querySelector('.toast-in');
        expect(toast).not.toBeNull();
        expect(toast?.textContent).toContain('登录成功：ada@example.com');
      },
      { timeout: 6000, interval: 50 },
    );
    await waitFor(() => expect(writes).toContainEqual({ provider: 'cline', enabled: true }), {
      timeout: 6000,
    });
    expect(await screen.findByText('ada@example.com', {}, { timeout: 6000 })).toBeTruthy();
  }, 15_000);
});

describe('cline dynamic models checkbox', () => {
  async function waitForLoadedConfig(): Promise<void> {
    await waitFor(() => {
      const enableBox = screen.getByRole('checkbox', { name: '启用 Cline' }) as HTMLInputElement;
      expect(enableBox.checked).toBe(true);
    });
  }

  it('checks the box when the stored config omits dynamicModels', async () => {
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json(clineConfig({ enabled: true, hasKey: true })),
      ),
    );
    render(<SettingsView />);
    await waitForLoadedConfig();
    await waitFor(() => {
      const box = screen.getByRole('checkbox', {
        name: '动态同步上游免费模型',
      }) as HTMLInputElement;
      expect(box.checked).toBe(true);
    });
  });

  it('unchecks the box when the config echoes dynamicModels false', async () => {
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json(clineConfig({ enabled: true, hasKey: true, dynamicModels: false })),
      ),
    );
    render(<SettingsView />);
    await waitForLoadedConfig();
    await waitFor(() => {
      const box = screen.getByRole('checkbox', {
        name: '动态同步上游免费模型',
      }) as HTMLInputElement;
      expect(box.checked).toBe(false);
    });
  });

  it('POSTs dynamicModels without the enabled flag when the box flips', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })),
      http.post(providersUrl, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<ClineAccountsPanel enabled onChanged={onChanged} />);

    const box = (await screen.findByRole('checkbox', {
      name: '动态同步上游免费模型',
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(box);
    await waitFor(() => expect(writes[0]).toEqual({ provider: 'cline', dynamicModels: false }));
    expect(writes[0]).not.toHaveProperty('enabled');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('keeps the box unchecked when the panel renders dynamicModels false', async () => {
    server.use(http.get(accountsUrl, () => HttpResponse.json({ accounts: [] })));
    render(<ClineAccountsPanel enabled dynamicModels={false} />);
    const box = (await screen.findByRole('checkbox', {
      name: '动态同步上游免费模型',
    })) as HTMLInputElement;
    expect(box.checked).toBe(false);
  });
});

describe('cline i18n keys', () => {
  const CLINE_KEYS = [
    'platforms.cline.hint',
    'platforms.cline.label',
    'settings.cline.enable',
    'settings.cline.dynamicModels',
    'settings.cline.dynamicModels.hint',
    'settings.cline.enableFailed',
    'settings.cline.accounts.title',
    'settings.cline.accounts.count',
    'settings.cline.accounts.empty',
    'settings.cline.accounts.loadFailed',
    'settings.cline.login',
    'settings.cline.login.another',
    'settings.cline.login.starting',
    'settings.cline.login.code',
    'settings.cline.login.copy',
    'settings.cline.login.copied',
    'settings.cline.login.open',
    'settings.cline.login.waiting',
    'settings.cline.login.expiresIn',
    'settings.cline.login.expired',
    'settings.cline.login.denied',
    'settings.cline.login.failed',
    'settings.cline.login.cancel',
    'settings.cline.login.retry',
    'settings.cline.login.success',
    'settings.cline.status.active',
    'settings.cline.status.invalid',
    'settings.cline.cooldown.badge',
    'settings.cline.cooldown',
    'settings.cline.cooldown.clear',
    'settings.cline.cooldown.cleared',
    'settings.cline.addedAt',
    'settings.cline.lastUsed',
    'settings.cline.lastUsed.never',
    'settings.cline.usage',
    'settings.cline.lastError',
    'settings.cline.logout',
    'settings.cline.logout.confirm',
    'settings.cline.actionFailed',
  ];

  it('ships every cline string in zh and en', () => {
    for (const key of CLINE_KEYS) {
      expect(zh[key], `zh missing ${key}`).toBeTruthy();
      expect(en[key], `en missing ${key}`).toBeTruthy();
      expect(zh[key], `zh ${key} falls back to the raw key`).not.toBe(key);
      expect(en[key], `en ${key} falls back to the raw key`).not.toBe(key);
    }
  });
});
