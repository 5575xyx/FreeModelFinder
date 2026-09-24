import type { ChatMessage } from '../types.js';

export function toOpenAIMessages(
  messages: ChatMessage[],
): Array<{ role: string; content: string | unknown[] }> {
  return messages.map((m) => {
    const hasImage = m.contentParts?.some((p) => p.type === 'image_url') ?? false;
    if (hasImage && m.contentParts) {
      return {
        role: m.role,
        content: m.contentParts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: p.image_url.url } },
        ),
      };
    }
    return { role: m.role, content: m.content };
  });
}
