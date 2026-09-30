import type { ChatRequest, ChatMessage } from './types.js';

const CHARS_PER_TOKEN = 3;

function partChars(parts: ChatMessage['contentParts']): number {
  let chars = 0;
  for (const p of parts ?? []) {
    if (p.type === 'text') chars += p.text.length;
  }
  return chars;
}

function messageChars(m: ChatMessage): number {
  let chars = m.content.length + partChars(m.contentParts);
  for (const call of m.tool_calls ?? []) {
    chars += (call.function.arguments ?? '').length;
  }
  return chars;
}

export function estimateInputTokens(req: Pick<ChatRequest, 'messages' | 'tools'>): number {
  let chars = 0;
  for (const m of req.messages) chars += messageChars(m);
  if (req.tools?.length) chars += JSON.stringify(req.tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
