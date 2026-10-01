export function formatK(k: number) {
  if (k >= 1000) return `${(k / 1000).toFixed(k % 1000 === 0 ? 0 : 1)}M`;
  return `${k}K`;
}

export function formatNumber(n: number) {
  return n.toLocaleString('en-US');
}

function resolveGateway(): string {
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_GATEWAY_URL) {
    return process.env.NEXT_PUBLIC_GATEWAY_URL;
  }
  if (typeof window !== 'undefined' && window.location.port !== '3000') {
    return window.location.origin;
  }
  return 'http://127.0.0.1:11435';
}

export const GATEWAY = resolveGateway();

export const UI_CLIENT_HEADERS: Record<string, string> = {
  'x-fmf-client': 'ui',
};

export function withUiHeaders(init?: RequestInit): RequestInit {
  const merged = new Headers(init?.headers);
  for (const [k, v] of Object.entries(UI_CLIENT_HEADERS)) {
    if (!merged.has(k)) merged.set(k, v);
  }
  return { ...(init ?? {}), headers: merged };
}

export function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

/**
 * Copy text to the clipboard.
 *
 * The async Clipboard API only exists in a secure context, so it is undefined
 * when the dashboard is served over plain http on a non-loopback host. The
 * execCommand path works there as long as it runs inside the user gesture.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  const body = document.body;
  if (!body) return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  area.style.fontSize = '16px';
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    body.appendChild(area);
    area.focus();
    area.setSelectionRange(0, area.value.length);
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous) {
      selection?.removeAllRanges();
      selection?.addRange(previous);
    }
    if (active && typeof active.focus === 'function') active.focus({ preventScroll: true });
  }
}
