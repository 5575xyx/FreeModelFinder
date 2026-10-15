export const OPENCODE_VERSION = '2.0.29';

export function openCodeUserAgent(): string {
  // Upstream rejects the old `opencode/<ver> (os arch; node)` shape with a 403
  // FreeTierError even when every other header matches. The version itself is
  // not validated — bump it only when upstream starts refusing this one.
  return `opencode/latest/${OPENCODE_VERSION}/cli`;
}

export const OPENCODE_CLIENT_HEADERS: Record<string, string> = {
  'x-opencode-client': 'cli',
};
