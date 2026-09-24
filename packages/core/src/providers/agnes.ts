import type {
  ChatRequest,
  ChatResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelInfo,
  ProviderId,
  VideoGenerationRequest,
  VideoGenerationResponse,
} from '../types.js';
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
    capabilities: ['text'],
  },
  {
    id: 'agnes-3.0-flash',
    displayName: 'Agnes 3.0 Flash',
    free: true,
    description: 'Agnes 3.0 Flash, next-gen text model, permanently free.',
    capabilities: ['text'],
  },
  {
    id: 'agnes-image-2.0-flash',
    displayName: 'Agnes Image 2.0 Flash',
    free: true,
    description: 'Agnes Image 2.0 Flash, text-to-image and image editing, permanently free.',
    capabilities: ['image'],
  },
  {
    id: 'agnes-image-2.1-flash',
    displayName: 'Agnes Image 2.1 Flash',
    free: true,
    description: 'Agnes Image 2.1 Flash, upgraded image generation, permanently free.',
    capabilities: ['image'],
  },
  {
    id: 'agnes-image-2.5-flash',
    displayName: 'Agnes Image 2.5 Flash',
    free: true,
    description: 'Agnes Image 2.5 Flash, latest image model, permanently free.',
    capabilities: ['image'],
  },
  {
    id: 'agnes-video-v2.0',
    displayName: 'Agnes Video V2.0',
    free: true,
    description: 'Agnes Video V2.0, text-to-video and image-to-video, permanently free.',
    capabilities: ['video'],
  },
  {
    id: 'agnes-video-2.5-flash',
    displayName: 'Agnes Video 2.5 Flash',
    free: true,
    description:
      'Agnes Video 2.5 Flash, video generation with first/last frame control, permanently free.',
    capabilities: ['video'],
  },
];

export class AgnesProvider extends OpenAICompatibleProvider {
  readonly id: ProviderId = 'agnes';
  readonly displayName = 'Agnes AI';

  protected baseUrl(): string {
    return this.ctx.credentials.baseUrl ?? 'https://api.agnes-ai.cn/v1';
  }

  override async chat(req: ChatRequest): Promise<ChatResponse> {
    if (req.messages.some((m) => m.contentParts?.some((p) => p.type === 'image_url'))) {
      throw new Error(`Provider ${this.id} does not support image input`);
    }
    return super.chat(req);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await this.fetch(`${this.baseUrl()}/models`, {
        headers: { authorization: `Bearer ${this.nextKey()}` },
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
            capabilities: AGNES_FREE_MODEL_IDS.has(m.id)
              ? m.id.includes('image')
                ? ['image']
                : m.id.includes('video')
                  ? ['video']
                  : ['text']
              : ['text'],
          }));
        if (dynamic.length > 0) return dynamic;
      }
    } catch {
      // Agnes may not expose /models endpoint; fall back to static list
    }
    return AGNES_STATIC_MODELS.map((m) => ({ ...m, provider: this.id }));
  }

  private rootBase(): string {
    const base = this.baseUrl();
    return base.replace(/\/v1$/, '');
  }

  override async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const key = this.nextKey();
    if (!key) throw new Error('agnes API key not configured');

    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      size: req.size,
    };
    if (req.image && req.image.length > 0) {
      body.image = req.image;
    }

    const res = await this.fetch(`${this.baseUrl()}/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`agnes image generation failed ${res.status}: ${text}`);
    }

    return (await res.json()) as ImageGenerationResponse;
  }

  override async generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResponse> {
    const key = this.nextKey();
    if (!key) throw new Error('agnes API key not configured');

    const modelId = (req.model || '').split(':').pop() ?? req.model;
    const isV25 = /2\.5/.test(modelId);

    let body: Record<string, unknown>;

    if (isV25) {
      // agnes-video-2.5 / agnes-video-2.5-flash: new API
      body = {
        model: req.model,
        prompt: req.prompt,
        mode: 'text',
        size: '720P',
      };
      if (!/flash/i.test(modelId)) {
        body.size = req.size || '720P';
      }
      if (req.num_frames && req.frame_rate) {
        const secs = Math.round(req.num_frames / req.frame_rate);
        body.seconds = String(Math.min(12, Math.max(4, secs)));
      }
      if (req.source_images && req.source_images.length > 0) {
        const urls = req.source_images.map((i) => (typeof i === 'string' ? i : i.url));
        if (req.mode === 'keyframes') {
          body.mode = 'keyframe';
          if (urls[0]) body.first_frame = urls[0];
          if (urls[1]) body.last_frame = urls[1];
        } else {
          body.mode = 'reference';
          body.images = urls;
        }
      } else if (req.image && req.image.length > 0) {
        body.mode = 'reference';
        body.images = req.image;
      }
    } else {
      // agnes-video-v2.0: old API with width/height/num_frames/frame_rate
      body = {
        model: req.model,
        prompt: req.prompt,
        mode: 'ti2vid',
        width: req.width,
        height: req.height,
        num_frames: req.num_frames,
        frame_rate: req.frame_rate,
      };
      if (req.image && req.image.length > 0) {
        body.image = req.image;
      }
      if (req.source_images && req.source_images.length > 0) {
        body.image = req.source_images.map((i) => (typeof i === 'string' ? i : i.url));
        if (req.mode === 'keyframes') body.mode = 'keyframes';
      }
    }

    if (req.negative_prompt) body.negative_prompt = req.negative_prompt;
    if (req.seed != null) body.seed = Number(req.seed);

    if (req.extra_params && typeof req.extra_params === 'object') {
      for (const [k, v] of Object.entries(req.extra_params)) {
        if (k in body) continue;
        body[k] = v;
      }
    }

    const res = await this.fetch(`${this.baseUrl()}/videos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`agnes video creation failed ${res.status}: ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      video_id: (data.video_id as string) || (data.id as string) || '',
      status: (data.status as VideoGenerationResponse['status']) || 'queued',
    };
  }

  override async queryVideoStatus(videoId: string): Promise<VideoGenerationResponse> {
    const key = this.nextKey();
    if (!key) throw new Error('agnes API key not configured');

    const res = await this.fetch(
      `${this.rootBase()}/agnesapi?video_id=${encodeURIComponent(videoId)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${key}`,
        },
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`agnes video query failed ${res.status}: ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    // Agnes v2.0 returns the final video URL in remixed_from_video_id (naming is misleading but confirmed)
    const videoUrl =
      (data.remixed_from_video_id as string) ||
      (data.video_url as string) ||
      (data.output_url as string) ||
      (data.url as string) ||
      '';

    return {
      video_id: (data.video_id as string) || (data.id as string) || videoId,
      status: (data.status as VideoGenerationResponse['status']) || 'queued',
      video_url: videoUrl || undefined,
      progress: data.progress as number | undefined,
      error: data.error ? String(data.error) : undefined,
    };
  }
}
