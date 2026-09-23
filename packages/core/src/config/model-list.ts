export function asModelList(value: unknown): string[] {
  if (typeof value === 'string') {
    const v = value.trim();
    return v ? [v] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) out.push(item.trim());
    }
    return Array.from(new Set(out));
  }
  return [];
}
