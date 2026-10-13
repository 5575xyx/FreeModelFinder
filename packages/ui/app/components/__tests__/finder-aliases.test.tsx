import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FinderView } from '../FinderView';
import type { ModelItem } from '../../lib/models';

// `/v1/models` reports an aliased model with the alias as `id` and the real
// native id in `alias_of` — so `modelValue` is the only correct alias target.
const ALIASED: ModelItem = {
  id: 'nemotron',
  provider: 'nvidia',
  display_name: 'Nemotron',
  alias_of: 'nvidia/nemotron-3-super-120b-a12b',
};
const PLAIN: ModelItem = {
  id: 'gpt-4o-mini',
  provider: 'openrouter',
  display_name: 'GPT-4o Mini',
};

const ALIASED_TARGET = 'nvidia:nvidia/nemotron-3-super-120b-a12b';
const PLAIN_TARGET = 'openrouter:gpt-4o-mini';

function renderFinder(overrides: { aliases?: Record<string, string> } = {}) {
  const onSaveAlias = vi.fn(async () => {});
  render(
    <FinderView
      models={[ALIASED, PLAIN]}
      selectedModel=""
      gatewayReachable
      loading={false}
      failures={[]}
      onSelectModel={vi.fn()}
      onOpenTester={vi.fn()}
      onOpenSettings={vi.fn()}
      onRefresh={vi.fn()}
      onProbeModel={vi.fn()}
      probingModels={[]}
      aliases={overrides.aliases ?? {}}
      onSaveAlias={onSaveAlias}
    />,
  );
  return { onSaveAlias };
}

function cardOf(heading: string): HTMLElement {
  const headingElement = screen.getByRole('heading', { name: heading });
  return headingElement.closest('article') as HTMLElement;
}

describe('FinderView alias editing', () => {
  it('shows each model alias in its card and leaves unaliased cards empty', () => {
    renderFinder({ aliases: { nemotron: ALIASED_TARGET } });

    expect(
      (within(cardOf('Nemotron')).getByPlaceholderText(/nemotron/) as HTMLInputElement).value,
    ).toBe('nemotron');
    expect(
      (within(cardOf('GPT-4o Mini')).getByPlaceholderText(/nemotron/) as HTMLInputElement).value,
    ).toBe('');
  });

  it('saves a new alias from a plain card with the composed model id', async () => {
    const { onSaveAlias } = renderFinder();
    const user = userEvent.setup();
    const input = within(cardOf('GPT-4o Mini')).getByPlaceholderText(/nemotron/);
    await user.type(input, 'shorty');
    await user.click(document.body);

    expect(onSaveAlias).toHaveBeenCalledTimes(1);
    expect(onSaveAlias).toHaveBeenCalledWith(PLAIN_TARGET, 'shorty');
  });

  it('targets the composed real id, never the alias id, when renaming', async () => {
    const { onSaveAlias } = renderFinder({ aliases: { nemotron: ALIASED_TARGET } });
    const user = userEvent.setup();
    const input = within(cardOf('Nemotron')).getByPlaceholderText(/nemotron/);
    await user.clear(input);
    await user.type(input, 'nemo2');
    await user.click(document.body);

    expect(onSaveAlias).toHaveBeenCalledTimes(1);
    expect(onSaveAlias).toHaveBeenCalledWith(ALIASED_TARGET, 'nemo2');
    expect(onSaveAlias).not.toHaveBeenCalledWith('nemotron', 'nemo2');
  });

  it('finds a card by its alias name in the search box', async () => {
    renderFinder({ aliases: { nemotron: ALIASED_TARGET } });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/搜索/), 'nemotron');

    expect(screen.getByRole('heading', { name: 'Nemotron' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'GPT-4o Mini' })).toBeNull();
  });

  it('matches a freshly saved alias that is not part of the model id', async () => {
    renderFinder({ aliases: { shorty: PLAIN_TARGET } });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/搜索/), 'shorty');

    expect(screen.getByRole('heading', { name: 'GPT-4o Mini' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Nemotron' })).toBeNull();
  });

  it('narrows to the matching provider card when searching by provider', async () => {
    renderFinder({ aliases: { nemotron: ALIASED_TARGET } });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/搜索/), 'openrouter');

    expect(screen.getByRole('heading', { name: 'GPT-4o Mini' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Nemotron' })).toBeNull();
  });
});
