import { toAnthropicBody } from './anthropic.js';
import { toChatBody } from './chat.js';
import { toResponsesBody } from './responses.js';
import type { ZenClientProtocol, ZenProtocol, ZenRequest } from './types.js';

const CLIENT_TO_PROTOCOL: Partial<Record<ZenClientProtocol, ZenProtocol>> = {
  openai: 'chat',
  anthropic: 'anthropic',
};

function cloneRaw(raw: unknown, model: string): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const cloned = structuredClone(raw) as Record<string, unknown>;
  cloned['model'] = model;
  return cloned;
}

export const MIN_RESPONSES_MAX_OUTPUT_TOKENS = 16;

/**
 * Keeps tiny downstream budgets (background titles, short classifications) from
 * being rejected by the Responses API, which floors max_output_tokens at 16.
 * Only a positive number below the floor is lifted; everything else passes
 * through untouched. Mirrors floorResponsesMaxTokens in
 * internal/protocol/request.go.
 */
export function floorResponsesMaxTokens(value: unknown): unknown {
  if (typeof value === 'number' && value > 0 && value < MIN_RESPONSES_MAX_OUTPUT_TOKENS) {
    return MIN_RESPONSES_MAX_OUTPUT_TOKENS;
  }
  return value;
}

export function prepareRequest(request: ZenRequest, target: ZenProtocol): Record<string, unknown> {
  // Tool results that carry images need a call ID so the encoder can address
  // the parent assistant turn. Mirrors the call-ID guard at the tail of
  // decodeBridgeRequest in internal/protocol/request.go, which skips chat: the
  // chat encoder lifts the images into its own message, so the id is cosmetic
  // there rather than load-bearing.
  if (target !== 'chat') {
    for (const message of request.messages) {
      if (message.role !== 'tool') continue;
      const parts = message.contentParts;
      if (!Array.isArray(parts)) continue;
      const hasImage = parts.some((p) => p.type === 'image_url');
      if (hasImage && !message.tool_call_id) {
        throw new Error('tool image result requires a call ID');
      }
    }
  }
  if (request.rawProtocol && CLIENT_TO_PROTOCOL[request.rawProtocol] === target) {
    const cloned = cloneRaw(request.raw, request.model);
    if (cloned) {
      // The bridge floors converted bodies; a same-protocol body is a clone of
      // the client's and needs the same guard.
      if (target === 'responses' && cloned['max_output_tokens'] !== undefined) {
        cloned['max_output_tokens'] = floorResponsesMaxTokens(cloned['max_output_tokens']);
      }
      return cloned;
    }
  }
  switch (target) {
    case 'anthropic':
      return toAnthropicBody(request);
    case 'responses':
      return toResponsesBody(request);
    default:
      return toChatBody(request);
  }
}
