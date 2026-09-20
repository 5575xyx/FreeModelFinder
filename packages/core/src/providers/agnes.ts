import type { ModelInfo, ProviderId } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

interface AgnesModel {
  id: string;
  name?: string;
  context_length?: number;
  description?: string;
  pricing?: { prompt?: number; completion?: number };
}

const AGNES_FREE_MODEL_IDS = new Set([
  'agnes-2.0-flash',
  'agnes-2.5-flash',
  'agnes-2.1-flash',
  'agnes-video-v2.0',
]);

export class AgnesProvider extends OpenAICompatibleProvider {
  readonly id: ProviderId = 'agnes';
  readonly displayName = 'Agnes AI';

  protected baseUrl(): string {
    return this.ctx.credentials.baseUrl ?? 'https://api.agnes-ai.cn/v1';
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetch(`${this.baseUrl()}/models`, {
      headers: { authorization: `Bearer ${this.ctx.credentials.apiKey}` },
    });
    if (!res.ok) throw new Error(`agnes list models failed: ${res.status}`);
    const data = (await res.json()) as { data: AgnesModel[] };
    return data.data
      .filter((m) => {
        if (AGNES_FREE_MODEL_IDS.has(m.id)) return true;
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
