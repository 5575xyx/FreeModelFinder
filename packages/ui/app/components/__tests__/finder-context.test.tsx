import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FinderView } from '../FinderView';
import type { ModelItem } from '../../lib/models';

// models.dev cannot name a private gateway's model, so a custom model with no
// configured window has to stay "unknown" — but the user must be told where
// they can fill it in.
const CUSTOM_NO_CTX: ModelItem = {
  id: 'my-model',
  provider: 'custom',
  display_name: 'My Model',
};
const CLINE_NO_CTX: ModelItem = {
  id: 'cline-free/x',
  provider: 'cline',
  display_name: 'Cline X',
};
const WITH_CTX: ModelItem = {
  id: 'gpt',
  provider: 'openrouter',
  display_name: 'GPT',
  context_window: 128_000,
};

// The set-context affordance renders in whichever language the app picked.
const SET_CONTEXT = /填写上下文|Set context/;
const UNKNOWN_CONTEXT = /上下文未知|Context unknown/;

function renderFinder(models: ModelItem[]) {
  const onOpenSettings = vi.fn();
  render(
    <FinderView
      models={models}
      selectedModel=""
      gatewayReachable
      loading={false}
      failures={[]}
      onSelectModel={vi.fn()}
      onOpenTester={vi.fn()}
      onOpenSettings={onOpenSettings}
      onRefresh={vi.fn()}
      onProbeModel={vi.fn()}
      probingModels={[]}
      aliases={{}}
      onSaveAlias={vi.fn()}
    />,
  );
  return { onOpenSettings };
}

function cardOf(heading: string): HTMLElement {
  return screen.getByRole('heading', { name: heading }).closest('article') as HTMLElement;
}

describe('FinderView context entry point', () => {
  it('offers a settings shortcut on a custom model left without a context window', async () => {
    const { onOpenSettings } = renderFinder([CUSTOM_NO_CTX]);
    const user = userEvent.setup();
    const card = cardOf('My Model');

    expect(within(card).getByText(UNKNOWN_CONTEXT)).toBeTruthy();
    const button = within(card).getByRole('button', { name: SET_CONTEXT });
    await user.click(button);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-custom model plain: unknown, no shortcut', () => {
    renderFinder([CLINE_NO_CTX]);
    const card = cardOf('Cline X');

    expect(within(card).getByText(UNKNOWN_CONTEXT)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: SET_CONTEXT })).toBeNull();
  });

  it('shows the window and no shortcut when the provider published one', () => {
    renderFinder([WITH_CTX]);
    const card = cardOf('GPT');

    // formatContext renders 128_000 as "128K <suffix>", never a thousands-separated count.
    expect(within(card).getByText(/128K/)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: SET_CONTEXT })).toBeNull();
  });
});
