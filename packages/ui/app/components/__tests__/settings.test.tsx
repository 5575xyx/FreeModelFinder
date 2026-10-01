import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../SettingsView';
import { matchesCapability, type ModelOption } from '../ModelMultiSelect';
import { configPayload, gateway, server } from '../../../test/server';

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');

function override(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
}

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    delete (target as Record<string, unknown>)[key];
  }
}

function recordExecCommand(succeeds: boolean): Array<string | null> {
  const staged: Array<string | null> = [];
  override(
    document,
    'execCommand',
    vi.fn((command: string) => {
      const area = Array.from(document.querySelectorAll('textarea')).find(
        (el) => el.readOnly && el.style.position === 'fixed',
      );
      if (command === 'copy') staged.push(area?.value ?? null);
      return command === 'copy' && succeeds;
    }),
  );
  return staged;
}

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
    expect(writes[0]).toMatchObject({ provider: 'openrouter', apiKey: 'provider-secret' });
    expect(writes[1]).toMatchObject({
      provider: 'custom',
      appendSourceKeys: { sourceId: 'fixture-source', keys: ['custom-secret'] },
    });
  });

  it('main save also flushes pending source key drafts', async () => {
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
    const sourceKey = await screen.findByPlaceholderText(/粘贴 API Key（本地无鉴权可留空）/);
    await user.type(sourceKey, 'flush-me-key');
    const mainSave = await screen.findByRole(
      'button',
      { name: '保存自定义模型' },
      { timeout: 5000 },
    );
    await user.click(mainSave);
    await waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(2));
    expect(writes[0]).toMatchObject({ provider: 'custom' });
    expect(JSON.stringify(writes[0])).not.toContain('flush-me-key');
    const mainSources = (writes[0]?.sources ?? []) as Array<Record<string, unknown>>;
    expect(mainSources.length).toBeGreaterThan(0);
    expect(mainSources.every((s) => !('apiKey' in s))).toBe(true);
    expect(writes[1]).toMatchObject({
      provider: 'custom',
      appendSourceKeys: { sourceId: 'fixture-source', keys: ['flush-me-key'] },
    });
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

  it('removes one saved proxy via removeProxyIndex', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            opencode: {
              enabled: true,
              hasKey: true,
              anonymous: true,
              proxyCount: 2,
              proxyMeta: [
                { id: 'p0', hint: 'http://***@a:1/' },
                { id: 'p1', hint: 'http://***@b:2/' },
              ],
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
    const row = await screen.findByText('http://***@a:1/');
    const controls = row.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '删除代理 1' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0]).toMatchObject({ provider: 'opencode', removeProxyIndex: 0 });
  });

  it('clears the whole proxy list with an empty array', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            opencode: {
              enabled: true,
              hasKey: true,
              anonymous: true,
              proxyCount: 1,
              proxyMeta: [{ id: 'p0', hint: 'direct' }],
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
    await user.click(await screen.findByRole('button', { name: '清空全部' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0]).toMatchObject({ provider: 'opencode', extra: { proxies: [] } });
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

  it('filters the image multi-select by image capability', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const trigger = await screen.findByRole('button', { name: '图片生成模型' });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox', { name: '图片生成模型' });
    expect(await within(listbox).findByText('custom:fixture:img-a')).toBeTruthy();
    expect(within(listbox).queryByText('custom:fixture:vid-a')).toBeNull();
    expect(within(listbox).queryByText('custom:fixture:chat-1')).toBeNull();
    expect(within(listbox).queryByText('custom:fixture:legacy')).toBeNull();
  });

  it('text tier multi-select hides pure image models and shows text/legacy', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    const trigger = await screen.findByRole('button', {
      name: '⚡ 简单（问候/翻译/简答）',
    });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox', {
      name: '⚡ 简单（问候/翻译/简答）',
    });
    expect(await within(listbox).findByText('custom:fixture:chat-1')).toBeTruthy();
    expect(within(listbox).getByText('custom:fixture:legacy')).toBeTruthy();
    expect(within(listbox).queryByText('custom:fixture:img-a')).toBeNull();
  });

  it('selecting an image option POSTs an array payload to /api/auto-route', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
      http.post(`${gateway}/api/auto-route`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    const trigger = await screen.findByRole('button', { name: '图片生成模型' });
    await user.click(trigger);
    const option = await screen.findByRole('option', { name: /custom:fixture:img-a/ });
    await user.click(within(option).getByRole('button'));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const body = writes.at(-1)!;
    expect(Array.isArray(body.imageModel)).toBe(true);
    expect(body.imageModel).toContain('custom:fixture:img-a');
  });

  it('clear on image multi-select POSTs an empty array', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
      http.post(`${gateway}/api/auto-route`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    expect(await screen.findByText('custom:img')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '清空' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0]).toMatchObject({ imageModel: [] });
  });

  it('renders the vision model multi-select in the modality card', async () => {
    render(<SettingsView />);
    expect(await screen.findByRole('button', { name: '视觉理解模型' })).toBeTruthy();
  });

  it('selecting a vision option POSTs visionModel to /api/auto-route', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
      http.post(`${gateway}/api/auto-route`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    const trigger = await screen.findByRole('button', { name: '视觉理解模型' });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox', { name: '视觉理解模型' });
    expect(within(listbox).queryByText('custom:fixture:chat-1')).toBeNull();
    const option = await screen.findByRole('option', { name: /custom:fixture:mm-chat/ });
    await user.click(within(option).getByRole('button'));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes.at(-1)!.visionModel).toContain('custom:fixture:mm-chat');
  });

  it('renders a permanent cooldown as 永久剔除 instead of Invalid Date', async () => {
    server.use(
      http.get(`${gateway}/api/config`, () => HttpResponse.json(configPayload)),
      http.get(`${gateway}/api/auto-route`, () =>
        HttpResponse.json({
          enabled: true,
          strategy: 'capability',
          fallbackChain: [],
          imageModel: [],
          videoModel: [],
          visionModel: [],
          textTiers: { simple: [], medium: [], complex: [] },
          cooldowns: [
            { model: 'custom:fixture:dead', provider: 'custom', resetAt: null },
            { model: 'custom:fixture:slow', provider: 'custom', resetAt: 1_700_000_000_000 },
          ],
          recentNotices: [],
        }),
      ),
    );
    render(<SettingsView />);
    expect(await screen.findByText(/永久剔除/)).toBeTruthy();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
    expect(screen.getAllByText(/^重置：/).length).toBe(2);
  });

  it('marks the opencode card configured when anonymous is on without keys', async () => {
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            opencode: { enabled: true, hasKey: false, anonymous: true, keyCount: 0, keyMeta: [] },
          },
        }),
      ),
    );
    render(<SettingsView />);
    await screen.findByText('…a1b2');
    const card = screen.getByTestId('provider-card-opencode');
    await waitFor(() => expect(within(card).getByText('已配置')).toBeTruthy());
    expect(within(card).queryByText('未配置')).toBeNull();
  });

  it('anonymous toggle enables opencode without keys', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            opencode: { enabled: false, hasKey: false, anonymous: false, keyCount: 0, keyMeta: [] },
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
    await screen.findByText('…a1b2');
    const card = screen.getByTestId('provider-card-opencode');
    await user.click(within(card).getByRole('checkbox', { name: '匿名通道' }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0]).toMatchObject({
      provider: 'opencode',
      enabled: true,
      extra: { anonymous: true },
    });
  });

  it('saving opencode with anonymous and no keys is not blocked', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            opencode: { enabled: true, hasKey: false, anonymous: true, keyCount: 0, keyMeta: [] },
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
    await screen.findByText('…a1b2');
    const card = screen.getByTestId('provider-card-opencode');
    const save = within(card).getByRole('button', { name: '保存' });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    await user.click(save);
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0]).toMatchObject({ provider: 'opencode', enabled: true });
    expect(writes[0]).not.toHaveProperty('apiKey');
  });
});

