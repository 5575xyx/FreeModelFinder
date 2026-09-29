export type ProxyKind = 'direct' | 'http' | 'https' | 'socks5' | 'socks5h';

export type ProxySpec =
  | { kind: 'direct'; label: string }
  | { kind: 'http' | 'https' | 'socks5' | 'socks5h'; url: string; label: string };

export function redactProxy(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    if (url.pathname === '') url.pathname = '/';
    return url.toString();
  } catch {
    return value;
  }
}

export function parseProxy(raw: string): ProxySpec | null {
  const value = raw.trim();
  if (!value) return null;
  if (value === 'direct') return { kind: 'direct', label: 'direct' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const redacted = redactProxy(value);
  switch (url.protocol) {
    case 'http:':
      return { kind: 'http', url: value, label: redacted };
    case 'https:':
      return { kind: 'https', url: value, label: redacted };
    case 'socks5:':
      return { kind: 'socks5', url: value, label: redacted };
    case 'socks5h:':
      return { kind: 'socks5h', url: value, label: redacted };
    default:
      return null;
  }
}

function stripComment(line: string): string {
  const markers = ['#', ';', '//'];
  let cut = line.length;
  for (const marker of markers) {
    let from = 0;
    for (;;) {
      const found = line.indexOf(marker, from);
      if (found === -1) break;
      if (found === 0 || /\s/.test(line[found - 1] ?? '')) {
        if (found < cut) cut = found;
        break;
      }
      from = found + marker.length;
    }
  }
  return line.slice(0, cut).trim();
}

export function parseProxyList(
  proxies: string[] | undefined,
  proxyfileContent: string | undefined,
): ProxySpec[] {
  const sources: string[] = [...(proxies ?? [])];
  if (proxyfileContent) {
    for (const line of proxyfileContent.split(/\r?\n/)) {
      const stripped = stripComment(line);
      if (stripped) sources.push(stripped);
    }
  }
  const seen = new Set<string>();
  const out: ProxySpec[] = [];
  for (const raw of sources) {
    const spec = parseProxy(raw);
    if (!spec) continue;
    const key = spec.kind === 'direct' ? 'direct' : spec.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  if (out.length === 0) out.push({ kind: 'direct', label: 'direct' });
  return out;
}
