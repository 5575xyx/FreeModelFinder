import type { ModelInfo, ProviderId } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

interface QianfanModel {
  id: string;
  object?: string;
  owned_by?: string;
}

const QIANFAN_STATIC_MODELS: ModelInfo[] = [];

const QIANFAN_FREE_MODELS = new Set<string>(QIANFAN_STATIC_MODELS.map((m) => m.id));

export class QianfanProvider extends OpenAICompatibleProvider {
  readonly id: ProviderId = 'qianfan';
  readonly displayName = 'Baidu Qianfan';

  protected baseUrl(): string {
    return this.ctx.credentials.baseUrl ?? 'https://qianfan.baidubce.com/v2';
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.fetch(`${this.baseUrl()}/models`, {
        headers: { authorization: `Bearer ${this.nextKey()}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: QianfanModel[] };
        const list = Array.isArray(data.data) ? data.data : [];
        const staticById = new Map(QIANFAN_STATIC_MODELS.map((m) => [m.id.toLowerCase(), m]));
        const picked: ModelInfo[] = [];
        const seen = new Set<string>();
        for (const entry of list) {
          const raw = typeof entry?.id === 'string' ? entry.id : '';
          const id = raw.toLowerCase();
          if (!id || seen.has(id) || !QIANFAN_FREE_MODELS.has(id)) continue;
          const staticModel = staticById.get(id);
          if (!staticModel) continue;
          seen.add(id);
          picked.push({ ...staticModel, id: raw });
        }
        if (picked.length > 0) return picked;
      }
    } catch {
      // fall back to static list
    }
    return QIANFAN_STATIC_MODELS.map((m) => ({ ...m }));
  }
}
