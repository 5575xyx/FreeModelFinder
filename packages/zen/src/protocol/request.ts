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

export function prepareRequest(request: ZenRequest, target: ZenProtocol): Record<string, unknown> {
  if (request.rawProtocol && CLIENT_TO_PROTOCOL[request.rawProtocol] === target) {
    const cloned = cloneRaw(request.raw, request.model);
    if (cloned) return cloned;
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
