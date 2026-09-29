import type { ZenNativeProtocol } from '../config/index.js';
import { OPENCODE_CLIENT_HEADERS, openCodeUserAgent } from '../identity/client.js';
import type { ZenModelMetadata, ZenTier } from './types.js';

export interface ZenCapabilities {
  native: Partial<Record<ZenTier, Record<string, ZenNativeProtocol>>>;
  unsupported: Partial<Record<ZenTier, Record<string, boolean>>>;
  metadata: Partial<Record<ZenTier, Record<string, ZenModelMetadata>>>;
}

export interface CapabilityEndpoints {
  zen: string;
  go?: string;
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
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
    headers: {
      authorization: `Bearer ${key}`,
      ...OPENCODE_CLIENT_HEADERS,
      'user-agent': openCodeUserAgent(),
    },
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
  const res = await fetchImpl(endpoints.zen, {
    headers: { accept: 'application/json', 'user-agent': openCodeUserAgent() },
  });
  if (!res.ok) throw new Error(`capability endpoint returned HTTP ${res.status}`);
  const providers = asRecord(await res.json());
  if (!providers) throw new Error('capability endpoint returned no providers');
  const native: Record<ZenTier, Record<string, ZenNativeProtocol>> = { zen: {}, go: {} };
  const unsupported: Record<ZenTier, Record<string, boolean>> = { zen: {}, go: {} };
  const metadata: Record<ZenTier, Record<string, ZenModelMetadata>> = { zen: {}, go: {} };
  for (const [providerId, raw] of Object.entries(providers)) {
    const provider = asRecord(raw);
    if (!provider) continue;
    const tier = capabilityTier(providerId, str(provider['api']) ?? '');
    if (!tier) continue;
    const providerNpm = str(provider['npm']) ?? '';
    const models = asRecord(provider['models']);
    if (!models) continue;
    for (const [modelKey, rawModel] of Object.entries(models)) {
      const model = asRecord(rawModel);
      if (!model) continue;
      const modelIdRaw = str(model['id']);
      const modelId = modelIdRaw && modelIdRaw.trim() ? modelIdRaw : modelKey;
      const modelProvider = asRecord(model['provider']);
      const npmRaw = str(modelProvider?.['npm']);
      const npm = npmRaw && npmRaw.trim() ? npmRaw : providerNpm;
      const protocol = protocolForSdk(npm);
      if (protocol) native[tier][modelId] = protocol;
      else unsupported[tier][modelId] = true;
      metadata[tier][modelId] = metadataOf(model);
    }
  }
  const hasAny =
    Object.keys(native.zen).length > 0 ||
    Object.keys(native.go).length > 0 ||
    Object.keys(unsupported.zen).length > 0 ||
    Object.keys(unsupported.go).length > 0;
  if (!hasAny) throw new Error('capability endpoint returned no Zen or Go models');
  return { native, unsupported, metadata };
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
