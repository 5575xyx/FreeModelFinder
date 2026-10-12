import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginScreen, AdminSignOutButton, fetchAdminStatus } from '../AdminLoginScreen';
import { gateway, server } from '../../../test/server';

const statusUrl = `${gateway}/api/admin/status`;
const loginUrl = `${gateway}/api/admin/login`;
const logoutUrl = `${gateway}/api/admin/logout`;

const PASSWORD = 'correct-horse-battery';

function renderLogin(onSignedIn = vi.fn()) {
  return { onSignedIn, ...render(<AdminLoginScreen onSignedIn={onSignedIn} />) };
}

/** jsdom's `location.reload` is not redefinable, so swap the whole Location. */
function stubReload() {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'location');
  const reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
  return {
    reload,
    restore: () => {
      if (descriptor) Object.defineProperty(window, 'location', descriptor);
    },
  };
}

let restoreLocation: (() => void) | undefined;

afterEach(() => {
  restoreLocation?.();
  restoreLocation = undefined;
});

describe('fetchAdminStatus', () => {
  it('reports what the panel needs', async () => {
    server.use(
      http.get(statusUrl, () => HttpResponse.json({ authRequired: true, authenticated: false })),
    );
    await expect(fetchAdminStatus()).resolves.toEqual({
      authRequired: true,
      authenticated: false,
      remote: false,
    });
  });

  it('reports remote:true when the request did not come over loopback', async () => {
    server.use(
      http.get(statusUrl, () =>
        HttpResponse.json({ authRequired: false, authenticated: true, remote: true }),
      ),
    );
    await expect(fetchAdminStatus()).resolves.toEqual({
      authRequired: false,
      authenticated: true,
      remote: true,
    });
  });

  it('resolves to null for a gateway that predates sign-in', async () => {
    server.use(
      http.get(statusUrl, () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })),
    );
    await expect(fetchAdminStatus()).resolves.toBeNull();

    server.use(http.get(statusUrl, () => HttpResponse.error()));
    await expect(fetchAdminStatus()).resolves.toBeNull();
  });

  it('resolves to null on a malformed body', async () => {
    server.use(http.get(statusUrl, () => HttpResponse.json({ authRequired: 'yes' })));
    await expect(fetchAdminStatus()).resolves.toBeNull();
  });
});

describe('AdminLoginScreen', () => {
  it('renders the password form and blocks an empty submit', () => {
    renderLogin();
    expect(screen.getByText('管理面板登录')).toBeInTheDocument();
    expect(
      screen.getByText('已启用访问密码。登录后才能查看供应商与模型信息。'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: '登录' })).toBeDisabled();
  });

  it('sends the password as JSON and reports success', async () => {
    let body: unknown;
    let contentType: string | null = null;
    server.use(
      http.post(loginUrl, async ({ request }) => {
        contentType = request.headers.get('content-type');
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
      http.get(statusUrl, () => HttpResponse.json({ authRequired: true, authenticated: true })),
    );
    const user = userEvent.setup();
    const { onSignedIn } = renderLogin();

    await user.type(screen.getByLabelText('密码'), PASSWORD);
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(contentType).toContain('application/json');
    expect(body).toEqual({ password: PASSWORD });
  });

  it('surfaces the gateway error for a wrong password and does not sign in', async () => {
    server.use(
      http.post(loginUrl, () =>
        HttpResponse.json(
          { error: { message: 'Incorrect password.', code: 'admin_bad_password' } },
          { status: 401 },
        ),
      ),
    );
    const user = userEvent.setup();
    const { onSignedIn } = renderLogin();

    await user.type(screen.getByLabelText('密码'), 'wrong-password-here');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('Incorrect password.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('keeps the form open when the session still does not exist', async () => {
    server.use(
      http.post(loginUrl, () => HttpResponse.json({ ok: true })),
      http.get(statusUrl, () => HttpResponse.json({ authRequired: true, authenticated: false })),
    );
    const user = userEvent.setup();
    const { onSignedIn } = renderLogin();

    await user.type(screen.getByLabelText('密码'), PASSWORD);
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('登录未生效，请重试。')).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('reports a gateway it cannot reach', async () => {
    server.use(http.post(loginUrl, () => HttpResponse.error()));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('密码'), PASSWORD);
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('无法连接到网关。')).toBeInTheDocument();
  });
});

describe('AdminSignOutButton', () => {
  it('posts to logout with the ui client header and reloads the panel', async () => {
    let clientHeader: string | null = null;
    server.use(
      http.post(logoutUrl, ({ request }) => {
        clientHeader = request.headers.get('x-fmf-client');
        return HttpResponse.json({ ok: true });
      }),
    );
    const { reload, restore } = stubReload();
    restoreLocation = restore;

    render(<AdminSignOutButton />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(clientHeader).toBe('ui');
  });

  it('still reloads when the logout request fails', async () => {
    server.use(http.post(logoutUrl, () => HttpResponse.error()));
    const { reload, restore } = stubReload();
    restoreLocation = restore;

    render(<AdminSignOutButton />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
