export function composeModelId(provider: string, id: string): string {
  if (provider === 'custom') return `${provider}:${id}`;
  return id.startsWith(`${provider}:`) ? id : `${provider}:${id}`;
}

export function bareModelId(provider: string, id: string): string {
  if (provider === 'custom') return id;
  const prefix = `${provider}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
