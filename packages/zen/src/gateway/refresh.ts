import type { ZenConfig, ZenNativeProtocol } from '../config/index.js';
import { openCodeUserAgent } from '../identity/client.js';
import { readJsonCache, writeJsonCache } from '../models/cache.js';
import type { ZenCatalog } from '../models/catalog.js';
import {
  fetchCapabilities,
  fetchModels,
  type CapabilityEndpoints,
  type ZenCapabilities,
} from '../models/discovery.js';
import { decodeModelsDev, type ZenPrice, type ZenPricingStore } from '../models/pricing.js';
import { TIERS, type ZenModelMetadata, type ZenTier } from '../models/types.js';
import type { ZenAttemptMonitor } from './monitor.js';

// Mirrors internal/models/discovery.go:18-22. Zen and Go capabilities share one
// machine-readable catalog, while each tier publishes a supplemental endpoint
// table in its own .mdx document.
export const ZEN_CAPABILITIES_URL = 'https://models.opencode.ai/api.json';
export const ZEN_DOCS_URL =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx';
export const GO_DOCS_URL =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx';
export const MODELS_DEV_URL = 'https://models.dev/api.json';

// Mirrors modelCatalogCacheSchemaVersion in internal/models/cache.go:20.
export const CATALOG_CACHE_SCHEMA_VERSION = 3;

const PUBLIC_KEY = 'public';

// Mirrors protocolDocEndpointPattern in internal/models/discovery.go:24.
const PROTOCOL_DOC_ENDPOINT =
  /\|[^|]+\|\s*`?([^|`\s]+)`?\s*\|\s*`[^`]+\/v1\/(chat\/completions|responses|messages|systemone)`/;

export type ZenTierProtocols = Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>>;
export type ZenTierFlags = Partial<Record<ZenTier, Record<string, boolean>>>;
export type ZenTierMetadata = Partial<Record<ZenTier, Record<string, ZenModelMetadata>>>;

export interface ZenCatalogCacheFile {
  schema_version: number;
  updated_at: string;
  zen: string[];
  go: string[];
  native_protocols: ZenTierProtocols;
  unsupported: ZenTierFlags;
  metadata: ZenTierMetadata;
}

export interface ZenPricingCacheFile {
  updated_at: string;
  models: Record<string, ZenPrice>;
}

export interface ZenRefreshLogger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface ZenRefreshResult {
  zen: number;
  go: number;
  total: number;
  pricing: number;
  capabilities: boolean;
  errors: string[];
}

export interface ZenRefresherOptions {
  config: ZenConfig;
  catalog: ZenCatalog;
  pricing: ZenPricingStore;
  fetchImpl: typeof fetch;
  client?: unknown;
  cachePaths?: { catalog?: string; pricing?: string };
  monitor?: ZenAttemptMonitor;
  logger?: ZenRefreshLogger;
  now?: () => number;
}

interface ParsedCatalogCache {
  zen: string[];
  go: string[];
  nativeProtocols: ZenTierProtocols;
  unsupported: ZenTierFlags;
  metadata: ZenTierMetadata;
  updatedAt: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyCapabilities(): ZenCapabilities {
  return {
    native: { zen: {}, go: {} },
    unsupported: { zen: {}, go: {} },
    metadata: { zen: {}, go: {} },
  };
}

function hasCapabilityData(caps: ZenCapabilities): boolean {
  for (const tier of TIERS) {
    if (Object.keys(caps.native[tier] ?? {}).length > 0) return true;
    if (Object.keys(caps.unsupported[tier] ?? {}).length > 0) return true;
    if (Object.keys(caps.metadata[tier] ?? {}).length > 0) return true;
  }
  return false;
}

function toEpoch(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

// Mirrors normalizeModelIDs in internal/models/cache.go:128.
function normalizeModelIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
  }
  return [...seen].sort();
}

function parseCatalogCache(raw: ZenCatalogCacheFile | undefined): ParsedCatalogCache | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.schema_version !== CATALOG_CACHE_SCHEMA_VERSION) return undefined;
  const updatedAt = toEpoch(raw.updated_at);
  if (updatedAt === undefined) return undefined;
  const zen = normalizeModelIds(raw.zen);
  const go = normalizeModelIds(raw.go);
  if (zen.length === 0 && go.length === 0) return undefined;
  return {
    zen,
    go,
    nativeProtocols: raw.native_protocols ?? {},
    unsupported: raw.unsupported ?? {},
    metadata: raw.metadata ?? {},
    updatedAt,
  };
}

function parsePricingCache(
  raw: ZenPricingCacheFile | undefined,
): { models: Record<string, ZenPrice>; updatedAt: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const updatedAt = toEpoch(raw.updated_at);
  if (updatedAt === undefined) return undefined;
  const models = raw.models;
  if (!models || typeof models !== 'object' || Object.keys(models).length === 0) return undefined;
  return { models, updatedAt };
}

