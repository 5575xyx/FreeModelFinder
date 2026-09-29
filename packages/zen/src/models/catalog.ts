import type { ZenNativeProtocol } from '../config/index.js';
import {
  TIERS,
  type AnonymousDecision,
  type CatalogCapabilities,
  type CatalogSnapshot,
  type PricingDecider,
  type ZenModelMetadata,
  type ZenRoute,
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

function copyMetadata(md: ZenModelMetadata): ZenModelMetadata {
  return {
    ...md,
    ...(md.inputModalities ? { inputModalities: [...md.inputModalities] } : {}),
    ...(md.outputModalities ? { outputModalities: [...md.outputModalities] } : {}),
  };
}

function cloneTierMetadata(
  source: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>> | undefined,
): Record<ZenTier, Map<string, ZenModelMetadata>> {
  const out: Record<ZenTier, Map<string, ZenModelMetadata>> = { zen: new Map(), go: new Map() };
  for (const tier of TIERS) {
    const layer = source?.[tier];
    if (!layer) continue;
    for (const [model, md] of Object.entries(layer)) out[tier].set(model, copyMetadata(md));
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
    if (capabilities.native) {
      for (const tier of TIERS) {
        const layer = capabilities.native[tier];
        if (layer) this.nativeProtocols[tier] = new Map(Object.entries(layer));
      }
    }
    if (capabilities.unsupported) {
      for (const tier of TIERS) {
        const layer = capabilities.unsupported[tier];
        if (!layer) continue;
        const set = new Set<string>();
        for (const [model, value] of Object.entries(layer)) if (value) set.add(model);
        this.unsupported[tier] = set;
      }
    }
    if (capabilities.metadata) {
      this.metadata = cloneTierMetadata(capabilities.metadata);
    }
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
    const md = this.metadata[tier].get(model);
    return md ? copyMetadata(md) : undefined;
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

  route(model: string, hasZenKeys: boolean, hasGoKeys: boolean, hasAnonymous: boolean): ZenRoute {
    const keyTiers = this.keyTierOrder(model, hasZenKeys, hasGoKeys);
    const decision = this.anonymousDecision(model);
    const advertised =
      this.zen.size === 0 && this.go.size === 0 ? true : this.zen.has(model) || this.go.has(model);
    if (
      hasAnonymous &&
      decision.allowed &&
      advertised &&
      (this.overrides.has(model) || !this.unsupported.zen.has(model))
    ) {
      const protocols = this.protocolsFor(model, keyTiers, true);
      return {
        id: model,
        tier: 'zen',
        protocol: protocols.zen ?? CHAT,
        protocols,
        anonymous: true,
        keyTiers,
      };
    }
    if (keyTiers.length > 0) {
      const protocols = this.protocolsFor(model, keyTiers, false);
      const primary = keyTiers[0] as ZenTier;
      return {
        id: model,
        tier: primary,
        protocol: protocols[primary] ?? CHAT,
        protocols,
        anonymous: false,
        keyTiers,
      };
    }
    throw new Error(`model "${model}" is not available in the configured Zen or Go pools`);
  }

  routeForTier(model: string, tier: ZenTier, hasZenKeys: boolean, hasGoKeys: boolean): ZenRoute {
    const hasKeys = tier === 'go' ? hasGoKeys : hasZenKeys;
    if (!hasKeys) throw new Error(`no ${tier} key is configured`);
    const advertised =
      this.zen.size === 0 && this.go.size === 0
        ? true
        : tier === 'go'
          ? this.go.has(model)
          : this.zen.has(model);
    if (!advertised) {
      throw new Error(`model "${model}" is not available in the selected ${tier} key tier`);
    }
    if (!this.tierSupported(model, tier)) {
      throw new Error(`model "${model}" uses an upstream protocol unavailable on ${tier}`);
    }
    const protocol = this.protocolFor(model, tier);
    return {
      id: model,
      tier,
      protocol,
      protocols: { [tier]: protocol },
      anonymous: false,
      keyTiers: [tier],
    };
  }

  private keyTierOrder(model: string, hasZenKeys: boolean, hasGoKeys: boolean): ZenTier[] {
    const pending = this.zen.size === 0 && this.go.size === 0;
    const available = (tier: ZenTier): boolean => {
      if (tier === 'zen') {
        return hasZenKeys && (pending || this.zen.has(model)) && this.tierSupported(model, 'zen');
      }
      return hasGoKeys && (pending || this.go.has(model)) && this.tierSupported(model, 'go');
    };
    const order: ZenTier[] = this.prefer === 'go' ? ['go', 'zen'] : ['zen', 'go'];
    return order.filter(available);
  }

  private protocolsFor(
    model: string,
    keyTiers: ZenTier[],
    includeZen: boolean,
  ): Partial<Record<ZenTier, ZenNativeProtocol>> {
    const protocols: Partial<Record<ZenTier, ZenNativeProtocol>> = {};
    if (includeZen) protocols.zen = this.protocolFor(model, 'zen');
    for (const tier of keyTiers) protocols[tier] = this.protocolFor(model, tier);
    return protocols;
  }
}
