import type { ModelInfo } from './types.js';

const VISION_ID_RE =
  /vision|4v|vl|qwen2?\.?vl|glm-4v|llava|moondream|pixtral|mistral-small-vision|internvl|falcon-vision/i;

export function looksVisionModelId(modelId: string): boolean {
  return VISION_ID_RE.test(modelId);
}

export function withVisionInput(m: ModelInfo): ModelInfo {
  const cur = m.inputModalities ?? [];
  if (cur.includes('image')) return m;
  const base = cur.length ? cur : ['text'];
  return { ...m, inputModalities: [...base, 'image'] };
}

export function isVisionCapable(m: ModelInfo, forcedVisionIds: readonly string[]): boolean {
  if (forcedVisionIds.includes(m.id)) return true;
  if (m.inputModalities?.includes('image')) return true;
  if (m.inputModalities && !m.inputModalities.includes('image')) return false;
  return looksVisionModelId(m.id);
}