function protocolForEndpoint(kind: string | undefined): ZenNativeProtocol | undefined {
  switch (kind) {
    case 'chat/completions':
      return 'chat';
    case 'responses':
      return 'responses';
    case 'messages':
      return 'anthropic';
    default:
      return undefined;
  }
}

// Mirrors FetchProtocolDocs in internal/models/discovery.go:176. The SystemOne
// endpoint has no equivalent in this package's protocol union, so those rows are
// intentionally skipped.
export async function fetchProtocolDocs(
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, ZenNativeProtocol>> {
  const response = await fetchImpl(endpoint, {
    headers: { accept: 'text/plain, text/markdown, */*', 'user-agent': openCodeUserAgent() },
  });
  if (!response.ok) {
    throw new Error(`endpoint documentation returned HTTP ${response.status}`);
  }
  const body = await response.text();
  const result: Record<string, ZenNativeProtocol> = {};
  for (const line of body.split('\n')) {
    const match = PROTOCOL_DOC_ENDPOINT.exec(line);
    if (!match) continue;
    const modelId = (match[1] ?? '').trim();
    if (!modelId || /[ `|]/.test(modelId)) continue;
    const protocol = protocolForEndpoint(match[2]);
    if (protocol) result[modelId] = protocol;
  }
  if (Object.keys(result).length === 0) {
    throw new Error('endpoint documentation returned no protocol rows');
  }
  return result;
}

export class ZenRefresher {
  private readonly config: ZenConfig;
  private readonly catalog: ZenCatalog;
  private readonly pricing: ZenPricingStore;
  private readonly fetchImpl: typeof fetch;
  private readonly cachePaths: { catalog?: string; pricing?: string };
  private readonly logger: ZenRefreshLogger;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private zenModels: string[] = [];
  private goModels: string[] = [];
  private native: ZenTierProtocols | undefined;
  private unsupported: ZenTierFlags | undefined;
  private metadata: ZenTierMetadata | undefined;
  private updatedAt = 0;
  private lastErrorMessage = '';
  private lastResult: ZenRefreshResult = {
    zen: 0,
    go: 0,
    total: 0,
    pricing: 0,
    capabilities: false,
    errors: [],
  };
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<ZenRefreshResult> | undefined;

  constructor(options: ZenRefresherOptions) {
    this.config = options.config;
    this.catalog = options.catalog;
    this.pricing = options.pricing;
    this.fetchImpl = options.fetchImpl;
    this.cachePaths = options.cachePaths ?? {};
    this.logger = options.logger ?? {};
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = Math.max(1, this.config.models.refreshSeconds) * 1000;
    this.catalog.setRefreshIntervalMs(this.intervalMs);
  }

  get lastError(): string {
    return this.lastErrorMessage;
  }

  get refreshIntervalMs(): number {
    return this.intervalMs;
  }

  async loadCache(): Promise<{ catalog: boolean; pricing: boolean }> {
    const summary = { catalog: false, pricing: false };
    if (this.cachePaths.catalog) {
      const raw = await readJsonCache<ZenCatalogCacheFile>(this.cachePaths.catalog);
      const parsed = parseCatalogCache(raw);
      if (parsed) {
        this.zenModels = parsed.zen;
        this.goModels = parsed.go;
        this.native = parsed.nativeProtocols;
        this.unsupported = parsed.unsupported;
        this.metadata = parsed.metadata;
        this.updatedAt = parsed.updatedAt;
        this.catalog.replace({
          zen: parsed.zen,
          go: parsed.go,
          native: parsed.nativeProtocols,
          unsupported: parsed.unsupported,
          metadata: parsed.metadata,
        });
        this.catalog.markLoadedFromCache(this.updatedAt);
        this.catalog.setRefreshIntervalMs(this.intervalMs);
        summary.catalog = true;
      }
    }
    if (this.cachePaths.pricing) {
      const raw = await readJsonCache<ZenPricingCacheFile>(this.cachePaths.pricing);
      const parsed = parsePricingCache(raw);
      if (parsed) {
        this.pricing.replace(parsed.models, parsed.updatedAt);
        summary.pricing = true;
      }
    }
    return summary;
  }

  async refreshOnce(): Promise<ZenRefreshResult> {
    // Single flight: a caller that arrives while a refresh is running joins that
    // refresh instead of receiving the previous snapshot. Returning lastResult
    // here would hand the caller a stale catalog, which is exactly what the
    // periodic refresher racing a request-driven refresh used to cause.
    if (this.inFlight) return this.inFlight;
    const run = this.runRefresh();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  private async runRefresh(): Promise<ZenRefreshResult> {
    const errors: string[] = [];
    try {
      const now = this.now();
      const [capabilities, zen, go] = await Promise.all([
        this.tryFetchCapabilities(errors),
        this.tryFetchModels(this.config.upstream.zen, this.zenKey(), errors),
        this.tryFetchModels(this.config.upstream.go, this.goKey(), errors),
      ]);
      const caps = capabilities ?? emptyCapabilities();
      await this.applyDocsFallback(caps);
      const capabilitiesOk = capabilities !== undefined || hasCapabilityData(caps);

      let changed = false;
      if (zen) {
        this.zenModels = zen;
        changed = true;
      }
      if (go) {
        this.goModels = go;
        changed = true;
      }
      if (capabilitiesOk) {
        this.native = caps.native;
        this.unsupported = caps.unsupported;
        this.metadata = caps.metadata;
        changed = true;
      }
      if (changed) {
        this.catalog.replace({
          ...(zen ? { zen } : {}),
          ...(go ? { go } : {}),
          ...(capabilitiesOk
            ? { native: caps.native, unsupported: caps.unsupported, metadata: caps.metadata }
            : {}),
        });
        this.catalog.setRefreshIntervalMs(this.intervalMs);
        this.updatedAt = now;
        await this.persistCatalogCache();
      }

      const pricingSnapshot = this.pricing.snapshot(this.now());
      const pricingCount =
        !pricingSnapshot.ready || pricingSnapshot.stale
          ? await this.tryRefreshPricing(now, errors)
          : pricingSnapshot.models;

      this.lastErrorMessage = errors.join('; ');
      const snapshot = this.catalog.snapshot();
      this.lastResult = {
        zen: snapshot.zen,
        go: snapshot.go,
        total: snapshot.total,
        pricing: pricingCount,
        capabilities: capabilitiesOk,
        errors,
      };
      return this.lastResult;
    } catch (error) {
      const message = errorMessage(error);
      errors.push(message);
      this.lastErrorMessage = errors.join('; ');
      this.logger.warn?.('zen refresh failed', { error: message });
      return this.lastResult;
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.refreshOnce();
    this.timer = setInterval(() => {
      void this.refreshOnce();
    }, this.intervalMs);
    // A started gateway must never be the reason a process stays alive: the CLI
    // and one-shot commands exit as soon as their work is done.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private zenKey(): string {
    return this.config.zenKeys[0] ?? PUBLIC_KEY;
  }

  private goKey(): string {
    return this.config.goKeys[0] ?? PUBLIC_KEY;
  }

  private endpoints(): CapabilityEndpoints {
    return { zen: ZEN_CAPABILITIES_URL, zenDocs: ZEN_DOCS_URL, goDocs: GO_DOCS_URL };
  }

  private async tryFetchCapabilities(errors: string[]): Promise<ZenCapabilities | undefined> {
    try {
      return await fetchCapabilities(this.endpoints(), this.fetchImpl);
    } catch (error) {
      errors.push(`capabilities: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async tryFetchModels(
    base: string,
    key: string,
    errors: string[],
  ): Promise<string[] | undefined> {
    try {
      return await fetchModels(base, key, this.fetchImpl);
    } catch (error) {
      errors.push(`models ${base}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async applyDocsFallback(caps: ZenCapabilities): Promise<void> {
    const docs: Array<{ tier: ZenTier; url: string }> = [
      { tier: 'zen', url: ZEN_DOCS_URL },
      { tier: 'go', url: GO_DOCS_URL },
    ];
    for (const doc of docs) {
      try {
        const protocols = await fetchProtocolDocs(doc.url, this.fetchImpl);
        const layer = (caps.native[doc.tier] ??= {});
        const unsupported = caps.unsupported[doc.tier];
        for (const [modelId, protocol] of Object.entries(protocols)) {
          layer[modelId] = protocol;
          if (unsupported) delete unsupported[modelId];
        }
      } catch {
        this.logger.debug?.('zen docs fallback unavailable', { tier: doc.tier });
      }
    }
  }

  private async tryRefreshPricing(now: number, errors: string[]): Promise<number> {
    try {
      const response = await this.fetchImpl(MODELS_DEV_URL, {
        headers: { accept: 'application/json', 'user-agent': openCodeUserAgent() },
      });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      const decoded = decodeModelsDev(await response.json());
      this.pricing.replace(decoded, now);
      if (this.cachePaths.pricing) {
        const cache: ZenPricingCacheFile = {
          updated_at: new Date(now).toISOString(),
          models: decoded,
        };
        await writeJsonCache(this.cachePaths.pricing, cache);
      }
      return Object.keys(decoded).length;
    } catch (error) {
      const message = errorMessage(error);
      errors.push(`pricing: ${message}`);
      this.pricing.recordError(message);
      return 0;
    }
  }

  private async persistCatalogCache(): Promise<void> {
    if (!this.cachePaths.catalog) return;
    try {
      const cache: ZenCatalogCacheFile = {
        schema_version: CATALOG_CACHE_SCHEMA_VERSION,
        updated_at: new Date(this.updatedAt || this.now()).toISOString(),
        zen: this.zenModels,
        go: this.goModels,
        native_protocols: this.native ?? {},
        unsupported: this.unsupported ?? {},
        metadata: this.metadata ?? {},
      };
      await writeJsonCache(this.cachePaths.catalog, cache);
    } catch (error) {
      this.logger.warn?.('zen catalog cache write failed', { error: errorMessage(error) });
    }
  }
}
