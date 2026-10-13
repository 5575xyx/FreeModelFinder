import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelAliasInput } from '../ModelAliasInput';

const TARGET = 'custom:novay:glm-5.3';

type HarnessProps = {
  target?: string;
  alias?: string;
  aliases?: Record<string, string>;
  disabled?: boolean;
  onSave?: (target: string, name: string) => Promise<void>;
};

/** Controlled harness: renders the widget, records `onSave` calls, and can re-render with new props. */
function renderInput(initial: HarnessProps = {}) {
  const onSave = initial.onSave ?? vi.fn(async () => {});
  const props = {
    target: initial.target ?? TARGET,
    alias: initial.alias,
    aliases: initial.aliases ?? {},
    disabled: initial.disabled,
    onSave,
  };
  const view = render(<ModelAliasInput {...props} />);
  return {
    ...view,
    onSave,
    rerenderInput(next: HarnessProps) {
      const merged = { ...props, ...next, onSave: next.onSave ?? onSave };
      view.rerender(<ModelAliasInput {...merged} />);
    },
  };
}

describe('ModelAliasInput', () => {
  it('renders an empty input with the placeholder when no alias is set', () => {
    renderInput();
    const input = screen.getByPlaceholderText(/nemotron/) as HTMLInputElement;
    expect(input.value).toBe('');
    // No alias → no remove button.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the current alias as the input value with a saved status', () => {
    renderInput({ alias: 'nemotron' });
    expect(screen.getByDisplayValue('nemotron')).toBeTruthy();
    expect(screen.getByText('已保存')).toBeTruthy();
  });

  it('saves the typed name on blur', async () => {
    const { onSave } = renderInput();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/nemotron/), 'glm');
    await user.click(document.body);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(TARGET, 'glm');
  });

  it('saves the typed name on Enter', async () => {
    const { onSave } = renderInput();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/nemotron/), 'glm');
    await user.keyboard('{Enter}');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(TARGET, 'glm');
  });

  it('shows an alert and does not save when the name contains a colon', async () => {
    const { onSave } = renderInput();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/nemotron/), 'a:b');
    await user.click(document.body);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(':');
  });

  it('shows an alert and does not save when the name is taken by another model', async () => {
    const { onSave } = renderInput({ aliases: { other: 'some:other' } });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/nemotron/), 'other');
    await user.click(document.body);
    expect(onSave).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('已被');
    expect(alert.textContent).toContain('some:other');
  });

  it('saves an empty name when the input is emptied and blurred', async () => {
    const { onSave } = renderInput({ alias: 'nemotron' });
    const user = userEvent.setup();
    await user.clear(screen.getByDisplayValue('nemotron'));
    await user.click(document.body);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(TARGET, '');
  });

  it('still saves an empty name on blur when there was no alias', async () => {
    const { onSave } = renderInput();
    const user = userEvent.setup();
    await user.click(screen.getByPlaceholderText(/nemotron/));
    await user.click(document.body);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(TARGET, '');
  });

  it('shows a save-failed alert when onSave rejects', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('boom');
    });
    renderInput({ onSave });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/nemotron/), 'glm');
    await user.keyboard('{Enter}');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(TARGET, 'glm');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('boom');
  });

  it('restores the original value and clears the error on Escape without saving', async () => {
    const { onSave } = renderInput({ alias: 'nemotron' });
    const user = userEvent.setup();
    const input = screen.getByDisplayValue('nemotron');
    await user.clear(input);
    await user.type(input, 'a:b');
    await user.click(document.body);
    expect(screen.getByRole('alert').textContent).toContain(':');
    input.focus();
    await user.keyboard('{Escape}');
    expect(screen.getByDisplayValue('nemotron')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('clears the alias through the remove button without a spurious blur save', async () => {
    const { onSave } = renderInput({ alias: 'nemotron' });
    const user = userEvent.setup();
    // Focus the input and leave a draft behind, then click the remove button:
    // only the button's clear may be reported.
    await user.type(screen.getByDisplayValue('nemotron'), 'x');
    await user.click(screen.getByRole('button', { name: '清除别名' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(TARGET, '');
    expect((screen.getByPlaceholderText(/nemotron/) as HTMLInputElement).value).toBe('');
  });

  it('shows the saving status while onSave is pending', async () => {
    let release!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderInput({ alias: 'old', onSave });
    const user = userEvent.setup();
    const input = screen.getByDisplayValue('old');
    await user.clear(input);
    await user.type(input, 'glm');
    await user.keyboard('{Enter}');
    expect(screen.getByText('保存中…')).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByText('保存中…')).toBeNull());
    expect(screen.getByText('已保存')).toBeTruthy();
  });

  it('blocks every save path while disabled', () => {
    const { onSave } = renderInput({ alias: 'nemotron', disabled: true });
    const input = screen.getByDisplayValue('nemotron') as HTMLInputElement;
    const remove = screen.getByRole('button', { name: '清除别名' }) as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    // Real users cannot interact with disabled controls, but a stray programmatic
    // event must still not trigger a save.
    fireEvent.click(remove);
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps an in-progress draft when the alias prop changes while focused', async () => {
    const onSave = vi.fn(async () => {});
    const { rerenderInput } = renderInput({ alias: 'old', onSave });
    const user = userEvent.setup();
    const input = screen.getByDisplayValue('old');
    await user.clear(input);
    await user.type(input, 'glm');
    // Parent re-renders with a fresh alias while the user is still typing.
    rerenderInput({ alias: 'changed' });
    expect(screen.getByDisplayValue('glm')).toBeTruthy();
    await user.click(document.body);
    expect(onSave).toHaveBeenCalledWith(TARGET, 'glm');
  });

  it('syncs the draft from the alias prop while not focused', () => {
    const { rerenderInput } = renderInput({ alias: 'old' });
    expect(screen.getByDisplayValue('old')).toBeTruthy();
    rerenderInput({ alias: 'changed' });
    expect(screen.getByDisplayValue('changed')).toBeTruthy();
  });
});
