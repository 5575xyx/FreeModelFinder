import type { ZenNativeProtocol } from '../config/index.js';

export type ZenTier = 'zen' | 'go';

export interface ZenModelMetadata {
  contextWindow?: number;
  maxInput?: number;
  maxOutput?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
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
}

export interface CatalogCapabilities {
  zen?: string[];
  go?: string[];
  native?: Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>>;
  unsupported?: Partial<Record<ZenTier, Record<string, boolean>>>;
  metadata?: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>>;
}

export const TIERS: ZenTier[] = ['zen', 'go'];
