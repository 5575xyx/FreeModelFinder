import { createHash } from 'node:crypto';
import type { ChatMessage } from './types.js';

export function sessionKeyOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user') ?? messages[0];
  if (!first) return 'empty';
  const material = `${first.role}:${first.content ?? ''}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}
