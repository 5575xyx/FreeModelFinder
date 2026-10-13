import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import Home from '../page';
import { gateway, server } from '../../test/server';

const statusUrl = `${gateway}/api/admin/status`;

function renderPanel() {
  return render(
    <I18nProvider>
      <Home />
    </I18nProvider>,
  );
}

// jsdom reports en-US, which would make every copy assertion flaky. Pin the
// language the way a user picking it in the panel would.
beforeEach(() => {
  window.localStorage.setItem('fmf-language', 'zh');
});

describe('management panel sign-in gate', () => {
  it('holds the dashboard behind the login screen', async () => {
    server.use(
      http.get(statusUrl, () => HttpResponse.json({ authRequired: true, authenticated: false })),
    );
    renderPanel();

    expect(await screen.findByText('管理面板登录')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeDisabled();
    // The dashboard is not mounted at all while signed out.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('opens the dashboard straight away when no password is configured', async () => {
    server.use(
      http.get(statusUrl, () => HttpResponse.json({ authRequired: false, authenticated: true })),
    );
    renderPanel();

    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(screen.queryByText('管理面板登录')).not.toBeInTheDocument();
  });

  it('keeps the dashboard open when this gateway predates sign-in', async () => {
    server.use(
      http.get(statusUrl, () => HttpResponse.json({ error: 'forbidden' }, { status: 404 })),
    );
    renderPanel();

    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(screen.queryByText('管理面板登录')).not.toBeInTheDocument();
  });

  it('returns to the login screen when a route stops accepting the session', async () => {
    // The panel is open with no password, so the dashboard mounted on the
    // strength of that status snapshot.
    server.use(
      http.get(statusUrl, () =>
        HttpResponse.json({ authRequired: false, authenticated: true, remote: false }),
      ),
      // A password is set while the panel is open, and the next poll comes back
      // 401. The snapshot still says authRequired:false, so the flip cannot be
      // keyed on what the panel used to believe about itself.
      http.get(`${gateway}/api/desktop/state`, () =>
        HttpResponse.json({ error: { code: 'admin_signin_required' } }, { status: 401 }),
      ),
    );
    renderPanel();

    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(await screen.findByText('管理面板登录')).toBeInTheDocument();
  });

  it('refetches the alias table after a successful sign-in', async () => {
    // Sign-in gates every /api/* route, including /api/model-aliases, so the
    // mount-time fetch is doomed to 401 on an auth-protected gateway. The table
    // must be fetched again once the session exists.
    let signedIn = false;
    let aliasFetchAfterSignIn = false;
    server.use(
      http.get(statusUrl, () => HttpResponse.json({ authRequired: true, authenticated: signedIn })),
      http.post(`${gateway}/api/admin/login`, () => {
        signedIn = true;
        return HttpResponse.json({ ok: true });
      }),
      http.get(`${gateway}/api/model-aliases`, () => {
        if (!signedIn) return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
        aliasFetchAfterSignIn = true;
        return HttpResponse.json({ modelAliases: { shorty: 'openrouter:fixture-model' } });
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText('管理面板登录')).toBeInTheDocument();
    expect(aliasFetchAfterSignIn).toBe(false);

    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    await waitFor(() => expect(aliasFetchAfterSignIn).toBe(true));
  });
});

describe('management password hint', () => {
  beforeEach(() => {
    window.localStorage.removeItem('fmf-admin-banner-dismissed');
  });

  it('flags a panel that is reachable from outside while it has no password', async () => {
    server.use(
      http.get(statusUrl, () =>
        HttpResponse.json({ authRequired: false, authenticated: true, remote: true }),
      ),
    );
    renderPanel();

    expect(
      await screen.findByText('检测到从本机以外的地址访问面板，且尚未设置管理密码。'),
    ).toBeInTheDocument();
  });

  it('stays quiet for a local request', async () => {
    server.use(
      http.get(statusUrl, () =>
        HttpResponse.json({ authRequired: false, authenticated: true, remote: false }),
      ),
    );
    renderPanel();
    expect(await screen.findByRole('navigation')).toBeInTheDocument();

    expect(
      screen.queryByText('检测到从本机以外的地址访问面板，且尚未设置管理密码。'),
    ).not.toBeInTheDocument();
  });

  it('hides the hint while a password protects the panel', async () => {
    server.use(
      http.get(statusUrl, () =>
        HttpResponse.json({ authRequired: true, authenticated: true, remote: true }),
      ),
    );
    renderPanel();
    expect(await screen.findByRole('navigation')).toBeInTheDocument();

    expect(
      screen.queryByText('检测到从本机以外的地址访问面板，且尚未设置管理密码。'),
    ).not.toBeInTheDocument();
  });

  it('opens the password panel from the hint and remembers the dismissal', async () => {
    server.use(
      http.get(statusUrl, () =>
        HttpResponse.json({ authRequired: false, authenticated: true, remote: true }),
      ),
    );
    const user = userEvent.setup();
    renderPanel();

    expect(
      await screen.findByText('检测到从本机以外的地址访问面板，且尚未设置管理密码。'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '去设置' }));
    expect(await screen.findByText('管理面板密码')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '忽略' }));
    await waitFor(() =>
      expect(screen.queryByText('检测到从本机以外的地址访问面板，且尚未设置管理密码。')).toBeNull(),
    );
    expect(window.localStorage.getItem('fmf-admin-banner-dismissed')).toBe('1');
  });

  it('does not show the hint once it has been dismissed', async () => {
    window.localStorage.setItem('fmf-admin-banner-dismissed', '1');
    server.use(
      http.get(statusUrl, () =>
        HttpResponse.json({ authRequired: false, authenticated: true, remote: true }),
      ),
    );
    renderPanel();
    expect(await screen.findByRole('navigation')).toBeInTheDocument();

    expect(
      screen.queryByText('检测到从本机以外的地址访问面板，且尚未设置管理密码。'),
    ).not.toBeInTheDocument();
  });
});
