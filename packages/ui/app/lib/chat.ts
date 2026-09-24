export type WirePart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export function toWireContent(text: string, images: readonly string[] = []): string | WirePart[] {
  if (images.length === 0) return text;
  const parts: WirePart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}
