import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModelMultiSelect, type ModelOption } from '../ModelMultiSelect';

const OPTIONS: ModelOption[] = [
  { id: 'nvidia:nemotron', provider: 'nvidia', displayName: 'Nemotron', alias: 'nemotron' },
  { id: 'openrouter:gpt-4o-mini', provider: 'openrouter', displayName: 'GPT-4o Mini' },
];

// Fields deliberately share no substrings with the second option, so each
// query below can only match through one specific field.
const UNIQUE_FIELD_OPTIONS: ModelOption[] = [
  { id: 'custom:fx:chat', provider: 'moonshot', displayName: 'Kelvin', alias: 'thermal' },
  { id: 'openrouter:gpt-4o-mini', provider: 'openrouter', displayName: 'GPT-4o Mini' },
];

const LABEL = '可用模型';

/** Controlled harness: selection state flows back like in real parents. */
function renderSelect(initial: { value?: string[]; options?: ModelOption[] } = {}) {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial.value ?? []);
    const handleChange = (next: string[]) => {
      onChange(next);
      setValue(next);
    };
    return (
      <ModelMultiSelect
        label={LABEL}
        value={value}
        onChange={handleChange}
        options={initial.options ?? OPTIONS}
      />
    );
  }
  render(<Harness />);
  return { onChange };
}

async function openPanel() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: LABEL }));
  return user;
}

const listbox = () => screen.getByRole('listbox');
const option = (id: string) => within(listbox()).queryByText(id);
const optionCount = () => within(listbox()).queryAllByRole('option').length;

describe('ModelMultiSelect search box', () => {
  it('renders a named search box above the listbox when open, hidden when closed', async () => {
    renderSelect();
    expect(screen.queryByRole('searchbox')).toBeNull();
    const user = await openPanel();
    const search = screen.getByRole('searchbox', { name: LABEL });
    expect(search).toHaveAttribute('placeholder', '搜索模型…');
    // The search box must be a sibling of the listbox, not a child (a11y tree).
    expect(listbox().contains(search)).toBe(false);
    expect(optionCount()).toBe(2);
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('narrows by id / display name as a case-insensitive substring', async () => {
    renderSelect();
    const user = await openPanel();
    await user.type(screen.getByRole('searchbox'), 'gpt');
    expect(option('openrouter:gpt-4o-mini')).toBeTruthy();
    expect(option('nvidia:nemotron')).toBeNull();
    expect(optionCount()).toBe(1);
  });

  it('narrows by provider', async () => {
    renderSelect();
    const user = await openPanel();
    await user.type(screen.getByRole('searchbox'), 'nvidia');
    expect(option('nvidia:nemotron')).toBeTruthy();
    expect(option('openrouter:gpt-4o-mini')).toBeNull();
  });

  it('narrows by alias', async () => {
    renderSelect();
    const user = await openPanel();
    await user.type(screen.getByRole('searchbox'), 'nemotron');
    expect(option('nvidia:nemotron')).toBeTruthy();
    expect(option('openrouter:gpt-4o-mini')).toBeNull();
  });

  it('matches each field in isolation when only that field contains the query', async () => {
    renderSelect({ options: UNIQUE_FIELD_OPTIONS });
    const user = await openPanel();
    const search = screen.getByRole('searchbox');
    for (const [q, expected] of [
      ['custom:fx:chat', 'custom:fx:chat'], // id
      ['kelvin', 'custom:fx:chat'], // displayName
      ['moonshot', 'custom:fx:chat'], // provider
      ['thermal', 'custom:fx:chat'], // alias
      ['gpt', 'openrouter:gpt-4o-mini'], // control: the other option still matches
    ] as const) {
      await user.clear(search);
      await user.type(search, q);
      expect(optionCount(), `query "${q}"`).toBe(1);
      expect(option(expected), `query "${q}"`).toBeTruthy();
    }
  });

  it('shows the empty state when the query excludes everything', async () => {
    renderSelect();
    const user = await openPanel();
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('无匹配模型')).toBeTruthy();
    expect(optionCount()).toBe(0);
  });

  it('treats an empty or whitespace-only query as no filter (Review Focus #5)', async () => {
    renderSelect();
    const user = await openPanel();
    const search = screen.getByRole('searchbox');
    await user.type(search, '   ');
    expect(screen.queryByText('无匹配模型')).toBeNull();
    expect(optionCount()).toBe(2);
    expect(option('nvidia:nemotron')).toBeTruthy();
    expect(option('openrouter:gpt-4o-mini')).toBeTruthy();
    // Clearing the query restores the full list as well.
    await user.clear(search);
    expect(optionCount()).toBe(2);
  });

  it('resets the query when the dropdown closes and reopens', async () => {
    renderSelect();
    const user = await openPanel();
    const search = screen.getByRole('searchbox');
    await user.type(search, 'gpt');
    expect(optionCount()).toBe(1);
    await user.click(screen.getByRole('button', { name: LABEL }));
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(optionCount()).toBe(2);
  });

  it('resets the query and reports an empty selection when 清空 is clicked', async () => {
    const { onChange } = renderSelect({ value: ['nvidia:nemotron'] });
    const user = await openPanel();
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('无匹配模型')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '清空' }));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(screen.queryByText('无匹配模型')).toBeNull();
    expect(optionCount()).toBe(2);
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });

  it('keeps the panel open while typing in the search box', async () => {
    renderSelect();
    const user = await openPanel();
    await user.type(screen.getByRole('searchbox'), 'gpt');
    expect(screen.getByRole('searchbox')).toBeTruthy();
    expect(option('openrouter:gpt-4o-mini')).toBeTruthy();
  });
});
