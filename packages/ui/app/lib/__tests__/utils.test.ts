import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../utils';

const cleanups: Array<() => void> = [];

function track(target: object, key: string, original: PropertyDescriptor | undefined) {
  cleanups.push(() => {
    if (original) {
      Object.defineProperty(target, key, original);
    } else {
      delete (target as Record<string, unknown>)[key];
    }
  });
}

function stub(target: object, key: string, value: unknown) {
  track(target, key, Object.getOwnPropertyDescriptor(target, key));
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
}

function remove(target: object, key: string) {
  track(target, key, Object.getOwnPropertyDescriptor(target, key));
  delete (target as Record<string, unknown>)[key];
}

function setClipboard(clipboard: unknown) {
  stub(navigator, 'clipboard', clipboard);
}

function setExecCommand(execCommand: unknown) {
  stub(document, 'execCommand', execCommand);
}

interface Probe {
  area: HTMLTextAreaElement | null;
  active: Element | null;
}

function captureExecCommand(onCall?: () => boolean): Probe {
  const probe: Probe = { area: null, active: null };
  setExecCommand(
    vi.fn(() => {
      probe.area = document.querySelector('textarea');
      probe.active = document.activeElement;
      return onCall ? onCall() : true;
    }),
  );
  return probe;
}

function appendMarker(): HTMLElement {
  const marker = document.createElement('div');
  marker.textContent = 'anchor';
  document.body.appendChild(marker);
  cleanups.push(() => marker.remove());
  return marker;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
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

  it('stages the text in a hidden, anchored readonly textarea', async () => {
    setClipboard(undefined);
    const probe = captureExecCommand();

    await expect(copyToClipboard('copy me')).resolves.toBe(true);

    expect(probe.area).not.toBeNull();
    expect(probe.area?.value).toBe('copy me');
    expect(probe.area?.hasAttribute('readonly')).toBe(true);
    expect(probe.area?.style.position).toBe('fixed');
    expect(probe.area?.style.opacity).toBe('0');
    expect(probe.area?.style.top).toBe('0px');
    expect(probe.area?.style.left).toBe('0px');
    expect(probe.area?.style.fontSize).toBe('16px');
  });

  it('focuses the textarea and selects the whole value before copying', async () => {
    setClipboard(undefined);
    const probe = captureExecCommand();

    await copyToClipboard('select me');

    expect(probe.active).toBe(probe.area);
    expect(probe.area?.selectionStart).toBe(0);
    expect(probe.area?.selectionEnd).toBe('select me'.length);
  });

  it('leaves no temporary textarea behind', async () => {
    setClipboard(undefined);
    setExecCommand(vi.fn().mockReturnValue(true));
    const before = document.querySelectorAll('textarea').length;

    await copyToClipboard('cleanup');

    expect(document.querySelectorAll('textarea').length).toBe(before);
  });

  it('resolves false when document.execCommand is unavailable', async () => {
    setClipboard(undefined);
    remove(document, 'execCommand');
    const before = document.querySelectorAll('textarea').length;

    await expect(copyToClipboard('missing')).resolves.toBe(false);

    expect(document.execCommand).toBeUndefined();
    expect(document.querySelectorAll('textarea').length).toBe(before);
  });

  it('resolves false and removes the textarea when execCommand throws', async () => {
    setClipboard(undefined);
    setExecCommand(
      vi.fn(() => {
        throw new Error('boom');
      }),
    );
    const before = document.querySelectorAll('textarea').length;

    await expect(copyToClipboard('throws')).resolves.toBe(false);

    expect(document.querySelectorAll('textarea').length).toBe(before);
  });

  it('restores the previous selection after copying', async () => {
    setClipboard(undefined);
    const marker = appendMarker();
    const selection = document.getSelection() as Selection;
    const previous = document.createRange();
    previous.selectNodeContents(marker);
    selection.removeAllRanges();
    selection.addRange(previous);
    const probe = captureExecCommand(() => {
      const stolen = document.createRange();
      stolen.selectNodeContents(probe.area as HTMLTextAreaElement);
      selection.removeAllRanges();
      selection.addRange(stolen);
      return true;
    });

    await copyToClipboard('restore');

    expect(selection.rangeCount).toBe(1);
    expect(selection.getRangeAt(0).commonAncestorContainer).toBe(marker);
  });

  it('restores the previously focused element', async () => {
    setClipboard(undefined);
    const probe = captureExecCommand();
    const input = document.createElement('input');
    document.body.appendChild(input);
    cleanups.push(() => input.remove());
    input.focus();
    expect(document.activeElement).toBe(input);

    await copyToClipboard('focus');

    expect(probe.active).toBe(probe.area);
    expect(document.activeElement).toBe(input);
  });

  it('resolves false when the document has no body', async () => {
    setClipboard(undefined);
    setExecCommand(vi.fn().mockReturnValue(true));
    stub(document, 'body', null);

    await expect(copyToClipboard('headless')).resolves.toBe(false);
  });
});
