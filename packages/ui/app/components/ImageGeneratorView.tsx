'use client';

import { useCallback, useMemo, useState } from 'react';
import { Download, Image, Loader2, Wand2 } from 'lucide-react';
import { modelValue, type ModelItem } from '../lib/models';
import { GATEWAY } from '../lib/utils';
import { useI18n } from '../i18n';

type GeneratedImage = {
  url?: string;
  b64_json?: string;
  prompt: string;
  model: string;
  size: string;
};

export function ImageGeneratorView({
  models,
  model,
  onModelChange,
}: {
  models: ModelItem[];
  model: string;
  onModelChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [generating, setGenerating] = useState(false);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [error, setError] = useState('');

  const imageModels = useMemo(
    () => models.filter((m) => m.capabilities?.includes('image')),
    [models],
  );

  const selectedModel = useMemo(
    () => models.find((m) => modelValue(m) === model),
    [models, model],
  );

  const isImageModel = selectedModel?.capabilities?.includes('image') ?? false;

  const generate = useCallback(async () => {
    if (!prompt.trim() || generating || !model) return;
    setGenerating(true);
    setError('');

    try {
      const response = await fetch(
        `${GATEWAY}/v1/images/generations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: prompt.trim(), size, n: 1 }),
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || `HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        data?: Array<{ url?: string; b64_json?: string }>;
      };

      const item = data.data?.[0];
      if (!item?.url && !item?.b64_json) {
        throw new Error('No image data returned');
      }

      setImages((prev) => [
        {
          url: item.url,
          b64_json: item.b64_json,
          prompt: prompt.trim(),
          model,
          size,
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, [prompt, generating, model, size]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border bg-background px-5 py-4 md:px-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="img-model"
              className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"
            >
              {t('imagegen.model')}
            </label>
            <select
              id="img-model"
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={imageModels.length === 0}
              className="h-11 w-full rounded-xl border border-input bg-surface px-3 text-sm font-medium text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {imageModels.length === 0 && (
                <option value="">{t('imagegen.noModels')}</option>
              )}
              {imageModels.map((item) => (
                <option key={modelValue(item)} value={modelValue(item)}>
                  {item.provider} · {item.display_name ?? item.id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 sm:pt-5">
            <label
              htmlFor="img-size"
              className="text-[11px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"
            >
              {t('imagegen.size')}
            </label>
            <select
              id="img-size"
              value={size}
              onChange={(event) => setSize(event.target.value)}
              className="h-11 rounded-xl border border-input bg-surface px-3 text-sm outline-none focus:border-ring focus:ring-4 focus:ring-ring/10"
            >
              <option value="512x512">512×512</option>
              <option value="768x768">768×768</option>
              <option value="1024x1024">1024×1024</option>
              <option value="1024x1792">1024×1792</option>
              <option value="1792x1024">1792×1024</option>
            </select>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-5 py-7 md:px-8">
          {!isImageModel && imageModels.length > 0 && (
            <div className="mb-5 rounded-2xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning">
              {t('imagegen.selectImageModel')}
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
              {error}
            </div>
          )}

          {images.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {images.map((img, index) => {
                const src = img.url || (img.b64_json ? `data:image/png;base64,${img.b64_json}` : '');
                return (
                  <div key={`${img.model}-${index}`} className="group rounded-2xl border border-border bg-surface overflow-hidden">
                    <div className="relative aspect-square bg-surface-muted">
                      {src ? (
                        <img
                          src={src}
                          alt={img.prompt}
                          className="h-full w-full object-contain"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-muted-foreground">
                          <Image size={32} />
                        </div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                        {src && (
                          <a
                            href={src}
                            download={`fmf-image-${Date.now()}.png`}
                            className="flex items-center gap-2 rounded-xl bg-white/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-white"
                          >
                            <Download size={14} />
                            {t('imagegen.download')}
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="p-3">
                      <p className="line-clamp-2 text-xs text-muted-foreground">{img.prompt}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground/70">
                        {img.model} · {img.size}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {images.length === 0 && !generating && (
            <div className="py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface">
                <Image className="text-muted-foreground" size={20} />
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">{t('imagegen.empty.title')}</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {t('imagegen.empty.body')}
              </p>
            </div>
          )}

          {generating && (
            <div className="flex flex-col items-center py-16 text-center">
              <Loader2 className="animate-spin text-primary" size={32} />
              <p className="mt-4 text-sm text-muted-foreground">{t('imagegen.generating')}</p>
            </div>
          )}
        </div>
      </div>

      <form
        className="border-t border-border bg-background px-5 py-4 md:px-8"
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        <div className="mx-auto max-w-4xl">
          <div className="flex items-end gap-2 rounded-2xl border border-input bg-surface p-2 shadow-sm transition focus-within:border-ring focus-within:shadow-[0_0_0_4px_hsl(var(--ring)/0.08)]">
            <textarea
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void generate();
                }
              }}
              placeholder={t('imagegen.placeholder')}
              disabled={generating || imageModels.length === 0}
              className="max-h-[120px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/65 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={generating || !prompt.trim() || !model}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {generating ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Wand2 size={17} strokeWidth={2} />
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
