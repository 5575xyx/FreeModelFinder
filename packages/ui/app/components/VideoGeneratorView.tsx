'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Film, Loader2, Play, Square, Video } from 'lucide-react';
import { modelValue, type ModelItem } from '../lib/models';
import { classNames, GATEWAY, withUiHeaders } from '../lib/utils';
import { useI18n } from '../i18n';

type VideoTask = {
  video_id: string;
  status: string;
  video_url?: string;
  proxyBlobUrl?: string;
  progress?: number;
  prompt: string;
  model: string;
  provider: string;
  created_at: number;
};

const POLL_INTERVAL = 8000;
const MAX_POLLS = 120;

async function fetchProxied(videoUrl: string, provider: string): Promise<string> {
  const resp = await fetch(
    `${GATEWAY}/v1/videos/proxy`,
    withUiHeaders({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: videoUrl, provider }),
    }),
  );
  if (!resp.ok) throw new Error(`proxy failed ${resp.status}`);
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

export function VideoGeneratorView({
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
  const [negativePrompt, setNegativePrompt] = useState('');
  const [width, setWidth] = useState(1152);
  const [height, setHeight] = useState(768);
  const [frames, setFrames] = useState(121);
  const [fps, setFps] = useState(24);
  const [submitting, setSubmitting] = useState(false);
  const [tasks, setTasks] = useState<VideoTask[]>([]);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pollCounts = useRef<Map<string, number>>(new Map());

  const videoModels = models.filter((m) => m.capabilities?.includes('video'));
  const selectedModel = models.find((m) => modelValue(m) === model);
  const isVideoModel = selectedModel?.capabilities?.includes('video') ?? false;

  const stopPolling = useCallback((videoId: string) => {
    const timer = pollTimers.current.get(videoId);
    if (timer) {
      clearTimeout(timer);
      pollTimers.current.delete(videoId);
    }
    pollCounts.current.delete(videoId);
  }, []);

  const pollVideo = useCallback(
    async (videoId: string, providerId: string) => {
      const count = (pollCounts.current.get(videoId) ?? 0) + 1;
      pollCounts.current.set(videoId, count);

      if (count > MAX_POLLS) {
        stopPolling(videoId);
        setTasks((prev) =>
          prev.map((t) =>
            t.video_id === videoId ? { ...t, status: 'poll_timeout' } : t,
          ),
        );
        return;
      }

      try {
        const response = await fetch(
          `${GATEWAY}/v1/videos/status`,
          withUiHeaders({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: videoId, provider: providerId }),
          }),
        );
        if (!response.ok) return;

        const data = (await response.json()) as {
          status?: string;
          video_url?: string;
          progress?: number;
        };

        setTasks((prev) =>
          prev.map((t) =>
            t.video_id === videoId
              ? {
                  ...t,
                  status: data.status ?? t.status,
                  video_url: data.video_url ?? t.video_url,
                  progress: data.progress ?? t.progress,
                }
              : t,
          ),
        );

        if (data.status === 'completed' || data.status === 'failed') {
          stopPolling(videoId);
          if (data.status === 'completed' && data.video_url) {
            try {
              const blobUrl = await fetchProxied(data.video_url, providerId);
              setTasks((prev) =>
                prev.map((t) =>
                  t.video_id === videoId ? { ...t, proxyBlobUrl: blobUrl } : t,
                ),
              );
            } catch {
              // proxy fetch failed, will show fallback message
            }
          }
          return;
        }
      } catch {
        // single poll failure, continue
      }

      pollTimers.current.set(
        videoId,
        setTimeout(() => void pollVideo(videoId, providerId), POLL_INTERVAL),
      );
    },
    [stopPolling],
  );

  useEffect(() => {
    return () => {
      for (const timer of pollTimers.current.values()) clearTimeout(timer);
      pollTimers.current.clear();
      pollCounts.current.clear();
    };
  }, []);

  const submit = useCallback(async () => {
    if (!prompt.trim() || submitting || !model) return;
    setSubmitting(true);
    setError('');

    try {
      const providerId = model.split(':')[0] ?? '';
      const body = {
        model,
        prompt: prompt.trim(),
        negative_prompt: negativePrompt.trim() || undefined,
        width,
        height,
        num_frames: frames,
        frame_rate: fps,
      };

      const response = await fetch(
        `${GATEWAY}/v1/videos`,
        withUiHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || `HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        video_id?: string;
        status?: string;
      };

      if (!data.video_id) {
        throw new Error('No video_id returned');
      }

      const task: VideoTask = {
        video_id: data.video_id,
        status: data.status ?? 'queued',
        prompt: prompt.trim(),
        model,
        provider: providerId,
        created_at: Date.now(),
      };

      setTasks((prev) => [task, ...prev]);
      setPrompt('');
      setNegativePrompt('');

      // start polling
      void pollVideo(data.video_id, providerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [prompt, negativePrompt, model, submitting, width, height, frames, fps, pollVideo]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border bg-background px-5 py-4 md:px-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="vid-model"
              className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"
            >
              {t('videogen.model')}
            </label>
            <select
              id="vid-model"
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={videoModels.length === 0}
              className="h-11 w-full rounded-xl border border-input bg-surface px-3 text-sm font-medium text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {videoModels.length === 0 && (
                <option value="">{t('videogen.noModels')}</option>
              )}
              {videoModels.map((item) => (
                <option key={modelValue(item)} value={modelValue(item)}>
                  {item.provider} · {item.display_name ?? item.id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 sm:pt-5">
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
            >
              <Film size={14} />
              {showSettings ? t('videogen.hideSettings') : t('videogen.showSettings')}
            </button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-5 py-7 md:px-8">
          {!isVideoModel && videoModels.length > 0 && (
            <div className="mb-5 rounded-2xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning">
              {t('videogen.selectVideoModel')}
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
              {error}
            </div>
          )}

          {tasks.length > 0 && (
            <div className="space-y-4">
              {tasks.map((task) => {
                const isComplete = task.status === 'completed';
                const isFailed = task.status === 'failed';
                const isPolling =
                  task.status === 'queued' || task.status === 'in_progress' || task.status === 'polling';
                return (
                  <div
                    key={task.video_id}
                    className={classNames(
                      'rounded-2xl border bg-surface p-4',
                      isComplete
                        ? 'border-success/30'
                        : isFailed
                          ? 'border-destructive/30'
                          : 'border-border',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{task.prompt}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {task.model} · {task.video_id.slice(0, 12)}…
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {isPolling && (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 size={12} className="animate-spin" />
                            {task.status}
                            {task.progress != null && ` ${task.progress}%`}
                          </span>
                        )}
                        {isComplete && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                            {t('videogen.done')}
                          </span>
                        )}
                        {isFailed && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                            {t('videogen.failed')}
                          </span>
                        )}
                      </div>
                    </div>

                    {(task.proxyBlobUrl || task.video_url) && (
                      <div className="mt-3">
                        {task.proxyBlobUrl ? (
                          <video
                            src={task.proxyBlobUrl}
                            controls
                            preload="metadata"
                            className="w-full max-h-[400px] rounded-xl border border-border bg-black"
                          />
                        ) : (
                          <div className="rounded-xl border border-dashed border-yellow-400/50 bg-yellow-400/5 p-4 text-xs text-yellow-600 dark:text-yellow-400">
                            {t('videogen.proxyFetchFailed') ?? '视频需要代理加载，请稍候...'}
                          </div>
                        )}
                        <div className="mt-2 flex gap-2">
                          {task.proxyBlobUrl && (
                            <a
                              href={task.proxyBlobUrl}
                              download={`fmf-video-${task.video_id}.mp4`}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-surface"
                            >
                              <Download size={12} />
                              {t('videogen.download')}
                            </a>
                          )}
                        </div>
                      </div>
                    )}

                    {isPolling && !task.video_url && (
                      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                        <Play size={12} />
                        {t('videogen.processing')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tasks.length === 0 && !submitting && (
            <div className="py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface">
                <Video className="text-muted-foreground" size={20} />
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">{t('videogen.empty.title')}</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {t('videogen.empty.body')}
              </p>
            </div>
          )}

          {submitting && (
            <div className="flex flex-col items-center py-16 text-center">
              <Loader2 className="animate-spin text-primary" size={32} />
              <p className="mt-4 text-sm text-muted-foreground">{t('videogen.submitting')}</p>
            </div>
          )}
        </div>
      </div>

      <form
        className="border-t border-border bg-background px-5 py-4 md:px-8"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="mx-auto max-w-4xl space-y-2">
          {showSettings && (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface p-3 sm:grid-cols-4">
              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">{t('videogen.width')}</label>
                <select
                  value={width}
                  onChange={(event) => setWidth(Number(event.target.value))}
                  className="h-9 w-full rounded-lg border border-input bg-surface px-2 text-xs outline-none focus:ring-2 focus:ring-ring/10"
                >
                  <option value={512}>512</option>
                  <option value={768}>768</option>
                  <option value={1152}>1152</option>
                  <option value={1280}>1280</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">{t('videogen.height')}</label>
                <select
                  value={height}
                  onChange={(event) => setHeight(Number(event.target.value))}
                  className="h-9 w-full rounded-lg border border-input bg-surface px-2 text-xs outline-none focus:ring-2 focus:ring-ring/10"
                >
                  <option value={512}>512</option>
                  <option value={768}>768</option>
                  <option value={960}>960</option>
                  <option value={1152}>1152</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">{t('videogen.frames')}</label>
                <select
                  value={frames}
                  onChange={(event) => setFrames(Number(event.target.value))}
                  className="h-9 w-full rounded-lg border border-input bg-surface px-2 text-xs outline-none focus:ring-2 focus:ring-ring/10"
                >
                  <option value={81}>81 (~3s)</option>
                  <option value={121}>121 (~5s)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">{t('videogen.fps')}</label>
                <select
                  value={fps}
                  onChange={(event) => setFps(Number(event.target.value))}
                  className="h-9 w-full rounded-lg border border-input bg-surface px-2 text-xs outline-none focus:ring-2 focus:ring-ring/10"
                >
                  <option value={16}>16</option>
                  <option value={24}>24</option>
                  <option value={30}>30</option>
                </select>
              </div>
            </div>
          )}

          <div className="flex items-end gap-2 rounded-2xl border border-input bg-surface p-2 shadow-sm transition focus-within:border-ring focus-within:shadow-[0_0_0_4px_hsl(var(--ring)/0.08)]">
            <textarea
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={t('videogen.placeholder')}
              disabled={submitting || videoModels.length === 0}
              className="max-h-[120px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/65 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={submitting || !prompt.trim() || !model}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {submitting ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Square size={15} fill="currentColor" />
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
