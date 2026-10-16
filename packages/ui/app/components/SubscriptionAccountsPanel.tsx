'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Badge, Dot } from './Badge';
import { GATEWAY, classNames, formatNumber, withUiHeaders } from '../lib/utils';
import { useI18n } from '../i18n';

export type SubscriptionProvider = 'codex' | 'claude' | 'google';

export const SUBSCRIPTION_PROVIDERS: SubscriptionProvider[] = ['codex', 'claude', 'google'];

export const SUBSCRIPTION_DEFAULT_PATHS: Record<SubscriptionProvider, string> = {
  codex: '~/.codex/auth.json',
  claude: '~/.claude/.credentials.json',
  google: '~/.gemini/oauth_creds.json',
};

export type SubscriptionAccount = {
  provider: string;
  id: string;
  label: string;
  email?: string;
  plan?: string;
  status: 'active' | 'invalid';
  addedAt: number;
  expiresAt?: string;
  cooldowns?: Array<{ model: string; resetAt: number }>;
  usage?: {
    requests?: number;
    promptTokens?: number;
    completionTokens?: number;
    lastError?: string;
  };
};

type ImportResponse = {
  ok?: boolean;
  account?: { provider?: string; id?: string; email?: string; plan?: string };
  error?: string;
};

const accountsUrl = `${GATEWAY}/api/subscription/accounts`;
const importUrl = `${GATEWAY}/api/subscription/import`;

const REMOVE_ARM_MS = 5000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// server 已经对上游错误做过 redact，这里是第二道防线：上游偶尔把令牌片段
// 拼进错误文案，UI 兜底保证它不会出现在屏幕上（更不会被截图传播）。
// 三家 OAuth 令牌都带 `rt-`/`sk-` 一类前缀且往往短于 40 字符，所以除了长
// base64 串之外，还要按前缀形状匹配。
function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(refresh_token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:rt|sk|pk|key|token)[-_][A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');
}

