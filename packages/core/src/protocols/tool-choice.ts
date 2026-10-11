import type { ChatRequest, ToolChoice } from '../types.js';

/**
 * Clients express "which tool, if any, must the model call" in three different
 * shapes. The gateway's internal `tool_choice` is OpenAI-shaped, so each
 * boundary converts once per direction. Both directions of a protocol live here
 * in one place so the mappings cannot drift apart.
 *
 * Only tool-calling fields are mapped. `response_format` is deliberately NOT
 * forwarded: it has no Anthropic/Gemini equivalent and a `json_schema` value
 * 400s on upstreams without structured-output support.
 */

export interface AnthropicToolChoiceFields {
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  disable_parallel_tool_use?: boolean;
}

export interface GeminiFunctionCallingConfig {
  mode?: 'AUTO' | 'ANY' | 'NONE';
  allowedFunctionNames?: string[];
  parallelFunctionCalling?: boolean;
}

export interface GeminiToolConfigFields {
  toolConfig?: { functionCallingConfig?: GeminiFunctionCallingConfig };
}

export interface ToolChoiceFields {
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
}

function namedFunction(toolChoice: ChatRequest['tool_choice']): string | undefined {
  return toolChoice && typeof toolChoice === 'object' ? toolChoice.function?.name : undefined;
}

/** OpenAI-shaped -> Anthropic request fields. */
export function toAnthropicToolChoice(
  toolChoice: ChatRequest['tool_choice'],
  parallelToolCalls: boolean | undefined,
): AnthropicToolChoiceFields {
  const out: AnthropicToolChoiceFields = {};
  const named = namedFunction(toolChoice);
  if (toolChoice === 'auto') out.tool_choice = { type: 'auto' };
  else if (toolChoice === 'required') out.tool_choice = { type: 'any' };
  else if (named) out.tool_choice = { type: 'tool', name: named };
  // 'none' is dropped: Anthropic cannot forbid tool use.
  if (parallelToolCalls !== undefined) out.disable_parallel_tool_use = !parallelToolCalls;
  return out;
}

/** Anthropic request fields -> internal OpenAI-shaped fields. */
export function fromAnthropicToolChoice(fields: AnthropicToolChoiceFields): ToolChoiceFields {
  const out: ToolChoiceFields = {};
  const tc = fields.tool_choice;
  if (tc?.type === 'any') out.tool_choice = 'required';
  else if (tc?.type === 'auto') out.tool_choice = 'auto';
  else if (tc?.type === 'tool' && tc.name) {
    out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (fields.disable_parallel_tool_use !== undefined) {
    out.parallel_tool_calls = !fields.disable_parallel_tool_use;
  }
  return out;
}

/** OpenAI-shaped -> Gemini toolConfig. */
export function toGeminiToolConfig(
  toolChoice: ChatRequest['tool_choice'],
  parallelToolCalls: boolean | undefined,
): GeminiToolConfigFields | undefined {
  const cfg: GeminiFunctionCallingConfig = {};
  const named = namedFunction(toolChoice);
  if (toolChoice === 'auto') cfg.mode = 'AUTO';
  else if (toolChoice === 'required') cfg.mode = 'ANY';
  else if (toolChoice === 'none') cfg.mode = 'NONE';
  if (named) {
    cfg.mode = 'ANY';
    cfg.allowedFunctionNames = [named];
  }
  if (parallelToolCalls !== undefined) cfg.parallelFunctionCalling = parallelToolCalls;
  return Object.keys(cfg).length > 0 ? { toolConfig: { functionCallingConfig: cfg } } : undefined;
}

/** Gemini toolConfig -> internal OpenAI-shaped fields. */
export function fromGeminiToolConfig(fields: GeminiToolConfigFields): ToolChoiceFields {
  const cfg = fields.toolConfig?.functionCallingConfig;
  const out: ToolChoiceFields = {};
  if (!cfg) return out;
  const names = cfg.allowedFunctionNames ?? [];
  const first = names.length === 1 ? names[0] : undefined;
  if (first) {
    out.tool_choice = { type: 'function', function: { name: first } };
  } else if (names.length > 1 || cfg.mode === 'ANY') {
    // OpenAI's shape cannot name several allowed functions, so keep the "must
    // call one" half of the constraint rather than silently allowing no call.
    out.tool_choice = 'required';
  } else if (cfg.mode === 'AUTO') out.tool_choice = 'auto';
  else if (cfg.mode === 'NONE') out.tool_choice = 'none';
  if (cfg.parallelFunctionCalling !== undefined) {
    out.parallel_tool_calls = cfg.parallelFunctionCalling;
  }
  return out;
}
