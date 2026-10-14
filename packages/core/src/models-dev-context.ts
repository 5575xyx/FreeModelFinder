import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config/store.js';

const CACHE_FILE = 'models.dev.context.json';
const MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Decode a models.dev payload into a provider-agnostic `model id -> context
 * window` table, used to backfill context windows that a provider never
 * published (Cline's recommended-models list carries no context_length, for
 * one). The same model appears under many providers with disagreeing limits,
 * so each key is a majority vote over every occurrence — ties resolve to the
 * smaller window, because the router treats contextWindow as a hard ceiling
 * (`inputTokens <= contextWindow * 0.95`) and an inflated one routes requests
 * upstream only to be truncated.
 *
 * Both the record id and its `canonical_model_id` are indexed: gateway-facing
 * ids arrive bare (`deepseek-v4.1-flash`) or source-prefixed
 * (`deepseek/deepseek-v4-flash`), and only a second index answers the latter.
 *
 * Throws on a payload that yields nothing: an empty table would otherwise be
 * cached over a good one, silently wiping every context window we knew.
 */
export function decodeContextTable(data: unknown): Map<string, number> {
  const providers = asRecord(data);
  if (!providers) throw new Error('models.dev payload is not an object');
  const votes = new Map<string, Map<number, number>>();
  for (const provider of Object.values(providers)) {
    const models = asRecord(asRecord(provider)?.['models']);
    if (!models) continue;
    for (const [recordKey, raw] of Object.entries(models)) {
      const model = asRecord(raw);
      if (!model) continue;
      const context = asRecord(model['limit'])?.['context'];
      if (typeof context !== 'number' || context <= 0) continue;
      const rawId = model['id'];
      const primary = typeof rawId === 'string' && rawId.trim() ? rawId : recordKey;
      const canonical = model['canonical_model_id'];
      const keys =
        typeof canonical === 'string' && canonical.trim() ? [primary, canonical] : [primary];
      for (const key of keys) {
        const perKey = votes.get(key) ?? new Map<number, number>();
        perKey.set(context, (perKey.get(context) ?? 0) + 1);
        votes.set(key, perKey);
      }
    }
  }
  const table = new Map<string, number>();
  for (const [key, perKey] of votes) {
    let best: number | undefined;
    let bestCount = -1;
    for (const [context, count] of perKey) {
      if (count > bestCount || (count === bestCount && context < (best ?? Infinity))) {
        best = context;
        bestCount = count;
      }
    }
    if (best !== undefined) table.set(key, best);
  }
  if (table.size === 0) throw new Error('models.dev contains no context metadata');
  return table;
}

export interface ModelsDevContextOptions {
  dir?: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Holds the decoded context table behind a synchronous `lookup`, so the model
 * refresh path can backfill missing context windows without ever awaiting a
 * network call. Disk and network loading are separate, explicitly-triggered
 * operations that never reject — a gateway listing 114 models must not fail
 * because models.dev is slow, and a corrupt cache must not take the process
 * down with it.
 */
export class ModelsDevContextStore {
  private table = new Map<string, number>();
  private updatedAt = 0;
  private lastError = '';
  private loaded = false;
  private readonly dir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: ModelsDevContextOptions = {}) {
    this.dir = options.dir ?? CONFIG_DIR;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  private get cachePath(): string {
    return join(this.dir, CACHE_FILE);
  }

  /**
   * Two-tier match: the id exactly as the gateway reported it, then — only
   * when it carries a source prefix — its last segment. There is no fuzzy
   * matching: a wrong context window routes a request into a truncation the
   * user did not ask for, so an unknown id stays unknown.
   */
  lookup(model: { provider: string; id: string }): number | undefined {
    const direct = this.table.get(model.id);
    if (direct !== undefined) return direct;
    const slash = model.id.lastIndexOf('/');
    if (slash < 0 || slash === model.id.length - 1) return undefined;
    return this.table.get(model.id.slice(slash + 1));
  }

  /**
   * Idempotent warm-up: awaits only the local disk read, so callers on the
   * model-listing path pay a few milliseconds at most. The network refresh it
   * may kick off runs detached — models.dev answering in 10s must not become
   * the next `listModels timed out after 20000ms` report.
   */
  async ensureFresh(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      await this.loadFromDisk();
      if (this.table.size === 0 || this.now() - this.updatedAt > this.ttlMs) {
        void this.refresh();
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as {
        updated_at?: unknown;
        table?: unknown;
      };
      const table = parsed?.table;
      if (typeof table !== 'object' || table === null) return;
      this.table = new Map(
        Object.entries(table as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      );
      this.updatedAt = typeof parsed.updated_at === 'number' ? parsed.updated_at : 0;
      this.lastError = '';
    } catch (error) {
      // Missing or corrupt cache: keep whatever table we already hold.
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async refresh(): Promise<void> {
    try {
      const response = await this.fetchImpl(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`models.dev responded with ${response.status}`);
      const table = decodeContextTable(await response.json());
      this.table = table;
      this.updatedAt = this.now();
      this.lastError = '';
      this.writeToDisk();
    } catch (error) {
      // A payload with no context metadata throws inside decodeContextTable;
      // swallowing it here keeps the previous table and its cache file alive.
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.loadFromDisk();
    }
  }

  private writeToDisk(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        this.cachePath,
        JSON.stringify({ updated_at: this.updatedAt, table: Object.fromEntries(this.table) }),
      );
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

let singleton: ModelsDevContextStore | null = null;

/**
 * Deliberately cold: constructing the singleton loads nothing and fetches
 * nothing, so tests that merely touch the registry can never reach the real
 * cache directory or the network. Callers that want data call `ensureFresh()`
 * on it (registry, background refresh) or `warmModelsDevContext()` at startup.
 */
export function modelsDevContextStore(): ModelsDevContextStore {
  singleton ??= new ModelsDevContextStore();
  return singleton;
}

export async function warmModelsDevContext(): Promise<void> {
  await modelsDevContextStore().ensureFresh();
}

/** Test seam: pass a store to replace the singleton, or nothing to clear it. */
export function __setModelsDevContextForTests(store?: ModelsDevContextStore): void {
  singleton = store ?? null;
}
