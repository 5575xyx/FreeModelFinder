import type { ZenProtocol } from './types.js';

export type ZenEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none';

const VALID_EFFORTS: readonly string[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'none',
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function valueAt(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function intAt(value: unknown): number {
  const record = asRecord(value);
  if (!record) return 0;
  const raw = record['max_tokens'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  return 0;
}

function normalizeEffort(effort: string | undefined): string {
  return (effort ?? '').trim().toLowerCase();
}

function validForcedEffort(effort: string): boolean {
  return VALID_EFFORTS.includes(effort);
}

function budgetForEffort(effort: string): number {
  switch (normalizeEffort(effort)) {
    case 'minimal':
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 8192;
    case 'xhigh':
      return 16384;
    case 'max':
      return 32768;
    default:
      return 4096;
  }
}

export function clientEffortExplicit(
  protocol: ZenProtocol,
  body: Record<string, unknown>,
): boolean {
  switch (protocol) {
    case 'chat': {
      return typeof body['reasoning_effort'] === 'string';
    }
    case 'anthropic': {
      const outputEffort = valueAt(body, 'output_config', 'effort');
      if (typeof outputEffort === 'string' && outputEffort.trim() !== '') return true;
      const topLevel = body['effort'];
      return typeof topLevel === 'string' && topLevel.trim() !== '';
    }
    case 'responses': {
      return typeof valueAt(body, 'reasoning', 'effort') === 'string';
    }
    default: {
      return false;
    }
  }
}

function applyAnthropicForcedEffort(
  body: Record<string, unknown>,
  effort: string,
  disable: boolean,
): void {
  if (disable) {
    delete body['thinking'];
    delete body['output_config'];
    return;
  }
  const existing = asRecord(body['output_config']);
  if (!existing) {
    body['output_config'] = { effort };
  } else {
    existing['effort'] = effort;
  }
  const budget = budgetForEffort(effort);
  const thinking = asRecord(body['thinking']);
  if (thinking) {
    thinking['type'] = 'enabled';
    thinking['budget_tokens'] = budget;
  } else {
    body['thinking'] = { type: 'enabled', budget_tokens: budget };
  }
  const current = intAt(body);
  if (current > 0 && current <= budget) {
    body['max_tokens'] = budget + 4096;
  }
}

export function applyForcedEffort(
  body: Record<string, unknown>,
  protocol: ZenProtocol,
  effort: string | undefined,
): void {
  if (!body) return;
  const normalized = normalizeEffort(effort);
  if (!validForcedEffort(normalized)) return;
  const disable = normalized === 'none';
  switch (protocol) {
    case 'chat': {
      if (clientEffortExplicit(protocol, body)) return;
      if (disable) {
        delete body['reasoning_effort'];
        return;
      }
      body['reasoning_effort'] = normalized;
      return;
    }
    case 'anthropic': {
      if (clientEffortExplicit(protocol, body)) return;
      applyAnthropicForcedEffort(body, normalized, disable);
      return;
    }
    case 'responses': {
      if (clientEffortExplicit(protocol, body)) return;
      if (disable) {
        delete body['reasoning'];
        return;
      }
      let reasoning = asRecord(body['reasoning']);
      if (!reasoning) {
        reasoning = {};
        body['reasoning'] = reasoning;
      }
      reasoning['effort'] = normalized;
      return;
    }
    default: {
      return;
    }
  }
}

export function resolveEffort(
  model: string,
  defaultEffort: ZenEffort | undefined,
  effortByModel: Record<string, ZenEffort>,
): ZenEffort | undefined {
  return effortByModel[model] ?? defaultEffort;
}
