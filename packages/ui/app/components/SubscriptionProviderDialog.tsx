'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Loader2, Upload, X } from 'lucide-react';
import { Badge } from './Badge';
import { GATEWAY, withUiHeaders } from '../lib/utils';
import { redactSecrets } from '../lib/redact';
import { useI18n } from '../i18n';
import { SUBSCRIPTION_PROVIDER_META, type SubscriptionProvider } from './subscriptionProviders';

/** 与 `SUBSCRIPTION_OAUTH` 的会话语义对齐：后端每 2 秒查一次不吃亏，超时 10 分钟。 */
const POLL_INTERVAL_MS = 2000;

const credentialsUrl = `${GATEWAY}/api/subscription/credentials`;
const authUrl = `${GATEWAY}/api/subscription/oauth/auth-url`;
const statusUrl = `${GATEWAY}/api/subscription/oauth/status`;
const sessionUrl = `${GATEWAY}/api/subscription/oauth/session`;
const callbackUrl = `${GATEWAY}/api/subscription/oauth/callback`;

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 弹窗内的状态机：idle → starting → waiting → ok | error。 */
type Phase = 'idle' | 'starting' | 'waiting' | 'ok' | 'error';

type AuthPayload = { status?: string; url?: string; state?: string; error?: string };

type ImportPayload = {
  ok?: boolean;
  account?: { provider?: string; id?: string; email?: string; plan?: string };
  error?: string;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把服务端的错误文案翻译成本地化提示。
 *
 * 后端的错误串（`session already pending` / `port N is already in use` / …）是**本仓库
 * 自己发的**、且只有本 UI 消费，所以按固定的几个形状匹配是安全的；匹配不上一律回落到
 * 原文（已 redact），绝不吞掉信息。
 */
function describeOAuthError(message: string, t: Translate): string {
  if (!message) return t('settings.subscription.oauth.error.state');
  if (message === 'timeout') return t('settings.subscription.oauth.error.timeout');
  if (message === 'session already pending') return t('settings.subscription.oauth.error.pending');
  if (message.startsWith('access_denied')) return t('settings.subscription.oauth.error.denied');
  const busy = /^port (\d+) is already in use/.exec(message);
  if (busy) return t('settings.subscription.oauth.error.portBusy', { port: busy[1] ?? '' });
  if (
    message === 'invalid state' ||
    message === 'unknown or expired state' ||
    message.startsWith('state mismatch')
  ) {
    return t('settings.subscription.oauth.error.state');
  }
  return redactSecrets(message);
}

/**
 * 单家 provider 的账号弹窗。
 *
 * 三家共用一个组件、共用同一台状态机，但**内容逐家不同**（端口 / 回调路径 / 授权机制 /
 * 自动读取的字段），差异来自 `SUBSCRIPTION_PROVIDER_META`，与参考项目逐项对齐。
 * 两条取凭据的路都在这里，且都落到后端同一条落库路径（`POST /credentials`）上：
 * 交互式 OAuth 与文件导入只是"怎么拿到凭据"的区别。
 */
export function SubscriptionProviderDialog({
  provider,
  onClose,
  onChanged,
}: {
  provider: SubscriptionProvider;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const meta = SUBSCRIPTION_PROVIDER_META[provider];
  const providerLabel = t(`settings.subscription.provider.${provider}`);
  const title = t('settings.subscription.dialog.title', { provider: providerLabel });
  const endpoint = `localhost:${meta.callbackPort}${meta.callbackPath}`;

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importError, setImportError] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [pendingUrl, setPendingUrl] = useState('');
  /** 「手动粘贴回调」区块的输入值与提交状态。 */
  const [callbackInput, setCallbackInput] = useState('');
  const [callbackBusy, setCallbackBusy] = useState(false);
  const [callbackError, setCallbackError] = useState('');

  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 正在等待收尾的会话 state；非空表示服务端还有一个 pending 会话没关。 */
  const pendingStateRef = useRef('');

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      stopPolling();
      // 关窗即放弃：不告诉服务端的话，那个 pending 会话会占着端口最多 10 分钟，
      // 用户再点「连接账号」只会撞 409。
      const abandoned = pendingStateRef.current;
      if (abandoned) {
        pendingStateRef.current = '';
        void fetch(
          `${sessionUrl}?state=${encodeURIComponent(abandoned)}`,
          withUiHeaders({ method: 'DELETE' }),
        ).catch(() => undefined);
      }
    };
  }, [stopPolling]);

  const poll = useCallback(
    async (authState: string): Promise<void> => {
      try {
        const response = await fetch(
          `${statusUrl}?state=${encodeURIComponent(authState)}`,
          withUiHeaders(),
        );
        const data = (await response.json().catch(() => null)) as AuthPayload | null;
        if (!aliveRef.current) return;
        // 用户已经取消/关窗：这次结果作废，绝不能把状态往前推。
        if (pendingStateRef.current !== authState) return;
        if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
        if (data?.status === 'wait') return;
        stopPolling();
        pendingStateRef.current = '';
        if (data?.status === 'ok') {
          setPhase('ok');
          setNotice(t('settings.subscription.dialog.login.ok'));
          onChanged?.();
          return;
        }
        setPhase('error');
        setError(describeOAuthError(data?.error ?? '', t));
      } catch (caught) {
        if (!aliveRef.current || pendingStateRef.current !== authState) return;
        stopPolling();
        pendingStateRef.current = '';
        setPhase('error');
        setError(describeOAuthError(messageOf(caught), t));
      }
    },
    [onChanged, stopPolling, t],
  );

  async function startOAuth(): Promise<void> {
    stopPolling();
    setPhase('starting');
    setError('');
    setNotice('');
    setPendingUrl('');
    setCallbackInput('');
    setCallbackError('');
    // 必须在点击的同一个 tick 里先开一个空窗：await 之后再 window.open 会被弹窗拦截器
    // 当成非用户手势而拦掉。拿到 URL 后再把它的 location 指过去。
    const opened = typeof window === 'undefined' ? null : window.open('', '_blank');
    try {
      const response = await fetch(`${authUrl}?provider=${provider}`, withUiHeaders());
      const data = (await response.json().catch(() => null)) as AuthPayload | null;
      if (!aliveRef.current) return;
      if (!response.ok || data?.status !== 'ok' || !data.url || !data.state) {
        throw new Error(data?.error ?? `HTTP ${response.status}`);
      }
      pendingStateRef.current = data.state;
      setPendingUrl(data.url);
      if (opened) opened.location.href = data.url;
      setPhase('waiting');
      timerRef.current = setInterval(() => void poll(data.state as string), POLL_INTERVAL_MS);
      // 立刻查一次：用户可能已经把授权做完了
      void poll(data.state);
    } catch (caught) {
      if (opened) opened.close();
      if (!aliveRef.current) return;
      setPhase('error');
      setError(describeOAuthError(messageOf(caught), t));
    }
  }

  async function cancelOAuth(): Promise<void> {
    const authState = pendingStateRef.current;
    stopPolling();
    pendingStateRef.current = '';
    setPendingUrl('');
    setCallbackInput('');
    setCallbackError('');
    setPhase('idle');
    setNotice('');
    if (!authState) return;
    try {
      await fetch(
        `${sessionUrl}?state=${encodeURIComponent(authState)}`,
        withUiHeaders({ method: 'DELETE' }),
      );
    } catch {
      // 取消失败不阻断用户：本地已经当成取消，服务端那份最多挂到超时。
    }
  }

  /**
   * 「手动回调」提交：远程部署下浏览器与网关不同机，用户把跳回的 URL 粘回来。
   * 只走这一条时，服务端把 URL 里能拿到的 code 送去 exchange；state 必须来自 UI 手里
   * 那份（pendingStateRef.current），不能从粘进来的 URL 里抠（设计 §3.4）。
   */
  async function submitCallback(): Promise<void> {
    const authState = pendingStateRef.current;
    const url = callbackInput.trim();
    if (!authState || !url || callbackBusy) return;
    setCallbackBusy(true);
    setCallbackError('');
    try {
      const response = await fetch(
        callbackUrl,
        withUiHeaders({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_url: url, state: authState }),
        }),
      );
      if (!aliveRef.current || pendingStateRef.current !== authState) return;
      if (response.ok) {
        // 成功响应是给浏览器看的 HTML，不能 response.json()；
        // 会话真正收尾仍靠 /status，所以这里只是补一次轮询。
        setCallbackInput('');
        setCallbackError('');
        void poll(pendingStateRef.current);
        return;
      }
      const data = (await response.json().catch(() => null)) as AuthPayload | null;
      // 保持 waiting、保留输入值：用户改一个字符就能重贴。
      setCallbackError(describeOAuthError(data?.error ?? `HTTP ${response.status}`, t));
    } catch (caught) {
      if (aliveRef.current && pendingStateRef.current === authState) {
        setCallbackError(describeOAuthError(messageOf(caught), t));
      }
    } finally {
      if (aliveRef.current) setCallbackBusy(false);
    }
  }

  async function importCredential(body: { raw: string } | { path: string }): Promise<void> {
    setImportBusy(true);
    setImportError('');
    setNotice('');
    try {
      const response = await fetch(
        `${credentialsUrl}?provider=${provider}`,
        withUiHeaders({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      const data = (await response.json().catch(() => null)) as ImportPayload | null;
      if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
      if (!aliveRef.current) return;
      setNotice(
        t('settings.subscription.imported', {
          label: data.account?.email ?? data.account?.id ?? providerLabel,
        }),
      );
      onChanged?.();
    } catch (caught) {
      if (aliveRef.current) setImportError(redactSecrets(messageOf(caught)));
    } finally {
      if (aliveRef.current) setImportBusy(false);
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // 清空 value，否则用户选同一个文件第二次不会再触发 change
    event.target.value = '';
    if (!file) return;
    await importCredential({ raw: await file.text() });
  }

  const mechanism = t(
    meta.usesPkce ? 'settings.subscription.badge.pkce' : 'settings.subscription.badge.nopkce',
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={`subscription-dialog-${provider}`}
      className="space-y-3 rounded-md border border-border bg-surface p-3 shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h4 className="truncate text-sm font-medium text-foreground">{title}</h4>
          <Badge tone="neutral">{mechanism}</Badge>
        </div>
        <button
          type="button"
          data-testid={`subscription-close-${provider}`}
          aria-label={t('settings.subscription.dialog.close')}
          onClick={onClose}
          className="rounded-md border border-border bg-surface p-1 text-muted-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <section className="space-y-1.5 border-t border-border pt-2.5">
        <h5 className="text-xs font-medium text-foreground">
          {t('settings.subscription.dialog.login.heading')}
        </h5>
        <p className="text-xs text-muted-foreground">
          {t(`settings.subscription.dialog.login.desc.${provider}`)}
        </p>
        {/* 端口必须提前可见：它被占用时登录一定失败，用户得能先看出是哪个端口 */}
        <p className="font-mono text-[11px] text-muted-foreground">
          {t('settings.subscription.dialog.login.endpoint', { endpoint })}
        </p>

        {phase !== 'waiting' && (
          <button
            type="button"
            data-testid={`subscription-start-${provider}`}
            disabled={phase === 'starting'}
            onClick={() => void startOAuth()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === 'starting' ? (
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            ) : (
              <Upload size={13} strokeWidth={2} />
            )}
            {t('settings.subscription.dialog.login.open')}
          </button>
        )}

        {phase === 'waiting' && (
          <div className="space-y-1.5" data-testid={`subscription-waiting-${provider}`}>
            <p className="text-xs text-muted-foreground">
              {t('settings.subscription.dialog.login.waiting', { endpoint })}
            </p>
            {pendingUrl && (
              <a
                data-testid={`subscription-reopen-${provider}`}
                href={pendingUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-xs text-primary underline underline-offset-2"
              >
                {t('settings.subscription.dialog.login.reopen')}
              </a>
            )}
            <div>
              <button
                type="button"
                data-testid={`subscription-cancel-${provider}`}
                onClick={() => void cancelOAuth()}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('settings.subscription.dialog.login.cancel')}
              </button>
            </div>

            <div className="space-y-1 pt-1">
              <h5 className="text-xs font-medium text-foreground">
                {t('settings.subscription.dialog.login.callback.heading')}
              </h5>
              <p className="text-[11px] text-muted-foreground">
                {t('settings.subscription.dialog.login.callback.hint', { endpoint })}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  type="text"
                  data-testid={`subscription-callback-url-${provider}`}
                  value={callbackInput}
                  disabled={callbackBusy}
                  placeholder={t('settings.subscription.dialog.login.callback.placeholder', {
                    endpoint,
                  })}
                  onChange={(event) => setCallbackInput(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                />
                <button
                  type="button"
                  data-testid={`subscription-callback-submit-${provider}`}
                  disabled={callbackBusy || !callbackInput.trim()}
                  onClick={() => void submitCallback()}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {callbackBusy && (
                    <Loader2 size={12} strokeWidth={1.75} className="animate-spin" />
                  )}
                  {t('settings.subscription.dialog.login.callback.submit')}
                </button>
              </div>
              {callbackError && (
                <p className="text-xs text-destructive">
                  {t('settings.subscription.dialog.error', { err: callbackError })}
                </p>
              )}
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none">
                  {t('settings.subscription.dialog.login.callback.tunnel')}
                </summary>
                <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface-muted p-1.5 font-mono text-[11px] text-foreground">
                  {`ssh -L 1455:127.0.0.1:1455 -L 54545:127.0.0.1:54545 -L 51121:127.0.0.1:51121 <user>@<server>`}
                </pre>
              </details>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-1.5 border-t border-border pt-2.5">
        <h5 className="text-xs font-medium text-foreground">
          {t('settings.subscription.dialog.autoRead.heading')}
        </h5>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {meta.autoReadFields.map((field) => (
            <li key={field}>{t(`settings.subscription.field.${field}`)}</li>
          ))}
        </ul>
        {meta.autoReadNoteKey && (
          <p className="text-[11px] text-muted-foreground">{t(meta.autoReadNoteKey)}</p>
        )}
      </section>

      <section className="space-y-1.5 border-t border-border pt-2.5">
        <h5 className="text-xs font-medium text-foreground">
          {t('settings.subscription.dialog.import.heading')}
        </h5>
        <p className="font-mono text-[11px] text-muted-foreground">{meta.defaultPath}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="file"
            accept=".json,application/json"
            data-testid={`subscription-file-${provider}`}
            aria-label={t('settings.subscription.dialog.import.choose')}
            disabled={importBusy}
            onChange={(event) => void handleFile(event)}
            className="max-w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground file:mr-2 file:rounded file:border-0 file:bg-surface-muted file:px-2 file:py-0.5 file:text-xs file:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            data-testid={`subscription-detect-${provider}`}
            disabled={importBusy}
            onClick={() => void importCredential({ path: meta.defaultPath })}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importBusy && <Loader2 size={12} strokeWidth={1.75} className="animate-spin" />}
            {t('settings.subscription.dialog.import.detect')}
          </button>
        </div>
      </section>

      {notice && <p className="text-xs text-success">{notice}</p>}
      {importError && (
        <p className="text-xs text-destructive">
          {t('settings.subscription.importFailed', { err: importError })}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" data-testid={`subscription-error-${provider}`}>
          {t('settings.subscription.dialog.error', { err: error })}
        </p>
      )}
    </div>
  );
}
