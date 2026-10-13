import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { SettingsView } from '../SettingsView';
import { gateway, server } from '../../../test/server';

type GatewayKeyInfo = {
  id: string;
  label: string;
  key: string;
  createdAt: number;
  expiresAt: null;
  dailyRequestLimit: null;
  dailyTokenLimit: null;
  modelAllowlist: string[];
};

function makeKey(id: string, label: string, modelAllowlist: string[]): GatewayKeyInfo {
  return {
    id,
    label,
    key: `fmf-${id}`,
    createdAt: 1_700_000_000_000,
    expiresAt: null,
    dailyRequestLimit: null,
    dailyTokenLimit: null,
    modelAllowlist,
  };
}

function serveGateway(keys: GatewayKeyInfo[]): GatewayKeyInfo[] {
  server.use(
    http.get(`${gateway}/api/gateway`, () =>
      HttpResponse.json({
        hasKey: true,
        apiKey: null,
        requireAuth: true,
        port: 11435,
        keys,
      }),
    ),
  );
  return keys;
}

/**
 * Records every POST /api/gateway body and echoes the key it just saved, so the
 * UI's optimistic fold-back has a real response to work from.
 */
function recordGatewaySaves(keys: GatewayKeyInfo[]): Array<Record<string, unknown>> {
  const saves: Array<Record<string, unknown>> = [];
  server.use(
    http.post(`${gateway}/api/gateway`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      saves.push(body);
      const id = typeof body.id === 'string' ? body.id : null;
      const modelAllowlist = Array.isArray(body.modelAllowlist)
        ? (body.modelAllowlist as string[])
        : null;
      return HttpResponse.json({
        ok: true,
        hasKey: true,
        apiKey: null,
        requireAuth: true,
        port: 11435,
        keys: keys.map((k) => (k.id === id && modelAllowlist ? { ...k, modelAllowlist } : k)),
      });
    }),
  );
  return saves;
}

function row(label: string): HTMLElement {
  const el = screen.getByText(label).closest('div.rounded-md');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

async function waitForRows(min = 1): Promise<void> {
  await waitFor(() => {
    const buttons = screen.getAllByRole('button', { name: '配置可用模型' });
    expect(buttons.length).toBeGreaterThanOrEqual(min);
  });
}

describe('per-key model allowlist in the gateway settings', () => {
  it('shows the allowed count, or all models when none are configured', async () => {
    serveGateway([makeKey('k-a', '应用甲', []), makeKey('k-b', '应用乙', ['custom:fx:fast'])]);
    render(<SettingsView aliases={{}} />);
    await waitForRows(2);

    // [] and absent are the same thing: unrestricted.
    expect(within(row('应用甲')).getByText('可用模型: 全部')).toBeTruthy();
    expect(within(row('应用乙')).getByText('可用模型: 1')).toBeTruthy();
  });

  it('saves an allowlist from the editor using action update', async () => {
    const user = userEvent.setup();
    const saves = recordGatewaySaves([makeKey('k-a', '应用甲', [])]);
    serveGateway([makeKey('k-a', '应用甲', [])]);
    render(<SettingsView aliases={{}} />);
    await waitForRows();

    const r = row('应用甲');
    await user.click(within(r).getByRole('button', { name: '配置可用模型' }));
    const trigger = within(r).getByRole('button', { name: '可用模型' });
    await user.click(trigger);
    await user.click(within(r).getByText('custom:fixture:chat-1'));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves[0]).toMatchObject({
      action: 'update',
      id: 'k-a',
      modelAllowlist: ['custom:fixture:chat-1'],
    });

    // The count follows the save, so the restriction is visible at a glance.
    await waitFor(() => expect(within(r).getByText('可用模型: 1')).toBeTruthy());
  });

  it('sends an empty array when the restriction is cleared', async () => {
    const user = userEvent.setup();
    const saves = recordGatewaySaves([makeKey('k-b', '应用乙', ['custom:fx:fast'])]);
    serveGateway([makeKey('k-b', '应用乙', ['custom:fx:fast'])]);
    render(<SettingsView aliases={{}} />);
    await waitForRows();

    const r = row('应用乙');
    await user.click(within(r).getByRole('button', { name: '配置可用模型' }));
    await user.click(within(r).getByText('清空'));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    // The whole point: [] is a real "lift the restriction", not an omitted field.
    expect(saves[0]).toMatchObject({ action: 'update', id: 'k-b', modelAllowlist: [] });
    await waitFor(() => expect(within(r).getByText('可用模型: 全部')).toBeTruthy());
  });

  it('editing one key leaves the others untouched', async () => {
    const user = userEvent.setup();
    const keys = [makeKey('k-a', '应用甲', []), makeKey('k-b', '应用乙', ['custom:fx:fast'])];
    const saves = recordGatewaySaves(keys);
    serveGateway(keys);
    render(<SettingsView aliases={{}} />);
    await waitForRows(2);

    const a = row('应用甲');
    await user.click(within(a).getByRole('button', { name: '配置可用模型' }));
    await user.click(within(a).getByRole('button', { name: '可用模型' }));
    await user.click(within(a).getByText('custom:fixture:chat-1'));

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves.every((s) => s.id === 'k-a')).toBe(true);

    // Only one editor is open at a time, and key B still has its own list.
    expect(
      within(a).getByRole('button', { name: '配置可用模型' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      within(row('应用乙'))
        .getByRole('button', { name: '配置可用模型' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    expect(within(row('应用乙')).getByText('可用模型: 1')).toBeTruthy();
  });
});
