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
  'agnes-2.5-flash',
  'agnes-3.0-flash',
  'agnes-image-2.0-flash',
  'agnes-image-2.1-flash',
  'agnes-image-2.5-flash',
  'agnes-video-v2.0',
  'agnes-video-2.5-flash',
]);

const AGNES_STATIC_MODELS: Omit<ModelInfo, 'provider'>[] = [
  {
    id: 'agnes-2.5-flash',
    displayName: 'Agnes 2.5 Flash',
    free: true,
    description: 'Agnes 2.5 Flash, permanently free, optimized for coding and agent workflows.',
  },
  {
    id: 'agnes-3.0-flash',
    displayName: 'Agnes 3.0 Flash',
    free: true,
    description: 'Agnes 3.0 Flash, next-gen text model, permanently free.',
  },
  {
    id: 'agnes-image-2.0-flash',
    displayName: 'Agnes Image 2.0 Flash',
    free: true,
    description: 'Agnes Image 2.0 Flash, text-to-image and image editing, permanently free.',
  },
  {
    id: 'agnes-image-2.1-flash',
    displayName: 'Agnes Image 2.1 Flash',
    free: true,
    description: 'Agnes Image 2.1 Flash, upgraded image generation, permanently free.',
  },
  {
    id: 'agnes-image-2.5-flash',
    displayName: 'Agnes Image 2.5 Flash',
    free: true,
    description: 'Agnes Image 2.5 Flash, latest image model, permanently free.',
  },
  {
    id: 'agnes-video-v2.0',
    displayName: 'Agnes Video V2.0',
    free: true,
    description: 'Agnes Video V2.0, text-to-video and image-to-video, permanently free.',
  },
  {
    id: 'agnes-video-2.5-flash',
    displayName: 'Agnes Video 2.5 Flash',
    free: true,
    description: 'Agnes Video 2.5 Flash, video generation with first/last frame control, permanently free.',
  },
];

export class AgnesProvider extends OpenAICompatibleProvider {
  readonly id: ProviderId = 'agnes';
  readonly displayName = 'Agnes AI';

  protected baseUrl(): string {
    return this.ctx.credentials.baseUrl ?? 'https://api.agnes-ai.cn/v1';
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.fetch(`${this.baseUrl()}/models`, {
        headers: { authorization: `Bearer ${this.ctx.credentials.apiKey}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { data: AgnesModel[] };
        const dynamic = (Array.isArray(data.data) ? data.data : [])
          .filter((m): m is AgnesModel => typeof m?.id === 'string' && m.id.length > 0)
          .filter((m) => {
            if (AGNES_FREE_MODEL_IDS.has(m.id)) return true;
            const p = m.pricing?.prompt ?? null;
            const c = m.pricing?.completion ?? null;
            if (p === null || c === null) return false;
            return p === 0 && c === 0;
          })
          .map<ModelInfo>((m) => ({
            id: m.id,
            provider: this.id,
            displayName: m.name ?? m.id,
            contextWindow: m.context_length,
            free: true,
            description: m.description,
          }));
        if (dynamic.length > 0) return dynamic;
      }
    } catch {
      // Agnes may not expose /models endpoint; fall back to static list
    }
    return AGNES_STATIC_MODELS.map((m) => ({ ...m, provider: this.id }));
  }
}