describe('SettingsView copy buttons', () => {
  afterEach(() => {
    restore(navigator, 'clipboard', clipboardDescriptor);
    restore(document, 'execCommand', execCommandDescriptor);
  });

  it('copies the base URL through execCommand when the clipboard API is unavailable', async () => {
    const user = userEvent.setup();
    override(navigator, 'clipboard', undefined);
    const staged = recordExecCommand(true);
    render(<SettingsView />);

    await user.click(await screen.findByRole('button', { name: '复制 Base URL' }));

    expect(staged).toEqual([gateway]);
    const button = screen.getByRole('button', { name: '复制 Base URL' });
    expect(button.querySelector('svg.text-success')).not.toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('warns only after the clipboard API and execCommand have both failed', async () => {
    const user = userEvent.setup();
    override(navigator, 'clipboard', { writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const staged = recordExecCommand(false);
    render(<SettingsView />);

    await user.click(await screen.findByRole('button', { name: '复制 Base URL' }));

    expect(staged).toEqual([gateway]);
    expect(await screen.findByText('复制失败，请手动选中复制')).toBeTruthy();
  });

  it('reveals one saved key on demand without shipping plaintext in /api/config', async () => {
    const user = userEvent.setup();
    const reveals: Array<Record<string, unknown>> = [];
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
              keyMeta: [{ id: 'k0', hint: '…wxyz' }],
            },
          },
        }),
      ),
      http.post(`${gateway}/api/providers/reveal`, async ({ request }) => {
        reveals.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ value: 'sk-revealed-value' });
      }),
    );
    render(<SettingsView />);

    const hint = await screen.findByText('…wxyz');
    expect(JSON.stringify(configPayload)).not.toContain('sk-revealed-value');
    const controls = hint.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '显示 Key' }));

    expect(await screen.findByText('sk-revealed-value')).toBeTruthy();
    expect(reveals[0]).toMatchObject({ provider: 'openrouter', kind: 'key', index: 0 });

    await user.click(within(controls!).getByRole('button', { name: '隐藏 Key' }));
    expect(screen.queryByText('sk-revealed-value')).toBeNull();
  });

  it('copies a saved key without flipping the row to revealed', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    override(navigator, 'clipboard', { writeText });
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
              keyMeta: [{ id: 'k0', hint: '…wxyz' }],
            },
          },
        }),
      ),
      http.post(`${gateway}/api/providers/reveal`, () =>
        HttpResponse.json({ value: 'sk-copy-me' }),
      ),
    );
    render(<SettingsView />);

    const hint = await screen.findByText('…wxyz');
    const controls = hint.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '复制 API Key' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('sk-copy-me'));
    expect(screen.queryByText('sk-copy-me')).toBeNull();
    expect(within(controls!).getByRole('button', { name: '显示 Key' })).toBeTruthy();
  });

  it('drops a cached plaintext once a delete renumbers the remaining key rows', async () => {
    const user = userEvent.setup();
    let removed = false;
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json({
          ...configPayload,
          providers: {
            ...configPayload.providers,
            openrouter: {
              enabled: true,
              hasKey: true,
              keyCount: removed ? 1 : 2,
              keyMeta: removed
                ? [{ id: 'k0', hint: '…2222' }]
                : [
                    { id: 'k0', hint: '…1111' },
                    { id: 'k1', hint: '…2222' },
                  ],
            },
          },
        }),
      ),
      http.post(`${gateway}/api/providers/reveal`, () =>
        HttpResponse.json({ value: 'sk-plaintext-1' }),
      ),
      http.post(`${gateway}/api/providers`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.removeKeyIndex === 0) removed = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    render(<SettingsView />);

    const first = await screen.findByText('…1111');
    const controls = first.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '显示 Key' }));
    expect(await screen.findByText('sk-plaintext-1')).toBeTruthy();

    await user.click(within(controls!).getByRole('button', { name: '删除 Key 1' }));

    await waitFor(() => expect(screen.queryByText('sk-plaintext-1')).toBeNull());
    expect(await screen.findByText('…2222')).toBeTruthy();
  });

  const sourceConfig = (keyMeta: Array<{ id: string; hint: string }>) => ({
    ...configPayload,
    custom: {
      ...configPayload.custom,
      sources: [{ ...configPayload.custom.sources[0], keyMeta }],
    },
  });

  it('reveals one custom source key on demand and addresses it by sourceId', async () => {
    const user = userEvent.setup();
    const reveals: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json(sourceConfig([{ id: 'k0', hint: '…9xyz' }])),
      ),
      http.post(`${gateway}/api/providers/reveal`, async ({ request }) => {
        reveals.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ value: 'sk-source-plaintext' });
      }),
    );
    render(<SettingsView />);

    const customSection = await screen.findByLabelText('自定义模型');
    const hint = await within(customSection).findByText('…9xyz');
    const controls = hint.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '显示 Key' }));

    expect(await within(customSection).findByText('sk-source-plaintext')).toBeTruthy();
    expect(reveals[0]).toMatchObject({
      provider: 'custom',
      kind: 'key',
      sourceId: 'fixture-source',
      index: 0,
    });
    expect(JSON.stringify(configPayload)).not.toContain('sk-source-plaintext');

    await user.click(within(controls!).getByRole('button', { name: '隐藏 Key' }));
    expect(within(customSection).queryByText('sk-source-plaintext')).toBeNull();
  });

  it('copies a custom source key without flipping the row to revealed', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    override(navigator, 'clipboard', { writeText });
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json(sourceConfig([{ id: 'k0', hint: '…9xyz' }])),
      ),
      http.post(`${gateway}/api/providers/reveal`, () =>
        HttpResponse.json({ value: 'sk-source-copy' }),
      ),
    );
    render(<SettingsView />);

    const customSection = await screen.findByLabelText('自定义模型');
    const hint = await within(customSection).findByText('…9xyz');
    const controls = hint.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '复制 API Key' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('sk-source-copy'));
    expect(within(customSection).queryByText('sk-source-copy')).toBeNull();
    expect(within(controls!).getByRole('button', { name: '显示 Key' })).toBeTruthy();
  });

  it('drops a cached custom source plaintext once a delete renumbers the rows', async () => {
    const user = userEvent.setup();
    let removed = false;
    server.use(
      http.get(`${gateway}/api/config`, () =>
        HttpResponse.json(
          sourceConfig(
            removed
              ? [{ id: 'k0', hint: '…2222' }]
              : [
                  { id: 'k0', hint: '…1111' },
                  { id: 'k1', hint: '…2222' },
                ],
          ),
        ),
      ),
      http.post(`${gateway}/api/providers/reveal`, () =>
        HttpResponse.json({ value: 'sk-src-first' }),
      ),
      http.post(`${gateway}/api/providers`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.removeSourceKey) removed = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    render(<SettingsView />);

    const customSection = await screen.findByLabelText('自定义模型');
    const first = await within(customSection).findByText('…1111');
    const controls = first.parentElement;
    expect(controls).not.toBeNull();
    await user.click(within(controls!).getByRole('button', { name: '显示 Key' }));
    expect(await within(customSection).findByText('sk-src-first')).toBeTruthy();

    await user.click(within(controls!).getByRole('button', { name: '删除 Key 1' }));

    await waitFor(() => expect(within(customSection).queryByText('sk-src-first')).toBeNull());
    expect(await within(customSection).findByText('…2222')).toBeTruthy();
  });
});

