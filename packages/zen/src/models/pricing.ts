import type { AnonymousDecision, PricingDecider } from './types.js';

export interface ZenPrice {
  id: string;
  input?: number;
  output?: number;
  deprecated: boolean;
}

export interface PricingSnapshot {
  ready: boolean;
  models: number;
  updatedAt?: number;
  stale: boolean;
  lastError?: string;
}

const MODELS_DEV_REFRESH_MS = 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberAt(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function isDeprecated(model: Record<string, unknown>): boolean {
  if (model['deprecated'] === true) return true;
  const status = firstNonEmptyString(model['status'], model['lifecycle']).toLowerCase();
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true;
  return model['deprecated_at'] != null || model['retirement_date'] != null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function providerRank(key: string): number {
  const lower = key.toLowerCase();
  if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0;
  if (lower.includes('opencode')) return 1;
  return 2;
}

export function decodeModelsDev(data: unknown): Record<string, ZenPrice> {
  const providers = asRecord(data);
  if (!providers) throw new Error('models.dev payload is not an object');
  const keys = Object.keys(providers).sort((a, b) => {
    const rank = providerRank(a) - providerRank(b);
    if (rank !== 0) return rank;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const key of keys) {
    const rank = providerRank(key);
    if (rank > 1) continue;
    const provider = asRecord(providers[key]);
    if (!provider) continue;
    if (rank === 1) {
      const identity = firstNonEmptyString(provider['id'], provider['name']).toLowerCase();
      if (!identity.includes('opencode')) continue;
    }
    const models = asRecord(provider['models']);
    if (!models) continue;
    const result: Record<string, ZenPrice> = {};
    for (const [id, raw] of Object.entries(models)) {
      const model = asRecord(raw) ?? {};
      const modelId = String(model['id'] ?? id);
      const cost = asRecord(model['cost']);
      const input = numberAt(cost, 'input');
      const output = numberAt(cost, 'output');
      result[modelId] = {
        id: modelId,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        deprecated: isDeprecated(model),
      };
    }
    if (Object.keys(result).length > 0) return result;
  }
  throw new Error('models.dev contains no OpenCode model metadata');
}

export class ZenPricingStore implements PricingDecider {
  private models: Record<string, ZenPrice> = {};
  private updatedAt = 0;
  private lastError = '';

  replace(models: Record<string, ZenPrice>, updatedAt: number): void {
    this.models = models;
    this.updatedAt = updatedAt;
    this.lastError = '';
  }

  recordError(message: string): void {
    this.lastError = message;
  }

  price(model: string): ZenPrice | undefined {
    return this.models[model];
  }

  decide(model: string): AnonymousDecision {
    const ready = this.updatedAt > 0 && Object.keys(this.models).length > 0;
    const nameFree = /free/i.test(model);
    const fallback = (source: string): AnonymousDecision => ({
      allowed: nameFree,
      source,
      known: false,
      deprecated: false,
    });
    if (!ready) return fallback('metadata_pending');
    const price = this.models[model];
    if (!price) return fallback('metadata_model_missing');
    const decision: AnonymousDecision = {
      allowed: false,
      source: 'metadata_paid',
      known: true,
      deprecated: price.deprecated,
      ...(price.input !== undefined ? { inputCost: price.input } : {}),
      ...(price.output !== undefined ? { outputCost: price.output } : {}),
    };
    const metadataFree = !price.deprecated && price.input === 0 && price.output === 0;
    if (nameFree || metadataFree) {
      decision.allowed = true;
      decision.source =
        nameFree && metadataFree
          ? 'name_and_metadata_free'
          : nameFree
            ? 'name_free'
            : 'metadata_free';
      return decision;
    }
    if (price.deprecated) {
      decision.source = 'metadata_deprecated';
      return decision;
    }
    if (price.input === undefined || price.output === undefined) {
      decision.known = false;
      decision.source = 'metadata_cost_unknown';
    }
    return decision;
  }

  snapshot(now = Date.now()): PricingSnapshot {
    const ready = this.updatedAt > 0 && Object.keys(this.models).length > 0;
    return {
      ready,
      models: Object.keys(this.models).length,
      ...(this.updatedAt > 0 ? { updatedAt: this.updatedAt } : {}),
      stale: this.updatedAt > 0 && now - this.updatedAt > MODELS_DEV_REFRESH_MS,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}
