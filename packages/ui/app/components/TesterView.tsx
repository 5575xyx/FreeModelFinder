'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ArrowUp,
  Braces,
  Check,
  Copy,
  Download,
  Eraser,
  Film,
  Loader2,
  MessageSquareText,
  Paperclip,
  Square,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatContext, modelValue, type ModelItem } from '../lib/models';
import { fileToDataURL, isImageDataUrlWithinLimit } from '../lib/image';
import { classNames, GATEWAY, withUiHeaders } from '../lib/utils';
import { useI18n } from '../i18n';

export type Msg = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  imageUrls?: string[];
  uploadImages?: string[];
  videoId?: string;
  videoProvider?: string;
};

type ExamplePrompt = {
  eyebrowKey: string;
  titleKey: string;
  promptKey: string;
  Icon: LucideIcon;
};

const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  {
    eyebrowKey: 'tester.prompt1.eyebrow',
    titleKey: 'tester.prompt1.title',
    promptKey: 'tester.prompt1.prompt',
    Icon: Sparkles,
  },
  {
    eyebrowKey: 'tester.prompt2.eyebrow',
    titleKey: 'tester.prompt2.title',
    promptKey: 'tester.prompt2.prompt',
    Icon: Braces,
  },
  {
    eyebrowKey: 'tester.prompt3.eyebrow',
    titleKey: 'tester.prompt3.title',
    promptKey: 'tester.prompt3.prompt',
    Icon: MessageSquareText,
  },
];

