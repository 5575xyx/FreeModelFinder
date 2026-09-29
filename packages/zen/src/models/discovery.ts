import type { ZenNativeProtocol } from '../config/index.js';
import type { ZenModelMetadata, ZenTier } from './types.js';

export interface ZenCapabilities {
  native: Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>>;
  unsupported: Partial<Record<ZenTier, Record<string, boolean>>>;
  metadata: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>>;
}

export interface CapabilityEndpoints {
  zen: string;
  go: string;
  zenDocs?: string;
  goDocs?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function protocolForSdk(npm: string): ZenNativeProtocol | undefined {
  const value = npm.trim().toLowerCase();
  if (value.includes('anthropic')) return 'anthropic';
  if (value === '@ai-sdk/openai' || value.endsWith('/openai')) return 'responses';
  if (value.includes('openai-compatible')) return 'chat';
  return undefined;
}

export function capabilityTier(providerId: string, api: string): ZenTier | undefined {
  const value = `${providerId} ${api}`.toLowerCase();
  if (value.includes('opencode-go') || value.includes('/go/')) return 'go';
  if (value.includes('opencode') || value.includes('/zen/')) return 'zen';
  return undefined;
}

export async function fetchModels(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`models endpoint returned HTTP ${res.status}`);
  const payload = asRecord(await res.json());
  const data = Array.isArray(payload?.['data']) ? (payload?.['data'] as unknown[]) : [];
  const ids: string[] = [];
  for (const item of data) {
    const id = str(asRecord(item)?.['id']);
    if (id) ids.push(id);
  }
  if (ids.length === 0) throw new Error('models endpoint returned an empty list');
  return ids;
}

export async function fetchCapabilities(
  endpoints: CapabilityEndpoints,
  fetchImpl: typeof fetch,
): Promise<ZenCapabilities> {
  const res = await fetchImpl(endpoints.zen);
  if (!res.ok) throw new Error(`capability endpoint returned HTTP ${res.status}`);
  const providers = asRecord(await res.json());
  if (!providers) throw new Error('capability endpoint returned no providers');
  const result: ZenCapabilities = {
    native: { zen: {}, go: {} },
    unsupported: { zen: {}, go: {} },
    metadata: { zen: {}, go: {} },
  };
  for (const [providerId, raw] of Object.entries(providers)) {
    const provider = asRecord(raw);
    if (!provider) continue;
    const tier = capabilityTier(providerId, str(provider['api']) ?? '');
    if (!tier) continue;
    const providerNpm = str(provider['npm']) ?? '';
    const models = asRecord(provider['models']);
    if (!models) continue;
    const nativeLayer = result.native[tier] as Record<string, ZenNativeProtocol>;
    const unsupportedLayer = result.unsupported[tier] as Record<string, boolean>;
    const metadataLayer = result.metadata[tier] as Record<string, ZenModelMetadata>;
    for (const [modelKey, rawModel] of Object.entries(models)) {
      const model = asRecord(rawModel);
      if (!model) continue;
      const modelId = str(model['id']) ?? modelKey;
      const modelProvider = asRecord(model['provider']);
      const npm = str(modelProvider?.['npm']) ?? providerNpm;
      const protocol = protocolForSdk(npm);
      if (protocol) nativeLayer[modelId] = protocol;
      else unsupportedLayer[modelId] = true;
      metadataLayer[modelId] = metadataOf(model);
    }
  }
  return result;
}

function metadataOf(model: Record<string, unknown>): ZenModelMetadata {
  const limit = asRecord(model['limit']);
  const modalities = asRecord(model['modalities']);
  const input = Array.isArray(modalities?.['input'])
    ? (modalities?.['input'] as unknown[]).filter(
        (value): value is string => typeof value === 'string',
      )
    : undefined;
  const output = Array.isArray(modalities?.['output'])
    ? (modalities?.['output'] as unknown[]).filter(
        (value): value is string => typeof value === 'string',
      )
    : undefined;
  const md: ZenModelMetadata = {};
  const context = num(limit?.['context']);
  const maxInput = num(limit?.['input']);
  const maxOutput = num(limit?.['output']);
  if (context !== undefined) md.contextWindow = context;
  if (maxInput !== undefined) md.maxInput = maxInput;
  if (maxOutput !== undefined) md.maxOutput = maxOutput;
  if (model['reasoning'] === true) md.reasoning = true;
  if (model['tool_call'] === true) md.toolCall = true;
  if (model['structured_output'] === true) md.structuredOutput = true;
  if (input) md.inputModalities = input;
  if (output) md.outputModalities = output;
  return md;
}
