import type { ModelInfo } from './types.js';

const VISION_ID_RE =
  /vision|4v|vl|qwen2?\.?vl|glm-4v|llava|moondream|pixtral|mistral-small-vision|internvl|falcon-vision/i;

export function looksVisionModelId(modelId: string): boolean {
  return VISION_ID_RE.test(modelId);
}

export function withVisionInput(m: ModelInfo): ModelInfo {
  const cur = m.inputModalities ?? [];
  if (cur.includes('image')) return m;
  const base: Array<'text' | 'image'> = cur.length ? cur : ['text'];
  return { ...m, inputModalities: [...base, 'image'] };
}

export function isVisionCapable(m: ModelInfo, forcedVisionIds: readonly string[]): boolean {
  if (forcedVisionIds.includes(m.id)) return true;
  if (m.inputModalities?.includes('image')) return true;
  if (m.inputModalities && !m.inputModalities.includes('image')) return false;
  return looksVisionModelId(m.id);
}

export const MAX_IMAGE_DATA_BYTES = 10 * 1024 * 1024;

export function assertImageDataUrlWithinLimit(url: string): void {
  if (!url.startsWith('data:')) return;
  const comma = url.indexOf(',');
  if (comma < 0) return;
  const meta = url.slice(5, comma);
  const isBase64 = meta.endsWith(';base64');
  const payload = url.slice(comma + 1);
  const approxBytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
  if (approxBytes > MAX_IMAGE_DATA_BYTES) {
    throw new Error('image data URL exceeds 10MB limit');
  }
}
