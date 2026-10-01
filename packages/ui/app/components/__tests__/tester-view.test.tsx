import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TesterView, type Msg } from '../TesterView';

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

const ANSWER = '回退路径也应该能复制到这段回答。';

const messages: Msg[] = [
  { role: 'user', content: 'ping' },
  { role: 'assistant', content: ANSWER },
];

function renderTester() {
  return render(
    <TesterView
      messages={messages}
      streaming={false}
      input=""
      model="auto"
      models={[{ id: 'fixture-model', provider: 'openrouter', context_window: 32_000 }]}
      inputImages={[]}
      setInput={() => undefined}
      setImages={() => undefined}
      send={() => undefined}
      onCancel={() => undefined}
      onModelChange={() => undefined}
      onClear={() => undefined}
    />,
  );
}

describe('TesterView message copy', () => {
  afterEach(() => {
    restore(navigator, 'clipboard', clipboardDescriptor);
    restore(document, 'execCommand', execCommandDescriptor);
  });

  it('copies the answer through execCommand when the clipboard API is unavailable', async () => {
    const user = userEvent.setup();
    override(navigator, 'clipboard', undefined);
    const staged = recordExecCommand(true);
    renderTester();

    await user.click(screen.getByRole('button', { name: '复制' }));

    expect(staged).toEqual([ANSWER]);
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy();
  });

  it('leaves the copied state unlit when the clipboard API rejects and execCommand gives up', async () => {
    const user = userEvent.setup();
    override(navigator, 'clipboard', { writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const staged = recordExecCommand(false);
    renderTester();

    await user.click(screen.getByRole('button', { name: '复制' }));

    expect(staged).toEqual([ANSWER]);
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
  });

  it('leaves the copied state unlit without any error UI when execCommand gives up', async () => {
    const user = userEvent.setup();
    override(navigator, 'clipboard', undefined);
    const staged = recordExecCommand(false);
    renderTester();

    await user.click(screen.getByRole('button', { name: '复制' }));

    expect(staged).toEqual([ANSWER]);
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
  });
});
