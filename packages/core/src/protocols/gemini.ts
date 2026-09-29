import type { ChatMessage, ChatRequest, ToolCall, ToolDefinition } from '../types.js';

interface GeminiContentPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: unknown };
}

interface GeminiToolDeclaration {
  functionDeclarations?: Array<{
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

export interface GeminiHttpRequest {
  contents: Array<{
    role: 'user' | 'model';
    parts: GeminiContentPart[];
  }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: GeminiToolDeclaration[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
}

function geminiToolsToDefinitions(tools: GeminiToolDeclaration[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const t of tools) {
    for (const d of t.functionDeclarations ?? []) {
      if (!d.name) continue;
      out.push({
        type: 'function',
        function: {
          name: d.name,
          ...(d.description ? { description: d.description } : {}),
          ...(d.parameters ? { parameters: d.parameters } : {}),
        },
      });
    }
  }
  return out;
}

function geminiFunctionCalls(parts: GeminiContentPart[]): ToolCall[] | undefined {
  const calls: ToolCall[] = [];
  for (const p of parts) {
    if (!p.functionCall?.name) continue;
    calls.push({
      type: 'function',
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

export function geminiToChatRequest(
  model: string,
  req: GeminiHttpRequest,
  stream = false,
): ChatRequest {
  const messages: ChatMessage[] = [];
  if (req.systemInstruction) {
    messages.push({
      role: 'system',
      content: req.systemInstruction.parts.map((p) => p.text).join(''),
    });
  }
  for (const c of req.contents) {
    const responses = c.parts.filter((p) => p.functionResponse?.name);
    if (responses.length > 0) {
      for (const r of responses) {
        const fn = r.functionResponse!;
        messages.push({
          role: 'tool',
          name: fn.name ?? '',
          content: JSON.stringify(fn.response ?? {}),
        });
      }
      continue;
    }

    const text = c.parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text!)
      .join('');
    const parts: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    > = [];
    let sawImage = false;
    for (const p of c.parts) {
      if (p.inlineData?.data) {
        const mime = p.inlineData.mimeType ?? 'image/png';
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${p.inlineData.data}` },
        });
        sawImage = true;
      } else if (p.fileData?.fileUri) {
        parts.push({ type: 'image_url', image_url: { url: p.fileData.fileUri } });
        sawImage = true;
      } else if (typeof p.text === 'string') {
        parts.push({ type: 'text', text: p.text });
      }
    }
    const entry: ChatMessage = {
      role: c.role === 'model' ? 'assistant' : 'user',
      content: text,
      contentParts: sawImage ? parts : undefined,
    };
    const calls = geminiFunctionCalls(c.parts);
    if (calls) entry.tool_calls = calls;
    messages.push(entry);
  }

  const tools = req.tools ? geminiToolsToDefinitions(req.tools) : [];
  return {
    model,
    messages,
    temperature: req.generationConfig?.temperature,
    top_p: req.generationConfig?.topP,
    max_tokens: req.generationConfig?.maxOutputTokens,
    stop: req.generationConfig?.stopSequences,
    stream,
    ...(tools.length > 0 ? { tools } : {}),
    raw: req,
    rawProtocol: 'gemini',
  };
}

export function chatResponseToGemini(res: {
  content: string;
  finish_reason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: res.content }],
        },
        finishReason:
          res.finish_reason === 'length'
            ? 'MAX_TOKENS'
            : res.finish_reason === 'stop'
              ? 'STOP'
              : res.finish_reason?.toUpperCase(),
        index: 0,
      },
    ],
    usageMetadata: res.usage
      ? {
          promptTokenCount: res.usage.prompt_tokens ?? 0,
          candidatesTokenCount: res.usage.completion_tokens ?? 0,
          totalTokenCount: res.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
