import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../utils';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

function setClipboard(clipboard: unknown) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: clipboard,
  });
}

function setExecCommand(execCommand: unknown) {
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: execCommand,
  });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  if (originalExecCommand) {
    Object.defineProperty(document, 'execCommand', originalExecCommand);
  } else {
    delete (document as { execCommand?: unknown }).execCommand;
  }
});

describe('copyToClipboard', () => {
  it('uses the async clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when the clipboard API is missing', async () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    setExecCommand(execCommand);

    await expect(copyToClipboard('fallback')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back when the clipboard API rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const execCommand = vi.fn().mockReturnValue(true);
    setExecCommand(execCommand);

    await expect(copyToClipboard('retry')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false when both paths fail', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    setExecCommand(vi.fn().mockReturnValue(false));

    await expect(copyToClipboard('nope')).resolves.toBe(false);
  });

  it('leaves no temporary textarea behind', async () => {
    setClipboard(undefined);
    setExecCommand(vi.fn().mockReturnValue(true));
    const before = document.querySelectorAll('textarea').length;

    await copyToClipboard('cleanup');

    expect(document.querySelectorAll('textarea').length).toBe(before);
  });
});
