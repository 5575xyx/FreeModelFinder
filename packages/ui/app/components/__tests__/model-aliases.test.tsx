import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ModelAliasesSection } from '../ModelAliasesSection';
import { gateway, server } from '../../../test/server';

describe('ModelAliasesSection', () => {
  it('renders existing aliases returned by the gateway', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { 'my-model': 'custom:fx:fast' } }),
      ),
    );
    render(<ModelAliasesSection />);

    await userEvent.click(await screen.findByRole('button', { name: /模型别名/ }));
    await waitFor(() => expect(screen.getByDisplayValue('my-model')).toBeTruthy());
    expect((screen.getByDisplayValue('my-model') as HTMLInputElement).value).toBe('my-model');
  });

  it('adds a row, fills it and posts the whole map', async () => {
    const writes: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
      http.post(`${gateway}/api/model-aliases`, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true, modelAliases: { 'my-model': 'custom:fx:fast' } });
      }),
    );
    const user = userEvent.setup();
    render(<ModelAliasesSection />);

    await user.click(await screen.findByRole('button', { name: /模型别名/ }));
    await user.click(await screen.findByRole('button', { name: '添加别名' }));

    await user.type(await screen.findByPlaceholderText('别名（如 my-model）'), 'my-model');
    await user.selectOptions(await screen.findByRole('combobox'), 'custom:fx:fast');
    await user.click(screen.getByRole('button', { name: '保存别名' }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toEqual({ modelAliases: { 'my-model': 'custom:fx:fast' } });
  });

  it('surfaces the server validation error inline', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () => HttpResponse.json({ modelAliases: {} })),
      http.post(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ error: 'alias "x" is reserved' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    render(<ModelAliasesSection />);

    await user.click(await screen.findByRole('button', { name: /模型别名/ }));
    await user.click(await screen.findByRole('button', { name: '添加别名' }));
    await user.type(await screen.findByPlaceholderText('别名（如 my-model）'), 'x');
    await user.click(screen.getByRole('button', { name: '保存别名' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('reserved');
  });

  it('removes a row without saving', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { 'my-model': 'custom:fx:fast' } }),
      ),
    );
    const user = userEvent.setup();
    render(<ModelAliasesSection />);

    await user.click(await screen.findByRole('button', { name: /模型别名/ }));
    await user.click(await screen.findByRole('button', { name: '删除别名' }));

    await waitFor(() => expect(screen.queryByDisplayValue('my-model')).toBeNull());
  });
});
