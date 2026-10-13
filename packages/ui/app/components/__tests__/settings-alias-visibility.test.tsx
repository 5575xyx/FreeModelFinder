import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { SettingsView } from '../SettingsView';
import { gateway, server } from '../../../test/server';

/**
 * Fixtures are chosen so the alias name `shorty` appears NOWHERE in any
 * id / provider / display name: an assertion on `shorty` can therefore only
 * pass via the alias plumbing, never by accidental substring overlap.
 */
const ALIAS = 'shorty';
const REAL_ID = 'nvidia:nvidia/nemotron-3-super-120b-a12b';
const ALIASES: Record<string, string> = { [ALIAS]: REAL_ID };

function serveNemotronModelOption(): void {
  server.use(
    http.get(`${gateway}/api/auto-route/model-options`, () =>
      HttpResponse.json({
        models: [{ id: REAL_ID, provider: 'nvidia', displayName: 'Nemotron 3 Super' }],
      }),
    ),
  );
}

function serveGatewayKey(): void {
  server.use(
    http.get(`${gateway}/api/gateway`, () =>
      HttpResponse.json({
        hasKey: true,
        apiKey: null,
        requireAuth: true,
        port: 11435,
        keys: [
          {
            id: 'k-a',
            label: '应用甲',
            key: 'fmf-k-a',
            createdAt: 1_700_000_000_000,
            expiresAt: null,
            dailyRequestLimit: null,
            dailyTokenLimit: null,
            modelAllowlist: [],
          },
        ],
      }),
    ),
  );
}

/** Opens the key's 「可用模型」 editor and returns its enclosing row. */
async function openAllowlistEditor(): Promise<HTMLElement> {
  const user = userEvent.setup();
  // findByRole waits for the gateway payload to land before clicking.
  await user.click(await screen.findByRole('button', { name: '配置可用模型' }));
  const row = screen.getByText('应用甲').closest('div.rounded-md') as HTMLElement;
  expect(row).not.toBeNull();
  await user.click(within(row).getByRole('button', { name: '可用模型' }));
  return row;
}

describe('alias visibility in the settings model pickers', () => {
  it('marks the aliased model in the current-model dropdown', () => {
    render(
      <SettingsView
        models={[
          {
            id: 'nvidia/nemotron-3-super-120b-a12b',
            provider: 'nvidia',
            display_name: 'Nemotron 3 Super',
          },
        ]}
        aliases={ALIASES}
      />,
    );

    const select = screen.getByRole('combobox', { name: '当前模型' });
    const option = within(select).getByRole('option');
    // `shorty` exists only in the alias map, so this can only pass via the marker.
    expect(option.textContent).toContain(ALIAS);
    // The value stays the composed REAL id — the marker is display-only.
    expect(option.getAttribute('value')).toBe(REAL_ID);
  });

  it('finds a model by its alias in the key allowlist search', async () => {
    serveNemotronModelOption();
    serveGatewayKey();
    const user = userEvent.setup();
    render(<SettingsView aliases={ALIASES} />);

    const row = await openAllowlistEditor();
    // Wait for the fetched option to be listed unfiltered first — this pins
    // the "options have loaded" precondition so the filter result is not a
    // loading race.
    await waitFor(() => expect(within(row).getByRole('option')).toBeTruthy());

    await user.type(within(row).getByRole('searchbox'), ALIAS);

    // The alias matches nothing in id/provider/displayName, so surviving the
    // filter can only happen through the alias-augmented option list.
    const option = await within(row).findByRole('option');
    expect(option.textContent).toContain(REAL_ID);
  });

  it('shows the empty state when the alias is not configured (negative control)', async () => {
    serveNemotronModelOption();
    serveGatewayKey();
    const user = userEvent.setup();
    render(<SettingsView aliases={{}} />);

    const row = await openAllowlistEditor();
    await waitFor(() => expect(within(row).getByRole('option')).toBeTruthy());

    await user.type(within(row).getByRole('searchbox'), ALIAS);

    // Same fixture, no alias: the alias string must match nothing.
    await waitFor(() => expect(within(row).getByText('无匹配模型')).toBeTruthy());
    expect(within(row).queryByRole('option')).toBeNull();
  });
});
