export function composeModelId(provider: string, id: string): string {
  return id.startsWith(`${provider}:`) ? id : `${provider}:${id}`;
}

export function bareModelId(provider: string, id: string): string {
  const prefix = `${provider}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
