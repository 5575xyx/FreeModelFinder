import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { SettingsView } from '../SettingsView';
import { configPayload, gateway, server } from '../../../test/server';

describe('SettingsView', () => {
  it('saves provider and custom-source keys', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${gateway}/api/providers`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
      http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
    );
    const user = userEvent.setup();
    render(<SettingsView />);

    const providerKey = await screen.findByLabelText('OpenRouter API Key');
    await user.type(providerKey, 'provider-secret');
    const providerControls = providerKey.parentElement?.parentElement;
    expect(providerControls).not.toBeNull();
    await user.click(within(providerControls!).getByRole('button', { name: '保存' }));

    const sourceKey = await screen.findByPlaceholderText(/粘贴 API Key（本地无鉴权可留空）/);
    await user.type(sourceKey, 'custom-secret');
    const sourceCard = sourceKey.closest('li');
    expect(sourceCard).not.toBeNull();
    await user.click(within(sourceCard as HTMLElement).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(2));
    expect(writes[1]).toMatchObject({
      provider: 'custom',
      appendSourceKeys: { sourceId: 'fixture-source', keys: ['custom-secret'] },
    });

    const mainSave = await screen.findByRole(
      'button',
      { name: '保存自定义模型' },
      {
        timeout: 5000,
      },
    );
    await user.click(mainSave);
    await waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(3));
    expect(writes[0]).toMatchObject({ provider: 'openrouter', apiKey: 'provider-secret' });
    expect(writes[2]).toMatchObject({ provider: 'custom' });
    expect(JSON.stringify(writes[2])).not.toContain('custom-secret');
    const mainSources = (writes[2]?.sources ?? []) as Array<Record<string, unknown>>;
    expect(mainSources.every((s) => !('apiKey' in s))).toBe(true);
  });

  it('adds a key draft and saves with appendKeys', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            openrouter: {
              enabled: true,
              hasKey: true,
              keyCount: 1,
              keyMeta: [{ id: 'k0', hint: '…abcd' }],
            },
          },
        }),
      ),
      http.post(`${gateway}/api/providers`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    expect(await screen.findByText('…abcd')).toBeTruthy();
    const providerKey = await screen.findByLabelText(/OpenRouter API Key/);
    const controls = providerKey.parentElement?.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '添加 Key' }));
    const input = screen.getByLabelText(/OpenRouter API Key/);
    await user.type(input, 'brand-new-key');
    await user.click(within(controls!).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0]).toMatchObject({
      provider: 'openrouter',
      appendKeys: ['brand-new-key'],
    });
    expect(writes[0]).not.toHaveProperty('apiKeys');
  });

  it('removes a saved provider key via removeKeyIndex', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            openrouter: {
              enabled: true,
              hasKey: true,
              keyCount: 1,
              keyMeta: [{ id: 'k0', hint: '…abcd' }],
            },
          },
        }),
      ),
      http.post(`${gateway}/api/providers`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    expect(await screen.findByText('…abcd')).toBeTruthy();
    const providerKey = await screen.findByLabelText(/OpenRouter API Key/);
    const controls = providerKey.parentElement?.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '删除 Key 1' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0]).toMatchObject({ provider: 'openrouter', removeKeyIndex: 0 });
  });

  it('removes a custom source key via removeSourceKey', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
      http.post(`${gateway}/api/providers`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    expect((await screen.findAllByText('…a1b2')).length).toBeGreaterThan(0);
    const customSection = screen.getByLabelText('自定义模型');
    await user.click(within(customSection).getByRole('button', { name: '删除 Key 1' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0]).toMatchObject({
      provider: 'custom',
      removeSourceKey: { sourceId: 'fixture-source', index: 0 },
    });
  });

  it('re-entry guard: double Enter produces a single appendKeys write', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            openrouter: {
              enabled: true,
              hasKey: true,
              keyCount: 1,
              keyMeta: [{ id: 'k0', hint: '…abcd' }],
            },
          },
        }),
      ),
      http.post(`${gateway}/api/providers`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    expect(await screen.findByText('…abcd')).toBeTruthy();
    const providerKey = await screen.findByLabelText(/OpenRouter API Key/);
    const controls = providerKey.parentElement?.parentElement;
    expect(controls).not.toBeNull();
    await user.type(providerKey, 'double-enter-key');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      provider: 'openrouter',
      appendKeys: ['double-enter-key'],
    });
  });

  it('generates and displays a gateway key', async () => {
    let gatewayLoaded = false;
    server.use(
      http.get(`${gateway}/api/gateway`, () => {
        gatewayLoaded = true;
        return HttpResponse.json({
          hasKey: false,
          apiKey: null,
          requireAuth: false,
          port: 11435,
        });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    await waitFor(() => expect(gatewayLoaded).toBe(true));
    const generate = await screen.findByRole('button', { name: '生成 API Key' });
    await user.click(generate);
    expect(await screen.findByRole('button', { name: '隐藏 Key' })).toBeTruthy();
    const gatewaySection = screen.getByLabelText('对外接口');
    expect(within(gatewaySection).getByRole('button', { name: '添加 Key' })).toBeTruthy();
  });

  it('shows the public URL and locks authentication controls in server mode', async () => {
    server.use(
      http.get(`${gateway}/api/gateway`, () =>
        HttpResponse.json({
          mode: 'server',
          hasKey: true,
          apiKey: 'fmf-server-key',
          requireAuth: true,
          authLocked: true,
          adminPort: 11435,
          gatewayPort: 11436,
          publicBaseUrl: 'https://192.0.2.10',
        }),
      ),
    );
    render(<SettingsView />);

    expect((await screen.findAllByText('https://192.0.2.10')).length).toBeGreaterThan(0);
    expect(screen.getByText(/当前管理地址仅供 Tailscale 使用/)).toBeTruthy();
    const auth = screen.getByRole('checkbox', { name: /强制鉴权/ });
    expect((auth as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
    expect(screen.getByText(/服务器模式已锁定/)).toBeTruthy();
  });
});
