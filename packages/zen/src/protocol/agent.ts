import type { ZenProtocol } from './types.js';

export const CORE_AGENT_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function anonymousTool(protocol: ZenProtocol, name: string): Record<string, unknown> {
  const description = `Agent tool ${name}`;
  const parameters = { type: 'object', properties: {} };
  if (protocol === 'anthropic') {
    return { name, description, input_schema: parameters };
  }
  if (protocol === 'responses') {
    return { type: 'function', name, description, parameters };
  }
  return { type: 'function', function: { name, description, parameters } };
}

function toolName(protocol: ZenProtocol, item: unknown): string {
  const entry = asRecord(item);
  if (!entry) return '';
  if (protocol === 'chat') return String(asRecord(entry['function'])?.['name'] ?? '');
  return String(entry['name'] ?? '');
}

function ensureTools(payload: Record<string, unknown>, protocol: ZenProtocol): boolean {
  const raw = payload['tools'];
  if (raw === undefined) {
    payload['tools'] = CORE_AGENT_TOOLS.map((name) => anonymousTool(protocol, name));
    return true;
  }
  if (!Array.isArray(raw)) return false;
  const present = new Set(raw.map((item) => toolName(protocol, item)));
  const missing = CORE_AGENT_TOOLS.filter((name) => !present.has(name));
  if (missing.length === 0) return false;
  payload['tools'] = [...raw, ...missing.map((name) => anonymousTool(protocol, name))];
  return true;
}

function ensureChatUsage(payload: Record<string, unknown>, protocol: ZenProtocol): boolean {
  if (protocol !== 'chat') return false;
  const options = asRecord(payload['stream_options']);
  if (!options) {
    payload['stream_options'] = { include_usage: true };
    return true;
  }
  if (options['include_usage'] === true) return false;
  options['include_usage'] = true;
  return true;
}

export function prepareAnonymousBody(
  body: Record<string, unknown>,
  protocol: ZenProtocol,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...body };
  let changed = false;
  if (payload['stream'] !== true) {
    payload['stream'] = true;
    changed = true;
  }
  if (ensureChatUsage(payload, protocol)) changed = true;
  if (ensureTools(payload, protocol)) changed = true;
  return changed ? payload : body;
}

export function shapeKeyBody(
  body: Record<string, unknown>,
  protocol: ZenProtocol,
  isFree: boolean,
): { body: Record<string, unknown>; changed: boolean } {
  if (!isFree) return { body, changed: false };
  const shaped = prepareAnonymousBody(body, protocol);
  return { body: shaped, changed: shaped !== body };
}
