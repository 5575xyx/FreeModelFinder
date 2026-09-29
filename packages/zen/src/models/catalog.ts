import type { ZenNativeProtocol } from '../config/index.js';
import {
  TIERS,
  type AnonymousDecision,
  type CatalogCapabilities,
  type CatalogSnapshot,
  type PricingDecider,
  type ZenModelMetadata,
  type ZenTier,
} from './types.js';

const CHAT: ZenNativeProtocol = 'chat';

function toSet(items: string[] | undefined, fallback: Set<string>): Set<string> {
  return items === undefined ? fallback : new Set(items);
}

function cloneTierProtocols(
  source: Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>> | undefined,
): Record<ZenTier, Map<string, ZenNativeProtocol>> {
  const out: Record<ZenTier, Map<string, ZenNativeProtocol>> = { zen: new Map(), go: new Map() };
  for (const tier of TIERS) {
    const layer = source?.[tier];
    if (!layer) continue;
    for (const [model, protocol] of Object.entries(layer)) out[tier].set(model, protocol);
  }
  return out;
}

function cloneTierBooleans(
  source: Partial<Record<ZenTier, Record<string, boolean>>> | undefined,
): Record<ZenTier, Set<string>> {
  const out: Record<ZenTier, Set<string>> = { zen: new Set(), go: new Set() };
  for (const tier of TIERS) {
    const layer = source?.[tier];
    if (!layer) continue;
    for (const [model, value] of Object.entries(layer)) if (value) out[tier].add(model);
  }
  return out;
}

function cloneTierMetadata(
  source: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>> | undefined,
): Record<ZenTier, Map<string, ZenModelMetadata>> {
  const out: Record<ZenTier, Map<string, ZenModelMetadata>> = { zen: new Map(), go: new Map() };
  for (const tier of TIERS) {
    const layer = source?.[tier];
    if (!layer) continue;
    for (const [model, md] of Object.entries(layer)) out[tier].set(model, md);
  }
  return out;
}

export class ZenCatalog {
  private zen = new Set<string>();
  private go = new Set<string>();
  private nativeProtocols = cloneTierProtocols(undefined);
  private unsupported = cloneTierBooleans(undefined);
  private metadata = cloneTierMetadata(undefined);
  private readonly overrides: Map<string, ZenNativeProtocol>;
  private pricing: PricingDecider | undefined;
  private cachePath = '';
  private cacheSource = 'none';
  private updatedAt = 0;
  private stale = false;
  private refreshAfterMs = 0;

  constructor(
    private readonly prefer: ZenTier,
    overrides: Record<string, ZenNativeProtocol>,
  ) {
    this.overrides = new Map(Object.entries(overrides));
  }

  setPricing(store: PricingDecider | undefined): void {
    this.pricing = store;
  }

  setCachePath(path: string): void {
    this.cachePath = path;
  }

  getCachePath(): string {
    return this.cachePath;
  }

  setRefreshIntervalMs(intervalMs: number): void {
    this.refreshAfterMs = intervalMs;
  }

  replace(capabilities: CatalogCapabilities): void {
    this.zen = toSet(capabilities.zen, this.zen);
    this.go = toSet(capabilities.go, this.go);
    if (capabilities.native) this.nativeProtocols = cloneTierProtocols(capabilities.native);
    if (capabilities.unsupported) this.unsupported = cloneTierBooleans(capabilities.unsupported);
    if (capabilities.metadata) this.metadata = cloneTierMetadata(capabilities.metadata);
    this.updatedAt = Date.now();
    this.cacheSource = 'live';
    this.stale = false;
  }

  list(): string[] {
    const union = new Set<string>([...this.zen, ...this.go]);
    return [...union].filter((model) => this.supported(model)).sort();
  }

  supported(model: string): boolean {
    const pending = this.zen.size === 0 && this.go.size === 0;
    if (pending) return true;
    if (this.zen.has(model) && this.tierSupported(model, 'zen')) return true;
    if (this.go.has(model) && this.tierSupported(model, 'go')) return true;
    return false;
  }

  metadataForTier(model: string, tier: ZenTier): ZenModelMetadata | undefined {
    return this.metadata[tier].get(model);
  }

  snapshot(): CatalogSnapshot {
    const union = new Set<string>([...this.zen, ...this.go]);
    let exposed = 0;
    for (const model of union) if (this.supported(model)) exposed += 1;
    const stale =
      this.stale ||
      (this.updatedAt > 0 &&
        this.refreshAfterMs > 0 &&
        Date.now() - this.updatedAt > Math.max(2 * this.refreshAfterMs, 60_000));
    return {
      zen: this.zen.size,
      go: this.go.size,
      total: union.size,
      exposed,
      ...(this.updatedAt > 0 ? { updatedAt: this.updatedAt } : {}),
      cacheSource: this.cacheSource,
      stale,
    };
  }

  isFreeModel(model: string): boolean {
    return this.anonymousDecision(model).allowed;
  }

  anonymousDecision(model: string): AnonymousDecision {
    if (this.pricing) return this.pricing.decide(model);
    return {
      allowed: /free/i.test(model),
      source: 'name_fallback_metadata_pending',
      known: false,
      deprecated: false,
    };
  }

  protocolFor(model: string, tier: ZenTier): ZenNativeProtocol {
    const override = this.overrides.get(model);
    if (override) return override;
    const native = this.nativeProtocols[tier].get(model);
    if (native) return native;
    return CHAT;
  }

  private tierSupported(model: string, tier: ZenTier): boolean {
    if (this.overrides.has(model)) return true;
    if (this.unsupported[tier].has(model)) return false;
    if (this.nativeProtocols[tier].has(model)) return true;
    return this.zen.size === 0 && this.go.size === 0;
  }
}
