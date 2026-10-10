import { z } from 'zod';

export const ReasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'none',
]);

export const NativeProtocolSchema = z.enum(['chat', 'responses', 'anthropic']);

export const ZenConfigSchema = z.object({
  anonymous: z.boolean().default(false),
  zenKeys: z.array(z.string()).default([]),
  goKeys: z.array(z.string()).default([]),
  prefer: z.enum(['go', 'zen']).default('go'),
  upstream: z
    .object({
      zen: z.string().default('https://opencode.ai/zen'),
      go: z.string().default('https://opencode.ai/zen/go'),
    })
    .default({}),
  proxies: z.array(z.string()).default([]),
  proxyfile: z.string().default(''),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      timeoutSeconds: z.number().int().min(1).default(300),
    })
    .default({}),
  performance: z
    .object({
      attemptTimeoutSeconds: z.number().int().min(0).default(0),
      connectTimeoutSeconds: z.number().int().min(0).default(15),
      failureCooldownSeconds: z.number().int().min(0).default(15),
      maxIdleConns: z.number().int().min(0).default(2048),
      maxIdleConnsPerHost: z.number().int().min(0).default(256),
      maxConnsPerHost: z.number().int().min(0).default(0),
      idleConnTimeoutSeconds: z.number().int().min(0).default(120),
    })
    .default({}),
  models: z
    .object({
      refreshSeconds: z.number().int().min(1).default(300),
      protocols: z.record(NativeProtocolSchema).default({}),
    })
    .default({}),
  reasoning: z
    .object({
      effort: ReasoningEffortSchema.optional(),
      effortByModel: z.record(ReasoningEffortSchema).default({}),
    })
    .default({}),
});

export type ZenConfig = z.infer<typeof ZenConfigSchema>;
export type ZenReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ZenNativeProtocol = z.infer<typeof NativeProtocolSchema>;

export const DEFAULT_ZEN_CONFIG = {
  retry: { maxAttempts: 3, timeoutSeconds: 300 },
} as const;

export function normalizeZenConfig(input: unknown): ZenConfig {
  const cfg = ZenConfigSchema.parse(input ?? {});
  return {
    ...cfg,
    zenKeys: [...cfg.zenKeys],
    goKeys: [...cfg.goKeys],
    proxies: [...cfg.proxies],
  };
}