export function TesterView({
  messages,
  streaming,
  input,
  model,
  models,
  inputImages,
  setInput,
  setImages,
  send,
  onCancel,
  onModelChange,
  onClear,
}: {
  messages: Msg[];
  streaming: boolean;
  input: string;
  model: string;
  models: ModelItem[];
  inputImages: string[];
  setInput: (value: string) => void;
  setImages: (value: string[]) => void;
  send: () => void;
  onCancel: () => void;
  onModelChange: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachError, setAttachError] = useState('');
  const selected = models.find((item) => modelValue(item) === model);
  const missingSelection =
    !!model && model !== 'auto' && !models.some((item) => modelValue(item) === model);

  const enqueueImages = useCallback(
    async (files: File[]) => {
      setAttachError('');
      const next = [...inputImages];
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        try {
          const url = await fileToDataURL(file);
          if (!isImageDataUrlWithinLimit(url)) {
            setAttachError(t('tester.attach.tooLarge'));
            continue;
          }
          next.push(url);
        } catch {
          setAttachError(t('tester.attach.readError'));
        }
      }
      setImages(next);
    },
    [inputImages, setImages, t],
  );

  const localizedPrompts = useMemo(
    () =>
      EXAMPLE_PROMPTS.map((example) => ({
        Icon: example.Icon,
        eyebrow: t(example.eyebrowKey),
        title: t(example.titleKey),
        prompt: t(example.promptKey),
      })),
    [t],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: messages.length > 2 ? 'smooth' : 'auto',
    });
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border bg-background px-5 py-4 md:px-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="tester-model"
              className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"
            >
              {t('tester.currentModel')}
            </label>
            <select
              id="tester-model"
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={models.length === 0 || streaming}
              className="h-11 w-full rounded-xl border border-input bg-surface px-3 text-sm font-medium text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {models.length === 0 && <option value="">{t('tester.noModels')}</option>}
              {missingSelection && (
                <option value={model}>{t('tester.unavailable', { model })}</option>
              )}
              {models.length > 0 && <option value="auto">{t('tester.auto')}</option>}
              {models.map((item) => (
                <option key={modelValue(item)} value={modelValue(item)}>
                  {item.provider} · {item.display_name ?? item.id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3 sm:pt-5">
            {selected && (
              <div className="hidden min-w-[130px] sm:block">
                <p className="text-xs font-medium text-foreground">
                  {formatContext(selected.context_window, t)}
                </p>
                <p className="mt-0.5 text-[11px] text-success">{t('tester.freeVerified')}</p>
              </div>
            )}
            <button
              type="button"
              onClick={onClear}
              disabled={messages.length === 0 || streaming}
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-xs font-medium text-muted-foreground shadow-sm transition hover:bg-surface-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Eraser size={14} />
              {t('tester.clear')}
            </button>
          </div>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-4xl flex-col px-5 py-7 md:px-8">
          {models.length === 0 ? (
            <div className="my-auto py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface">
                <MessageSquareText className="text-muted-foreground" size={20} />
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">
                {t('tester.empty.title')}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {t('tester.empty.body')}
              </p>
            </div>
          ) : messages.length === 0 ? (
            <div className="my-auto py-8">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                {t('tester.quick.eyebrow')}
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-foreground">
                {t('tester.quick.title')}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t('tester.quick.subtitle')}
              </p>

              <div className="mt-7 grid gap-3 md:grid-cols-3">
                {localizedPrompts.map((example) => (
                  <button
                    key={example.title}
                    type="button"
                    onClick={() => {
                      setInput(example.prompt);
                      textareaRef.current?.focus();
                    }}
                    className="group rounded-2xl border border-border bg-surface p-4 text-left transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/10"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {example.eyebrow}
                      </span>
                      <example.Icon
                        size={15}
                        className="text-muted-foreground transition group-hover:text-primary"
                      />
                    </div>
                    <p className="mt-6 text-sm font-semibold leading-5 text-foreground">
                      {example.title}
                    </p>
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
                      {example.prompt}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-7 pb-4">
              {messages.map((message, index) => (
                <MessageRow
                  key={`${message.role}-${index}`}
                  message={message}
                  isStreamingLast={
                    streaming && index === messages.length - 1 && message.role === 'assistant'
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <form
        className="border-t border-border bg-background px-5 py-4 md:px-8"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="mx-auto max-w-4xl">
          <div className="flex flex-col rounded-2xl border border-input bg-surface p-2 shadow-sm transition focus-within:border-ring focus-within:shadow-[0_0_0_4px_hsl(var(--ring)/0.08)]">
            {inputImages.length > 0 && (
              <div data-testid="tester-drafts" className="flex flex-wrap gap-2 px-1 pb-2">
                {inputImages.map((url, i) => (
                  <div key={`${i}-${url.slice(0, 24)}`} className="relative">
                    <img
                      src={url}
                      alt={`attachment-${i}`}
                      className="h-14 w-14 rounded-lg border border-border object-cover"
                    />
                    <button
                      type="button"
                      aria-label={t('tester.attach.removeAria', { index: String(i + 1) })}
                      onClick={() => setImages(inputImages.filter((_, j) => j !== i))}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-[11px] leading-none text-background shadow transition hover:opacity-80"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachError && (
              <p role="alert" className="px-1 pb-2 text-xs text-destructive">
                {attachError}
              </p>
            )}
            <div className="flex items-end gap-2">
              <button
                type="button"
                aria-label={t('tester.attach.aria')}
                disabled={streaming || models.length === 0}
                onClick={() => fileInputRef.current?.click()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Paperclip size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                data-testid="tester-image-input"
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  if (files.length > 0) void enqueueImages(files);
                }}
              />
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                disabled={streaming || models.length === 0}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.items)
                    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                    .map((item) => item.getAsFile())
                    .filter((file): file is File => !!file);
                  if (files.length > 0) {
                    event.preventDefault();
                    void enqueueImages(files);
                  }
                }}
                placeholder={
                  models.length > 0 ? t('tester.input.placeholder') : t('tester.input.needProvider')
                }
                className="max-h-[180px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/65 disabled:cursor-not-allowed"
              />
              <button
                type={streaming ? 'button' : 'submit'}
                aria-label={streaming ? t('tester.send.stopAria') : t('tester.send.sendAria')}
                onClick={streaming ? onCancel : undefined}
                disabled={!streaming && (!model || (!input.trim() && inputImages.length === 0))}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {streaming ? (
                  <Square size={15} fill="currentColor" />
                ) : (
                  <ArrowUp size={17} strokeWidth={2.2} />
                )}
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
            <span>{t('tester.hint.disclaimer')}</span>
            {streaming && <span className="text-primary">{t('tester.hint.generating')}</span>}
          </div>
        </div>
      </form>
    </div>
  );
}

function MessageRow({ message, isStreamingLast }: { message: Msg; isStreamingLast: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoStatus, setVideoStatus] = useState('');
  const [videoPolling, setVideoPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isUser = message.role === 'user';
  const isError = message.content.startsWith('[error]');
  const hasImages = (message.imageUrls?.length ?? 0) > 0;
  const hasVideo = !!message.videoId;

  const fetchProxied = useCallback(async (url: string, provider: string): Promise<string> => {
    const resp = await fetch(
      `${GATEWAY}/v1/videos/proxy`,
      withUiHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, provider }),
      }),
    );
    if (!resp.ok) throw new Error(`proxy failed ${resp.status}`);
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  }, []);

  useEffect(() => {
    if (!hasVideo || !message.videoId || !message.videoProvider) return;
    let cancelled = false;

    async function poll() {
      setVideoPolling(true);
      setVideoStatus('生成中…');
      try {
        for (let i = 0; i < 120; i++) {
          if (cancelled) return;
          const resp = await fetch(
            `${GATEWAY}/v1/videos/status`,
            withUiHeaders({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ video_id: message.videoId, provider: message.videoProvider }),
            }),
          );
          if (!resp.ok) {
            await new Promise((r) => setTimeout(r, 8000));
            continue;
          }
          const data = (await resp.json()) as {
            status?: string;
            video_url?: string;
            progress?: number;
          };
          if (cancelled) return;
          setVideoStatus(
            data.status === 'completed'
              ? '已完成'
              : data.status === 'failed'
                ? '生成失败'
                : `生成中${data.progress != null ? ` ${data.progress}%` : ''}…`,
          );
          if (data.status === 'completed' || data.status === 'failed') {
            if (data.status === 'completed' && data.video_url) {
              try {
                const blobUrl = await fetchProxied(data.video_url, message.videoProvider!);
                if (!cancelled) setVideoUrl(blobUrl);
              } catch {
                if (!cancelled) setVideoUrl(data.video_url);
              }
            }
            break;
          }
          await new Promise((r) => setTimeout(r, 8000));
        }
      } finally {
        if (!cancelled) setVideoPolling(false);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [hasVideo, message.videoId, message.videoProvider, fetchProxied]);

  async function copy() {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be unavailable inside hardened desktop webviews.
    }
  }

  return (
    <article className={classNames('group flex gap-3', isUser && 'flex-row-reverse')}>
      <div
        className={classNames(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
          isUser
            ? 'bg-foreground text-background'
            : 'border border-border bg-surface text-muted-foreground',
        )}
      >
        {isUser ? t('tester.msg.you') : 'FM'}
      </div>
      <div className={classNames('min-w-0 max-w-[86%]', isUser && 'text-right')}>
        <div
          className={classNames(
            'inline-block whitespace-pre-wrap rounded-2xl px-4 py-3 text-left text-sm leading-7',
            isUser
              ? 'rounded-tr-sm bg-foreground text-background'
              : isError
                ? 'rounded-tl-sm border border-destructive/25 bg-destructive/5 text-destructive'
                : 'rounded-tl-sm border border-border bg-surface text-foreground',
          )}
        >
          {message.content ? (
            isError ? (
              message.content.replace(/^\[error\]\s*/, '')
            ) : (
              message.content
            )
          ) : isStreamingLast ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Loader2 className="animate-spin" size={14} />
              {t('tester.msg.waiting')}
            </span>
          ) : null}
        </div>

        {hasImages && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.imageUrls!.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                <img
                  src={url}
                  alt={`generated-${i}`}
                  className="max-h-[300px] rounded-xl border border-border object-contain"
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        )}

        {hasVideo && (
          <div className="mt-2">
            {videoUrl ? (
              <div>
                <video
                  src={videoUrl}
                  controls
                  preload="metadata"
                  className="max-h-[300px] rounded-xl border border-border bg-black"
                />
                <div className="mt-1.5">
                  <a
                    href={videoUrl}
                    download={`fmf-video-${message.videoId}.mp4`}
                    className="inline-flex items-center gap-1 rounded-lg bg-surface-muted px-2 py-1 text-[11px] font-medium text-foreground transition hover:bg-surface"
                  >
                    <Download size={12} />
                    {t('videogen.download')}
                  </a>
                </div>
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
                <Film size={14} />
                <span>{videoPolling ? videoStatus : '视频任务已提交'}</span>
                {videoPolling && <Loader2 className="animate-spin" size={12} />}
              </div>
            )}
          </div>
        )}

        {!isUser && (message.content || hasImages || hasVideo) && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition hover:bg-surface-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? t('tester.msg.copied') : t('tester.msg.copy')}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
