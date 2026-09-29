export type ProxyKind = 'direct' | 'http' | 'https' | 'socks5' | 'socks5h';

export interface ProxySpec {
  kind: ProxyKind;
  url?: string;
  label: string;
}

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
  switch (url.protocol) {
    case 'http:':
    case 'https:':
    case 'socks5:':
    case 'socks5h:':
      return {
        kind: url.protocol.slice(0, -1) as ProxyKind,
        url: value,
        label: redactProxy(value),
      };
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
    const key = spec.url ?? 'direct';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  if (out.length === 0) out.push({ kind: 'direct', label: 'direct' });
  return out;
}
