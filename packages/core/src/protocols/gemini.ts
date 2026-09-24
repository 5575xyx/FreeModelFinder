import type { ChatMessage, ChatRequest } from '../types.js';

interface GeminiContentPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
}

export interface GeminiHttpRequest {
  contents: Array<{
    role: 'user' | 'model';
    parts: GeminiContentPart[];
  }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
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
    messages.push({
      role: c.role === 'model' ? 'assistant' : 'user',
      content: text,
      contentParts: sawImage ? parts : undefined,
    });
  }
  return {
    model,
    messages,
    temperature: req.generationConfig?.temperature,
    top_p: req.generationConfig?.topP,
    max_tokens: req.generationConfig?.maxOutputTokens,
    stop: req.generationConfig?.stopSequences,
    stream,
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