const SHORT_GATEWAY_KEY = 'key-a';
const LONG_GATEWAY_KEY = 'fmf_live_0123456789abcdef0123456789abcdef0123456789';

function gatewayKeyRow(label: string): HTMLElement {
  const row = screen.getByText(label).closest('div.rounded-md');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function gatewayKeyMask(label: string): string {
  return within(gatewayKeyRow(label)).getByText(/^•+$/).textContent ?? '';
}

describe('gateway key masking', () => {
  it('masks short and long keys to the same length so the key length cannot be read off', async () => {
    expect(SHORT_GATEWAY_KEY.length).toBeLessThan(36);
    expect(LONG_GATEWAY_KEY.length).toBeGreaterThan(36);
    server.use(
      http.get(`${gateway}/api/gateway`, () =>
        HttpResponse.json({
          hasKey: true,
          apiKey: null,
          requireAuth: true,
          port: 11435,
          keys: [
            {
              id: 'k-short',
              label: '短钥匙',
              key: SHORT_GATEWAY_KEY,
              createdAt: 1_700_000_000_000,
              expiresAt: null,
              dailyRequestLimit: null,
              dailyTokenLimit: null,
            },
            {
              id: 'k-long',
              label: '长钥匙',
              key: LONG_GATEWAY_KEY,
              createdAt: 1_700_000_000_000,
              expiresAt: null,
              dailyRequestLimit: null,
              dailyTokenLimit: null,
            },
          ],
        }),
      ),
    );
    render(<SettingsView />);

    await screen.findAllByText(/^•+$/);
    expect(gatewayKeyMask('短钥匙')).toBe('•'.repeat(36));
    expect(gatewayKeyMask('长钥匙')).toBe('•'.repeat(36));
    expect(gatewayKeyMask('短钥匙')).toBe(gatewayKeyMask('长钥匙'));
    expect(within(gatewayKeyRow('短钥匙')).queryByText(SHORT_GATEWAY_KEY)).toBeNull();
    expect(within(gatewayKeyRow('长钥匙')).queryByText(LONG_GATEWAY_KEY)).toBeNull();
  });

  it('keeps the mask fixed width after the reveal toggle round-trips', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${gateway}/api/gateway`, () =>
        HttpResponse.json({
          hasKey: true,
          apiKey: null,
          requireAuth: true,
          port: 11435,
          keys: [
            {
              id: 'k-short',
              label: '短钥匙',
              key: SHORT_GATEWAY_KEY,
              createdAt: 1_700_000_000_000,
              expiresAt: null,
              dailyRequestLimit: null,
              dailyTokenLimit: null,
            },
          ],
        }),
      ),
    );
    render(<SettingsView />);

    const row = () => gatewayKeyRow('短钥匙');
    await waitFor(() =>
      expect(within(row()).getByRole('button', { name: '显示 Key' })).toBeTruthy(),
    );
    await user.click(within(row()).getByRole('button', { name: '显示 Key' }));
    expect(within(row()).getByText(SHORT_GATEWAY_KEY)).toBeTruthy();

    await user.click(within(row()).getByRole('button', { name: '隐藏 Key' }));
    expect(gatewayKeyMask('短钥匙')).toBe('•'.repeat(36));
  });
});

describe('matchesCapability', () => {
  const legacy: ModelOption = { id: 'custom:fixture:legacy', provider: 'custom' };
  const imageByName: ModelOption = { id: 'custom:image-gen', provider: 'custom' };

  it('empty caps: image filter uses id regex fallback', () => {
    expect(matchesCapability(legacy, 'image')).toBe(false);
    expect(matchesCapability(imageByName, 'image')).toBe(true);
  });

  it('text filter accepts multimodal text+image models', () => {
    const multi: ModelOption = {
      id: 'custom:m1',
      provider: 'custom',
      capabilities: ['text', 'image'],
    };
    expect(matchesCapability(multi, 'text')).toBe(true);
  });

  it('text filter rejects pure image models', () => {
    const pureImage: ModelOption = {
      id: 'custom:i1',
      provider: 'custom',
      capabilities: ['image'],
    };
    expect(matchesCapability(pureImage, 'text')).toBe(false);
  });

  it('no filter matches everything', () => {
    expect(matchesCapability(legacy)).toBe(true);
  });

  it('empty caps text filter: image/video-like names excluded, neutral kept', () => {
    expect(matchesCapability({ id: 'custom:x:sora-image', provider: 'custom' }, 'text')).toBe(
      false,
    );
    expect(matchesCapability({ id: 'custom:x:legacy', provider: 'custom' }, 'text')).toBe(true);
    expect(matchesCapability({ id: 'custom:x:video-clip', provider: 'custom' }, 'text')).toBe(
      false,
    );
  });

  it('image filter: hasCaps takes priority over name', () => {
    expect(
      matchesCapability(
        { id: 'custom:x:image-gen', provider: 'custom', capabilities: ['text'] },
        'image',
      ),
    ).toBe(false);
    expect(
      matchesCapability(
        { id: 'custom:x:mystery', provider: 'custom', capabilities: ['image'] },
        'image',
      ),
    ).toBe(true);
  });

  it('video filter: empty caps falls back to name regex', () => {
    expect(matchesCapability({ id: 'custom:x:movie-video', provider: 'custom' }, 'video')).toBe(
      true,
    );
    expect(matchesCapability({ id: 'custom:x:plain-chat', provider: 'custom' }, 'video')).toBe(
      false,
    );
  });

  it('video filter: hasCaps checks video capability', () => {
    expect(
      matchesCapability(
        { id: 'custom:x:v1', provider: 'custom', capabilities: ['video'] },
        'video',
      ),
    ).toBe(true);
    expect(
      matchesCapability(
        { id: 'custom:x:i1', provider: 'custom', capabilities: ['image'] },
        'video',
      ),
    ).toBe(false);
  });

  it('vision filter trusts the backend vision tag', () => {
    expect(
      matchesCapability({ id: 'custom:x:sora-image', provider: 'custom', vision: true }, 'vision'),
    ).toBe(true);
    expect(
      matchesCapability({ id: 'custom:x:plain-chat', provider: 'custom', vision: false }, 'vision'),
    ).toBe(false);
    expect(
      matchesCapability({ id: 'custom:x:llava-7b', provider: 'custom', vision: false }, 'vision'),
    ).toBe(false);
  });

  it('vision filter falls back to id regex when untagged', () => {
    expect(matchesCapability({ id: 'custom:x:llava-7b', provider: 'custom' }, 'vision')).toBe(true);
    expect(matchesCapability({ id: 'custom:x:plain-chat', provider: 'custom' }, 'vision')).toBe(
      false,
    );
    expect(
      matchesCapability(
        { id: 'custom:x:mm', provider: 'custom', displayName: 'Vision Chat' },
        'vision',
      ),
    ).toBe(true);
  });
});
