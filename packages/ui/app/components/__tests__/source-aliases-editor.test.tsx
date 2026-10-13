import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { SourceAliasesEditor } from '../SourceAliasesEditor';
import { gateway, server } from '../../../test/server';

const SRC_MODELS = ['glm-5.3', 'qwen-8b'];
const TARGET_GL = 'custom:novay:glm-5.3';

function renderEditor(onChange?: (edits: unknown) => void) {
  return render(
    <SourceAliasesEditor
      sourceId="novay"
      sourceLabel="NovaWay"
      sourceModels={SRC_MODELS}
      onAliasesChange={(edits) => onChange?.(edits)}
    />,
  );
}

describe('SourceAliasesEditor', () => {
  it('hydrates sourceId/* entries from the global table', async () => {
    // Server-side residual entries back-fill the editor on load.
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({
          modelAliases: { 'novay/glm': TARGET_GL, 'other/x': 'custom:other:x' },
        }),
      ),
    );
    renderEditor();
    await waitFor(() => expect(screen.getByDisplayValue('glm')).toBeTruthy(), { timeout: 3000 });
    // Only the novay/ prefix back-fills rows; other/x does not appear.
    expect(screen.queryByDisplayValue('x')).toBeNull();
    expect(screen.getByDisplayValue('glm').tagName).toBe('INPUT');
  });

  it('locks the source prefix as read-only text and limits the target dropdown to this source', async () => {
    renderEditor();
    const user = userEvent.setup();
    // With no rows yet the prefix is never rendered as an editable value.
    expect(screen.queryByDisplayValue('novay/')).toBeNull();
    // Add a row so the read-only prefix and target dropdown render.
    await user.click(await screen.findByRole('button', { name: /添加别名/ }));
    // 'novay/' prefix is display text, not an editable input value.
    expect(screen.getByText('novay/')).toBeTruthy();
    expect(screen.queryByDisplayValue('novay/')).toBeNull();
    const select = screen.getByRole('combobox');
    const opts = Array.from(select.options).map((o) => o.value);
    expect(opts).toContain(TARGET_GL);
    expect(opts).toContain('custom:novay:qwen-8b');
    expect(opts).not.toContain('custom:other:x');
  });

  it('never reports alias names containing "/" or reserved words upward', async () => {
    const reports: unknown[] = [];
    renderEditor((edits) => reports.push(edits));
    const user = userEvent.setup();

    // "/" in the alias name: the row stays in the UI but is never reported.
    await user.click(await screen.findByRole('button', { name: /添加别名/ }));
    await user.type(screen.getByPlaceholderText(/别名名/), 'bad/name');
    expect(reports.flat().some((ed) => (ed as { alias?: string }).alias === 'bad/name')).toBe(
      false,
    );

    // Reserved word "auto" with a picked target: still not reported.
    await user.click(await screen.findByRole('button', { name: /添加别名/ }));
    await user.type(screen.getAllByPlaceholderText(/别名名/)[1], 'auto');
    await user.selectOptions(screen.getAllByRole('combobox')[1], TARGET_GL);
    expect(reports.flat().some((ed) => (ed as { alias?: string }).alias === 'auto')).toBe(false);

    // Every alias reported in any snapshot is prefix-free and non-reserved.
    for (const ed of reports.flat()) {
      const e = ed as { alias: string };
      expect(e.alias.includes('/')).toBe(false);
      expect(e.alias.includes(':')).toBe(false);
      expect(e.alias).not.toMatch(/^(auto|default)$/);
    }
  });

  it('reports valid edits upward on every row change', async () => {
    const reports: unknown[] = [];
    renderEditor((edits) => reports.push(edits));
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /添加别名/ }));
    await user.type(screen.getByPlaceholderText(/别名名/), 'glm');
    // Picking a target completes the row and reports it immediately.
    const select = screen.getByRole('combobox');
    select.value = TARGET_GL;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(
      () => {
        const flat = reports.flat() as Array<{ alias?: string; targetModel?: string }>;
        expect(flat.some((e) => e.alias === 'glm' && e.targetModel === 'glm-5.3')).toBe(true);
      },
      { timeout: 3000 },
    );

    // Removing the row reports the empty list.
    await user.click(screen.getByRole('button', { name: /删除别名/ }));
    await waitFor(() => {
      expect(reports.at(-1)).toEqual([]);
    });
  });

  it('shows the legacy-bare-alias migration hint only when bare entries exist', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({
          modelAliases: {
            legacy1: TARGET_GL,
            'novay/glm': TARGET_GL,
          },
        }),
      ),
    );
    renderEditor();
    await waitFor(() => expect(screen.getByText(/旧格式别名/)).toBeTruthy(), { timeout: 3000 });
  });

  it('omits the legacy hint when only source-scoped entries exist', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({
          modelAliases: { 'novay/glm': TARGET_GL },
        }),
      ),
    );
    renderEditor();
    await waitFor(() => expect(screen.getByDisplayValue('glm')).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByText(/旧格式别名/)).toBeNull();
  });

  it('reports hydrated rows after load without a user edit', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({ modelAliases: { 'novay/glm': TARGET_GL } }),
      ),
    );
    const reports: unknown[] = [];
    renderEditor((edits) => reports.push(edits));
    await waitFor(
      () => {
        const flat = reports.flat() as Array<{ alias?: string; targetModel?: string }>;
        expect(flat.some((e) => e.alias === 'glm' && e.targetModel === 'glm-5.3')).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it('does not refetch or clobber on a re-render with an equal-content model list', async () => {
    let calls = 0;
    server.use(
      http.get(`${gateway}/api/model-aliases`, () => {
        calls += 1;
        return HttpResponse.json({ modelAliases: { 'novay/glm': TARGET_GL } });
      }),
    );
    const user = userEvent.setup();
    const { rerender } = render(
      <SourceAliasesEditor
        sourceId="novay"
        sourceLabel="NovaWay"
        sourceModels={['glm-5.3', 'qwen-8b']}
        onAliasesChange={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByDisplayValue('glm')).toBeTruthy(), { timeout: 3000 });
    expect(calls).toBe(1);

    // Edit the hydrated row in place.
    const input = screen.getByDisplayValue('glm');
    await user.clear(input);
    await user.type(input, 'gpt');
    expect(screen.getByDisplayValue('gpt')).toBeTruthy();

    // NEW array identity, identical content; NEW inline callback identity.
    rerender(
      <SourceAliasesEditor
        sourceId="novay"
        sourceLabel="NovaWay"
        sourceModels={['glm-5.3', 'qwen-8b']}
        onAliasesChange={() => {}}
      />,
    );
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Content-keyed effect: no refetch, and the in-progress edit is untouched.
    expect(calls).toBe(1);
    expect(screen.getByDisplayValue('gpt')).toBeTruthy();
  });

  it('ignores invalid alias names during hydration', async () => {
    server.use(
      http.get(`${gateway}/api/model-aliases`, () =>
        HttpResponse.json({
          modelAliases: {
            'novay/bad/name': TARGET_GL,
            'novay/auto': 'custom:novay:qwen-8b',
          },
        }),
      ),
    );
    renderEditor();
    // The add button renders only after hydration completes; wait for it.
    await screen.findByRole('button', { name: /添加别名/ }, { timeout: 3000 });
    expect(screen.queryByDisplayValue('bad/name')).toBeNull();
    expect(screen.queryByDisplayValue('auto')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('trims alias names when reporting', async () => {
    const reports: unknown[] = [];
    renderEditor((edits) => reports.push(edits));
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /添加别名/ }));
    await user.type(screen.getByPlaceholderText(/别名名/), ' glm ');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    select.value = TARGET_GL;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(
      () => {
        const flat = reports.flat() as Array<{ alias?: string; targetModel?: string }>;
        expect(flat.some((e) => e.alias === 'glm' && e.targetModel === 'glm-5.3')).toBe(true);
      },
      { timeout: 3000 },
    );
    const flat = reports.flat() as Array<{ alias?: string }>;
    expect(flat.some((e) => e.alias === ' glm ')).toBe(false);
  });
});
