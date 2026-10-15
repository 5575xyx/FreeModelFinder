import type { ZenNativeProtocol } from '../config/index.js';

export type ZenTier = 'zen' | 'go';

/**
 * Context and output ceilings for one model. The opencode capability catalog
 * omits these, so they are backfilled from models.dev.
 */
export interface ModelLimits {
  contextWindow?: number;
  maxInput?: number;
  maxOutput?: number;
}

/**
 * Published per-million-token price of a model, in USD. Mirrors the `Cost`
 * struct in upstream discovery.go: an absent field means the source did not
 * state it.
 */
export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ZenModelMetadata extends ModelLimits {
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
  cost?: ModelCost;
}

export interface ZenRoute {
  id: string;
  tier: ZenTier;
  protocol: ZenNativeProtocol;
  protocols: Partial<Record<ZenTier, ZenNativeProtocol>>;
  anonymous: boolean;
  keyTiers: ZenTier[];
}

export interface AnonymousDecision {
  allowed: boolean;
  source: string;
  known: boolean;
  deprecated: boolean;
  inputCost?: number;
  outputCost?: number;
}

export interface CatalogSnapshot {
  zen: number;
  go: number;
  total: number;
  exposed: number;
  updatedAt?: number;
  cacheSource: string;
  stale: boolean;
}

export interface PricingDecider {
  decide(model: string): AnonymousDecision;
  /** models.dev limits for this model, when the store knows it. */
  limits?(model: string): ModelLimits | undefined;
}

export interface CatalogCapabilities {
  zen?: string[];
  go?: string[];
  native?: Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>>;
  unsupported?: Partial<Record<ZenTier, Record<string, boolean>>>;
  metadata?: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>>;
}

export const TIERS: readonly ZenTier[] = ['zen', 'go'];