function toMillis(value: number | string | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function SubscriptionAccountsPanel({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<SubscriptionAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [paths, setPaths] = useState<Record<SubscriptionProvider, string>>(() => ({
    ...SUBSCRIPTION_DEFAULT_PATHS,
  }));
  const [rawText, setRawText] = useState('');
  const [pending, setPending] = useState<SubscriptionProvider | null>(null);
  const [importError, setImportError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshAccounts = useCallback(async () => {
    try {
      const res = await fetch(accountsUrl, withUiHeaders());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { accounts?: SubscriptionAccount[] };
      if (!aliveRef.current) return;
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      setLoaded(true);
      setLoadFailed(false);
    } catch {
      if (!aliveRef.current) return;
      setLoaded(true);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refreshAccounts();
    return () => {
      aliveRef.current = false;
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current);
    };
  }, [refreshAccounts]);

  async function handleImport(provider: SubscriptionProvider): Promise<void> {
    if (pending) return;
    const trimmedRaw = rawText.trim();
    const trimmedPath = paths[provider].trim();
    const body = trimmedRaw ? { provider, raw: trimmedRaw } : { provider, path: trimmedPath };
    setPending(provider);
    setImportError('');
    setNotice('');
    try {
      const res = await fetch(
        importUrl,
        withUiHeaders({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      const data = (await res.json().catch(() => null)) as ImportResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      if (!aliveRef.current) return;
      const who = data.account?.email ?? data.account?.id ?? provider;
      setNotice(t('settings.subscription.imported', { label: who }));
      setRawText('');
      await refreshAccounts();
      onChanged?.();
    } catch (error) {
      if (aliveRef.current) setImportError(messageOf(error));
    } finally {
      if (aliveRef.current) setPending(null);
    }
  }

  // 移除订阅账号是破坏性操作：第一次点击只进入确认态，5 秒内再点才真的 DELETE。
  async function removeAccount(account: SubscriptionAccount): Promise<void> {
    if (busyId) return;
    const key = `${account.provider}:${account.id}`;
    if (confirmRemoveId !== key) {
      setConfirmRemoveId(key);
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current);
      removeTimerRef.current = setTimeout(() => {
        removeTimerRef.current = null;
        if (aliveRef.current) setConfirmRemoveId(null);
      }, REMOVE_ARM_MS);
      return;
    }
    if (removeTimerRef.current) {
      clearTimeout(removeTimerRef.current);
      removeTimerRef.current = null;
    }
    setBusyId(key);
    setActionError('');
    setRefreshError('');
    setNotice('');
    try {
      const res = await fetch(
        `${accountsUrl}/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.id)}`,
        withUiHeaders({ method: 'DELETE' }),
      );
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || data?.ok === false) {
        throw new Error(redactSecrets(data?.error ?? `HTTP ${res.status}`));
      }
      if (!aliveRef.current) return;
      setConfirmRemoveId(null);
      setNotice(t('settings.subscription.removed', { label: account.label }));
      await refreshAccounts();
      onChanged?.();
    } catch (error) {
      if (aliveRef.current) setActionError(redactSecrets(messageOf(error)));
    } finally {
      if (aliveRef.current) setBusyId(null);
    }
  }

  // 手动刷新令牌：只有上游拒绝（invalid_grant 之类）才会把账号标成 invalid，
  // 网络抖动等可重试错误按 502 返回，账号保持原状。
  async function refreshAccount(account: SubscriptionAccount): Promise<void> {
    if (busyId) return;
    const key = `${account.provider}:${account.id}`;
    setBusyId(key);
    setActionError('');
    setRefreshError('');
    setNotice('');
    try {
      const res = await fetch(
        `${accountsUrl}/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.id)}/refresh`,
        withUiHeaders({ method: 'POST' }),
      );
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        account?: { email?: string };
        error?: string;
      } | null;
      if (!res.ok || data?.ok === false) {
        throw new Error(redactSecrets(data?.error ?? `HTTP ${res.status}`));
      }
      if (!aliveRef.current) return;
      setNotice(
        t('settings.subscription.refreshed', {
          label: data?.account?.email ?? account.label,
        }),
      );
      await refreshAccounts();
      onChanged?.();
    } catch (error) {
      if (aliveRef.current) {
        setRefreshError(redactSecrets(messageOf(error)));
      }
    } finally {
      if (aliveRef.current) setBusyId(null);
    }
  }

  return (
    <div className="space-y-2.5" data-testid="subscription-panel">
      <p className="text-xs text-muted-foreground">{t('settings.subscription.hint')}</p>

      <div className="space-y-2">
        {SUBSCRIPTION_PROVIDERS.map((provider) => (
          <div
            key={provider}
            data-testid={`subscription-tile-${provider}`}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-muted/40 p-2.5"
          >
            <span className="w-16 text-sm font-medium text-foreground">
              {t(`settings.subscription.provider.${provider}`)}
            </span>
            <input
              type="text"
              value={paths[provider]}
              onChange={(event) =>
                setPaths((prev) => ({ ...prev, [provider]: event.target.value }))
              }
              aria-label={t('settings.subscription.pathLabel', {
                provider: t(`settings.subscription.provider.${provider}`),
              })}
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void handleImport(provider)}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === provider ? (
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <Upload size={13} strokeWidth={2} />
              )}
              {t('settings.subscription.import')}
            </button>
          </div>
        ))}
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t('settings.subscription.rawLabel')}</span>
        <textarea
          value={rawText}
          onChange={(event) => setRawText(event.target.value)}
          rows={3}
          aria-label={t('settings.subscription.rawLabel')}
          placeholder={t('settings.subscription.rawPlaceholder')}
          className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <p className="text-[11px] text-warning">{t('settings.subscription.tos')}</p>

      {importError && (
        <p className="text-xs text-destructive">
          {t('settings.subscription.importFailed', { err: importError })}
        </p>
      )}

      {loadFailed && (
        <p className="text-xs text-destructive">{t('settings.subscription.accounts.loadFailed')}</p>
      )}
      {loaded && !loadFailed && accounts.length === 0 && (
        <p className="rounded-md border border-dashed border-border bg-surface-muted/30 px-3 py-3 text-center text-xs text-muted-foreground">
          {t('settings.subscription.accounts.empty')}
        </p>
      )}

      <ul className="space-y-2">
        {accounts.map((account) => {
          const active = account.status === 'active';
          const key = `${account.provider}:${account.id}`;
          const expiresAt = toMillis(account.expiresAt);
          const busy = busyId !== null;
          return (
            <li
              key={key}
              className="space-y-1.5 rounded-md border border-border bg-surface-muted/40 p-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">
                    {account.label}
                  </span>
                  <Badge tone="neutral">{account.provider}</Badge>
                  {active ? (
                    <Badge tone="success">
                      <Dot tone="success" />
                      {t('settings.subscription.status.active')}
                    </Badge>
                  ) : (
                    <Badge tone="danger">
                      <Dot tone="danger" />
                      {t('settings.subscription.status.invalid')}
                    </Badge>
                  )}
                  {account.plan && <Badge tone="neutral">{account.plan}</Badge>}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="subscription-refresh"
                    disabled={busy}
                    onClick={() => void refreshAccount(account)}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyId === key ? (
                      <Loader2 size={12} strokeWidth={1.75} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} strokeWidth={1.75} />
                    )}
                    {t('settings.subscription.refresh')}
                  </button>
                  <button
                    type="button"
                    data-testid={`subscription-remove-${account.id}`}
                    disabled={busy}
                    onClick={() => void removeAccount(account)}
                    className={classNames(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                      confirmRemoveId === key
                        ? 'border-destructive/40 bg-destructive/10 text-destructive'
                        : 'border-border bg-surface text-foreground hover:bg-surface-muted',
                    )}
                  >
                    <Trash2 size={12} strokeWidth={1.75} />
                    {confirmRemoveId === key
                      ? t('settings.subscription.remove.confirm')
                      : t('settings.subscription.remove')}
                  </button>
                </div>
              </div>

              {!active && (
                <p className="text-xs text-destructive">{t('settings.subscription.reimport')}</p>
              )}

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t('settings.subscription.addedAt', {
                    time: new Date(toMillis(account.addedAt)).toLocaleString(),
                  })}
                </span>
                {expiresAt > 0 && (
                  <span>
                    {t('settings.subscription.expires', {
                      time: new Date(expiresAt).toLocaleString(),
                    })}
                  </span>
                )}
                <span>
                  {t('settings.subscription.usage', {
                    requests: formatNumber(account.usage?.requests ?? 0),
                    prompt: formatNumber(account.usage?.promptTokens ?? 0),
                    completion: formatNumber(account.usage?.completionTokens ?? 0),
                  })}
                </span>
              </div>

              {account.usage?.lastError && (
                <p className="truncate text-xs text-destructive">
                  {t('settings.subscription.lastError', {
                    error: redactSecrets(account.usage.lastError).slice(0, 160),
                  })}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {notice && <p className="text-xs text-success">{notice}</p>}
      {refreshError && (
        <p className="text-xs text-destructive">
          {t('settings.subscription.refreshFailed', { err: refreshError })}
        </p>
      )}
      {actionError && (
        <p className="text-xs text-destructive">
          {t('settings.subscription.actionFailed', { err: actionError })}
        </p>
      )}
    </div>
  );
}
