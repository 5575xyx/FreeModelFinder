import type { ChatMessage, ChatRequest, ToolCall, ToolDefinition } from '../types.js';

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
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
  tools?: AnthropicTool[];
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

function blocksToToolCalls(blocks: AnthropicBlock[]): ToolCall[] | undefined {
  const calls: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue;
    calls.push({
      ...(b.id ? { id: b.id } : {}),
      type: 'function',
      function: {
        name: b.name ?? '',
        arguments: b.input === undefined || b.input === null ? '{}' : JSON.stringify(b.input),
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function blockText(block: AnthropicBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

function anthropicToolsToDefinitions(tools: AnthropicTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.input_schema ? { parameters: t.input_schema } : {}),
    },
  }));
}

export function anthropicToChatRequest(req: AnthropicMessagesRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  if (req.system) {
    const sys =
      typeof req.system === 'string' ? req.system : req.system.map((s) => s.text).join('\n\n');
    messages.push({ role: 'system', content: sys });
  }
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    const toolCalls = blocksToToolCalls(m.content);
    const results = m.content.filter((b) => b.type === 'tool_result');
    const parts = anthropicContentToParts(m.content);

    if (results.length > 0) {
      for (const r of results) {
        messages.push({
          role: 'tool',
          content: blockText(r),
          tool_call_id: r.tool_use_id ?? '',
        });
      }
      const rest = m.content.filter((b) => b.type !== 'tool_result');
      if (rest.length > 0) {
        const restText = contentToString(rest);
        const restParts = anthropicContentToParts(rest);
        if (restText || restParts) {
          messages.push({ role: 'user', content: restText, contentParts: restParts });
        }
      }
      continue;
    }

    const text = contentToString(m.content);
    const entry: ChatMessage = {
      role: m.role,
      content: text,
      contentParts: parts,
    };
    if (toolCalls) entry.tool_calls = toolCalls;
    messages.push(entry);
  }

  return {
    model: req.model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
    stop: req.stop_sequences,
    ...(req.tools && req.tools.length > 0 ? { tools: anthropicToolsToDefinitions(req.tools) } : {}),
    raw: req,
    rawProtocol: 'anthropic',
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
