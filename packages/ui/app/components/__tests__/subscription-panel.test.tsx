import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { SubscriptionAccountsPanel } from '../SubscriptionAccountsPanel';
import { gateway, server } from '../../../test/server';
import { en, zh } from '../../i18n';

const accountsUrl = `${gateway}/api/subscription/accounts`;
const importUrl = `${gateway}/api/subscription/import`;

function accountUrl(provider: string, id: string): string {
  return `${accountsUrl}/${provider}/${id}`;
}

function refreshUrl(provider: string, id: string): string {
  return `${accountUrl(provider, id)}/refresh`;
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

describe('SubscriptionAccountsPanel', () => {
  it('renders provider tiles with default paths, the raw textarea and the ToS warning', async () => {
    render(<SubscriptionAccountsPanel />);

    for (const provider of ['codex', 'claude', 'google'] as const) {
      const tile = screen.getByTestId(`subscription-tile-${provider}`);
      expect(tile).toBeTruthy();
      expect(tile.querySelector('input')?.value).toBeTruthy();
      expect(tile.querySelector('button')?.textContent).toContain('导入');
    }
    expect((screen.getByLabelText('Codex 凭据文件路径') as HTMLInputElement).value).toBe(
      '~/.codex/auth.json',
    );
    expect(screen.getByLabelText('或粘贴凭据内容')).toBeTruthy();
    expect(screen.getByText(/风险提示/)).toBeTruthy();
    expect(await screen.findByText(/暂无订阅账号/)).toBeTruthy();
  });

  it('imports an account by path and shows the managed-by-FMF notice', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let imported = false;
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: imported ? [codexAccount] : [] })),
      http.post(importUrl, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
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

    await user.click(screen.getByTestId('subscription-tile-codex').querySelector('button')!);

    expect(await screen.findByText(/已导入 ada@example.com，该账号已由 FMF 接管/)).toBeTruthy();
    await waitFor(() =>
      expect(bodies).toEqual([{ provider: 'codex', path: '~/.codex/auth.json' }]),
    );
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('prefers the raw textarea content over the path when both are present', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(importUrl, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true, account: { provider: 'codex', id: 'acc-codex' } });
      }),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await user.type(screen.getByLabelText('或粘贴凭据内容'), 'raw-credential-json');
    await user.click(screen.getByTestId('subscription-tile-codex').querySelector('button')!);

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ provider: 'codex', raw: 'raw-credential-json' });
  });

  it('surfaces the import failure and keeps the panel usable', async () => {
    server.use(
      http.post(importUrl, () =>
        HttpResponse.json({ error: 'invalid credential file' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<SubscriptionAccountsPanel />);

    await user.click(screen.getByTestId('subscription-tile-google').querySelector('button')!);

    expect(await screen.findByText(/导入失败：invalid credential file/)).toBeTruthy();
    expect(screen.getByTestId('subscription-tile-google').querySelector('button')!.disabled).toBe(
      false,
    );
  });

  it('renders active and invalid badges from the account list', async () => {
    server.use(
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [codexAccount, invalidAccount] })),
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

  it('reports a failed account list without dropping the panel', async () => {
    server.use(http.get(accountsUrl, () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    render(<SubscriptionAccountsPanel />);

    expect(await screen.findByText(/账号列表加载失败/)).toBeTruthy();
    expect(screen.getByTestId('subscription-tile-codex')).toBeTruthy();
  });

  it('renders the plan, expiry and usage numbers on an account card', async () => {
    server.use(
      http.get(accountsUrl, () =>
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
    server.use(http.get(accountsUrl, () => HttpResponse.json({ accounts: [invalidAccount] })));
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
      http.get(accountsUrl, () => HttpResponse.json({ accounts: removed ? [] : [codexAccount] })),
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
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [invalidAccount] })),
      http.post(refreshUrl('codex', 'acc-stale'), () => {
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
      http.get(accountsUrl, () => HttpResponse.json({ accounts: [invalidAccount] })),
      http.post(refreshUrl('codex', 'acc-stale'), () =>
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
    'settings.subscription.pathLabel',
    'settings.subscription.rawLabel',
    'settings.subscription.rawPlaceholder',
    'settings.subscription.import',
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
