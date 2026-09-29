// Ported from cline-free (MIT), https://github.com/Patrick-mufeng/cline-free
export interface ClineCatalogModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
}

export interface ClineCatalogOptions {
  dynamicModels?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

interface CatalogCache {
  models: ClineCatalogModel[] | null;
  at: number;
  inflight: Promise<ClineCatalogModel[] | null> | null;
}

const RECOMMENDED_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models';

const REQUEST_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (cline2api)',
};

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const cache: CatalogCache = { models: null, at: 0, inflight: null };

export function __resetCatalogCacheForTests(): void {
  cache.models = null;
  cache.at = 0;
  cache.inflight = null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeFreeGroup(payload: unknown): ClineCatalogModel[] {
  const root = asRecord(payload);
  const free = root?.free;
  if (!Array.isArray(free) || free.length === 0) {
    throw new Error('cline catalog: upstream payload has no free models');
  }
  const models: ClineCatalogModel[] = [];
  for (const entry of free) {
    const record = asRecord(entry);
    const id = record && typeof record.id === 'string' ? record.id.trim() : '';
    if (!record || !id) {
      throw new Error('cline catalog: free entry without id');
    }
    const model: ClineCatalogModel = { id };
    if (typeof record.name === 'string' && record.name.trim()) {
      model.name = record.name.trim();
    }
    if (typeof record.description === 'string') {
      model.description = record.description;
    }
    if (typeof record.context_length === 'number' && record.context_length > 0) {
      model.contextWindow = record.context_length;
    }
    models.push(model);
  }
  return models;
}

async function fetchUpstreamModels(opts: ClineCatalogOptions): Promise<ClineCatalogModel[]> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await fetchFn(RECOMMENDED_URL, {
    method: 'GET',
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`cline catalog: upstream responded ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error('cline catalog: upstream body too large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('cline catalog: upstream body too large');
  }
  return normalizeFreeGroup(JSON.parse(text));
}

async function refresh(opts: ClineCatalogOptions): Promise<ClineCatalogModel[] | null> {
  try {
    const models = await fetchUpstreamModels(opts);
    cache.models = models;
    cache.at = (opts.now ?? Date.now)();
    return models;
  } catch {
    return cache.models;
  }
}

export async function listClineCatalogModels(
  opts: ClineCatalogOptions = {},
): Promise<ClineCatalogModel[] | null> {
  try {
    if (opts.dynamicModels === false) return null;
    const now = opts.now ?? Date.now;
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const cached = cache.models;
    if (cached && now() - cache.at < ttlMs) return cached;
    if (cache.inflight) return await cache.inflight;
    const pending = refresh(opts);
    cache.inflight = pending;
    try {
      return await pending;
    } finally {
      if (cache.inflight === pending) cache.inflight = null;
    }
  } catch {
    return cache.models;
  }
}
