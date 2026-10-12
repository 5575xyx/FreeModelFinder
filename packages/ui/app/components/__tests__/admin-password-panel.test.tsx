import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminPasswordPanel } from '../AdminPasswordPanel';
import { gateway, server } from '../../../test/server';

const statusUrl = `${gateway}/api/admin/status`;
const passwordUrl = `${gateway}/api/admin/password`;

const PASSWORD = 'correct-horse-battery';
const NEXT = 'seven-correct-horses';

function statusOf(authRequired: boolean, remote = false) {
  server.use(
    http.get(statusUrl, () =>
      HttpResponse.json({ authRequired, authenticated: !authRequired, remote }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminPasswordPanel', () => {
  it('reports that this gateway has no password control at all', async () => {
    server.use(
      http.get(statusUrl, () => HttpResponse.json({ error: 'not found' }, { status: 404 })),
    );
    render(<AdminPasswordPanel />);

    expect(await screen.findByText('当前网关版本不支持面板密码')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设置密码' })).not.toBeInTheDocument();
  });

  it('offers a two-field form while no password exists', async () => {
    statusOf(false);
    render(<AdminPasswordPanel />);

    expect(await screen.findByText('管理面板密码')).toBeInTheDocument();
    expect(screen.getByText('未设置')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置密码' })).toBeDisabled();
    expect(screen.getByLabelText('新密码')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('确认新密码')).toHaveAttribute('type', 'password');
    // There is nothing to confirm against yet.
    expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消密码' })).not.toBeInTheDocument();
  });

  it('asks for the current password once one exists', async () => {
    statusOf(true);
    render(<AdminPasswordPanel />);

    expect(await screen.findByText('已设置')).toBeInTheDocument();
    expect(screen.getByLabelText('当前密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修改密码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消密码' })).toBeInTheDocument();
  });

  it('warns when the panel is reachable from outside and unprotected', async () => {
    statusOf(false, true);
    render(<AdminPasswordPanel />);

    expect(
      await screen.findByText(
        '检测到从本机以外的地址访问面板，而现在还没有密码。能访问这个端口的人就能看到你的供应商密钥。',
      ),
    ).toBeInTheDocument();
  });

  it('stays quiet about exposure when a password is already in place', async () => {
    statusOf(true, true);
    render(<AdminPasswordPanel />);
    expect(await screen.findByText('已设置')).toBeInTheDocument();

    expect(
      screen.queryByText(
        '检测到从本机以外的地址访问面板，而现在还没有密码。能访问这个端口的人就能看到你的供应商密钥。',
      ),
    ).not.toBeInTheDocument();
  });

  it('sets a password without sending a current password', async () => {
    statusOf(false);
    let body: unknown;
    server.use(
      http.post(passwordUrl, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, authRequired: true });
      }),
    );
    const user = userEvent.setup();
    render(<AdminPasswordPanel />);
    expect(await screen.findByText('管理面板密码')).toBeInTheDocument();

    await user.type(screen.getByLabelText('新密码'), NEXT);
    await user.type(screen.getByLabelText('确认新密码'), NEXT);
    await user.click(screen.getByRole('button', { name: '设置密码' }));

    expect(await screen.findByText('密码已设置。')).toBeInTheDocument();
    expect(body).toEqual({ action: 'set', password: NEXT });
  });

  it('sends the current password when changing one', async () => {
    statusOf(true);
    let body: unknown;
    server.use(
      http.post(passwordUrl, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, authRequired: true });
      }),
    );
    const user = userEvent.setup();
    render(<AdminPasswordPanel />);
    expect(await screen.findByText('已设置')).toBeInTheDocument();

    await user.type(screen.getByLabelText('当前密码'), PASSWORD);
    await user.type(screen.getByLabelText('新密码'), NEXT);
    await user.type(screen.getByLabelText('确认新密码'), NEXT);
    await user.click(screen.getByRole('button', { name: '修改密码' }));

    expect(await screen.findByText('密码已更新。')).toBeInTheDocument();
    expect(body).toEqual({ action: 'change', currentPassword: PASSWORD, password: NEXT });
  });

  it('refuses a mismatched confirmation before calling the gateway', async () => {
    statusOf(false);
    const calls: unknown[] = [];
    server.use(
      http.post(passwordUrl, async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({ ok: true, authRequired: true });
      }),
    );
    const user = userEvent.setup();
    render(<AdminPasswordPanel />);
    expect(await screen.findByText('管理面板密码')).toBeInTheDocument();

    await user.type(screen.getByLabelText('新密码'), NEXT);
    await user.type(screen.getByLabelText('确认新密码'), 'seven-correct-horser');
    await user.click(screen.getByRole('button', { name: '设置密码' }));

    expect(await screen.findByText('两次输入的新密码不一致。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('refuses a password that is too short before calling the gateway', async () => {
    statusOf(false);
    const calls: unknown[] = [];
    server.use(
      http.post(passwordUrl, async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({ ok: true, authRequired: true });
      }),
    );
    const user = userEvent.setup();
    render(<AdminPasswordPanel />);
    expect(await screen.findByText('管理面板密码')).toBeInTheDocument();

    await user.type(screen.getByLabelText('新密码'), 'short');
    await user.type(screen.getByLabelText('确认新密码'), 'short');
    await user.click(screen.getByRole('button', { name: '设置密码' }));

    expect(await screen.findByText('新密码至少需要 8 个字符。')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('shows the gateway error when the write is rejected', async () => {
    statusOf(true);
    server.use(
      http.post(passwordUrl, () =>
        HttpResponse.json(
          { error: { message: 'Password must be at least 8 characters long', code: 'x' } },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    render(<AdminPasswordPanel />);
    expect(await screen.findByText('已设置')).toBeInTheDocument();

    await user.type(screen.getByLabelText('当前密码'), PASSWORD);
    await user.type(screen.getByLabelText('新密码'), NEXT);
    await user.type(screen.getByLabelText('确认新密码'), NEXT);
    await user.click(screen.getByRole('button', { name: '修改密码' }));

    expect(
      await screen.findByText('Password must be at least 8 characters long'),
    ).toBeInTheDocument();
    // The password is still considered in place.
    expect(screen.getByText('已设置')).toBeInTheDocument();
  });

  it('clears the password only after confirmation', async () => {
    statusOf(true);
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    let payload: unknown;
    server.use(
      http.post(passwordUrl, async ({ request }) => {
        payload = await request.json();
        return HttpResponse.json({ ok: true, authRequired: false });
      }),
    );
    const user = userEvent.setup();
    render(<AdminPasswordPanel />);
    expect(await screen.findByText('已设置')).toBeInTheDocument();

    await user.type(screen.getByLabelText('当前密码'), PASSWORD);

    await user.click(screen.getByRole('button', { name: '取消密码' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(payload).toBeUndefined();

    vi.stubGlobal('confirm', () => true);
    await user.click(screen.getByRole('button', { name: '取消密码' }));

    expect(await screen.findByText('密码已取消，面板恢复免登录。')).toBeInTheDocument();
    expect(payload).toEqual({ action: 'clear', currentPassword: PASSWORD });
    expect(screen.getByText('未设置')).toBeInTheDocument();
  });

  it('reports a network failure and keeps the previous state', async () => {
    statusOf(false);
    server.use(http.post(passwordUrl, () => HttpResponse.error()));
    const user = userEvent.setup();
    render(<AdminPasswordPanel />);
    expect(await screen.findByText('未设置')).toBeInTheDocument();

    await user.type(screen.getByLabelText('新密码'), NEXT);
    await user.type(screen.getByLabelText('确认新密码'), NEXT);
    await user.click(screen.getByRole('button', { name: '设置密码' }));

    expect(await screen.findByText('无法连接到网关。')).toBeInTheDocument();
    expect(screen.getByText('未设置')).toBeInTheDocument();
  });

  it('collapses the details on demand', async () => {
    statusOf(false);
    const user = userEvent.setup();
    render(<AdminPasswordPanel />);
    expect(await screen.findByLabelText('新密码')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '管理面板密码 未设置' }));
    await waitFor(() => expect(screen.queryByLabelText('新密码')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '管理面板密码 未设置' }));
    expect(await screen.findByLabelText('新密码')).toBeInTheDocument();
  });
});
