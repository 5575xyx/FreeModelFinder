import type { ChatMessage, ChatRequest } from '../types.js';

interface AnthropicBlock {
  type: string;
  text?: string;
  source?: { type?: string; media_type?: string; url?: string; data?: string };
}

export interface AnthropicMessagesRequest {
  model: string;
  system?: string | Array<{ type: 'text'; text: string }>;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | AnthropicBlock[];
  }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequences?: string[];
}

function contentToString(content: AnthropicMessagesRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

function anthropicContentToParts(
  content: AnthropicMessagesRequest['messages'][number]['content'],
):
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  | undefined {
  if (typeof content === 'string') return undefined;
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  let sawImage = false;
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && b.source) {
      if (b.source.type === 'url' && b.source.url) {
        parts.push({ type: 'image_url', image_url: { url: b.source.url } });
        sawImage = true;
      } else if (b.source.type === 'base64' && b.source.data && b.source.media_type) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        });
        sawImage = true;
      }
    }
  }
  return sawImage ? parts : undefined;
}

export function anthropicToChatRequest(req: AnthropicMessagesRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  if (req.system) {
    const sys =
      typeof req.system === 'string' ? req.system : req.system.map((s) => s.text).join('\n\n');
    messages.push({ role: 'system', content: sys });
  }
  for (const m of req.messages) {
    messages.push({
      role: m.role,
      content: contentToString(m.content),
      contentParts: anthropicContentToParts(m.content),
    });
  }
  return {
    model: req.model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
    stop: req.stop_sequences,
  };
}

export function chatResponseToAnthropic(res: {
  id: string;
  model: string;
  content: string;
  finish_reason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}) {
  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content: [{ type: 'text', text: res.content }],
    stop_reason:
      res.finish_reason === 'length'
        ? 'max_tokens'
        : res.finish_reason === 'stop'
          ? 'end_turn'
          : res.finish_reason,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}
