export type ModelTier = 'flagship' | 'large' | 'standard' | 'small' | 'minor' | 'tiny';

export interface ModelProfile {
  tier: ModelTier;
  generation: number | null;
}

export const TIER_SCORES: Record<ModelTier, number> = Object.freeze({
  flagship: 95,
  large: 80,
  standard: 50,
  small: 65,
  minor: 45,
  tiny: 30,
});

const TINY_PATTERNS = [/tiny/i, /\b(?:1|2|3)b\b/i];

const MINOR_PATTERNS = [/small/i, /nano/i, /\b(?:7|8|9|10)b\b/i];

const SMALL_PATTERNS = [
  /\bmini\b/i,
  /flash/i,
  /haiku/i,
  /\blite\b/i,
  /mixtral/i,
  /command-r/i,
  /\b(?:13|14|20)b\b/i,
];

const FLAGSHIP_PATTERNS = [
  /opus/i,
  /gpt-5/i,
  /gpt-4o/i,
  /deepseek-r1/i,
  /deepseek-v3/i,
  /glm-4\.5/i,
  /qwen-max/i,
  /gemini-2\.5-pro/i,
  /claude-3\.5/i,
  /\b(?:65|70|72|80|405)b\b/i,
];

const LARGE_PATTERNS = [
  /gpt-4/i,
  /glm-4/i,
  /gemini-2\.0/i,
  /deepseek-v2/i,
  /qwen-plus/i,
  /sonnet/i,
  /\b(?:30|32|34|40)b\b/i,
];

const GENERATION_PATTERNS = [
  /gpt-(\d+(?:\.\d+)?)/i,
  /claude-(\d+(?:\.\d+)?)/i,
  /glm-(\d+(?:\.\d+)?)/i,
  /gemini-(\d+(?:\.\d+)?)/i,
  /deepseek-v(\d+(?:\.\d+)?)/i,
  /qwen[-_]?(\d+(?:\.\d+)?)/i,
  /llama[-_]?(\d+(?:\.\d+)?)/i,
];

function hasMatch(patterns: RegExp[], id: string): boolean {
  return patterns.some((p) => p.test(id));
}

export function parseModelProfile(id: string): ModelProfile {
  const normalized = id.replace(/_/g, '-');
  let tier: ModelTier = 'standard';
  if (hasMatch(TINY_PATTERNS, normalized)) tier = 'tiny';
  else if (hasMatch(MINOR_PATTERNS, normalized)) tier = 'minor';
  else if (hasMatch(SMALL_PATTERNS, normalized)) tier = 'small';
  else if (hasMatch(FLAGSHIP_PATTERNS, normalized)) tier = 'flagship';
  else if (hasMatch(LARGE_PATTERNS, normalized)) tier = 'large';

  let generation: number | null = null;
  for (const p of GENERATION_PATTERNS) {
    const m = normalized.match(p);
    if (m?.[1]) {
      generation = Number.parseFloat(m[1]);
      break;
    }
  }
  return { tier, generation };
}
