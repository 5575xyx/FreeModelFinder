import type { ModelInfo, ProviderId } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

interface KiloModel {
  id: string;
  name?: string;
  context_length?: number;
  description?: string;
  pricing?: { prompt?: number; completion?: number };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

const KILO_FREE_MODEL_IDS = new Set([
  'kilo-auto/free',
  'openrouter/auto',
  'openrouter/free',
  'openrouter/bodybuilder',
  'openrouter/pareto-code',
  'openrouter/owl-alpha',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'poolside/laguna-m.1:free',
  'stepfun/step-3.5-flash:free',
  'stepfun/step-3.7-flash:free',
  'inclusionai/ling-2.6-1t:free',
  'inclusionai/ling-3.0-flash-fin:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'inclusionai/ling-3.0-flash-vl:free',
  'tencent/hy3-preview:free',
  'x-ai/grok-code-fast-1:optimized:free',
  'baidu/qianfan-ocr-fast:free',
  'baidu/cobuddy:free',
  'google/lyria-3-clip-preview',
  'google/lyria-3-pro-preview',
  'cohere/north-mini-code:free',
  'deepseek/deepseek-v4-flash-0731:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
  'nex-agi/nex-n2.5-mini:free',
  'nex-agi/nex-n2.5-pro:free',
  'qwen/qwen3.8-27b:free',
  'thinkingmachines/inkling-small:free',
  'thinkingmachines/inkling:free',
  'z-ai/glm-5.2:free',
]);

export class KiloProvider extends OpenAICompatibleProvider {
  readonly id: ProviderId = 'kilo';
  readonly displayName = 'Kilo Code';

  protected baseUrl(): string {
    return this.ctx.credentials.baseUrl ?? 'https://api.kilo.ai/api/gateway';
  }

  protected override extraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://github.com/freemodelfinder',
      'X-Title': 'FreeModelFinder',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetch(`${this.baseUrl()}/models`, {
      headers: { authorization: `Bearer ${this.nextKey()}` },
    });
    if (!res.ok) throw new Error(`kilo list models failed: ${res.status}`);
    const data = (await res.json()) as { data: KiloModel[] };
    return data.data
      .filter((m) => {
        if (KILO_FREE_MODEL_IDS.has(m.id)) return true;
        const p = m.pricing?.prompt ?? null;
        const c = m.pricing?.completion ?? null;
        if (p === null || c === null) return false;
        return p === 0 && c === 0;
      })
      .map((m) => ({
        id: m.id,
        provider: this.id,
        displayName: m.name ?? m.id,
        contextWindow: m.context_length,
        free: true,
        description: m.description,
      }));
  }
}
