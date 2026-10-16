'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge, Dot } from './Badge';
import { SubscriptionProviderDialog } from './SubscriptionProviderDialog';
import {
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_PROVIDER_META,
  type SubscriptionProvider,
} from './subscriptionProviders';
import { GATEWAY, classNames, formatNumber, withUiHeaders } from '../lib/utils';
import { redactSecrets } from '../lib/redact';
import { useI18n } from '../i18n';

export type { SubscriptionProvider } from './subscriptionProviders';
export { SUBSCRIPTION_DEFAULT_PATHS, SUBSCRIPTION_PROVIDERS } from './subscriptionProviders';

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

// 路由形状对齐参考项目 v8：provider 一律走查询参数，凭据本体走 body。
const accountsUrl = `${GATEWAY}/api/subscription/credentials`;

const REMOVE_ARM_MS = 5000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toMillis(value: number | string | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * 订阅账号面板。
 *
 * 三张 provider 磁贴 + 一份账号列表。**取凭据**这件事已经全部搬进各家自己的弹窗
 * （OAuth 交互登录 / 文件导入），面板本身只管"已经有哪些账号"以及移除、刷新。
 */
export function SubscriptionAccountsPanel({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<SubscriptionAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dialogProvider, setDialogProvider] = useState<SubscriptionProvider | null>(null);
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

  // 弹窗里登入/导入成功都会走到这里：面板自己的列表要立刻反映出来，
  // 同时把上层（设置页）的配置也刷新一遍。
  const handleDialogChanged = useCallback(() => {
    void refreshAccounts();
    onChanged?.();
  }, [onChanged, refreshAccounts]);

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
        `${accountsUrl}?provider=${encodeURIComponent(account.provider)}&id=${encodeURIComponent(account.id)}`,
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
        `${accountsUrl}/refresh`,
        withUiHeaders({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: account.provider, id: account.id }),
        }),
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
        {SUBSCRIPTION_PROVIDERS.map((provider) => {
          const meta = SUBSCRIPTION_PROVIDER_META[provider];
          const count = accounts.filter((account) => account.provider === provider).length;
          return (
            <div
              key={provider}
              data-testid={`subscription-tile-${provider}`}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-muted/40 p-2.5"
            >
              <span className="w-16 text-sm font-medium text-foreground">
                {t(`settings.subscription.provider.${provider}`)}
              </span>
              <Badge tone="neutral">
                {t(
                  meta.usesPkce
                    ? 'settings.subscription.badge.pkce'
                    : 'settings.subscription.badge.nopkce',
                )}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {count > 0
                  ? t('settings.subscription.tile.connected', { count })
                  : t('settings.subscription.tile.empty')}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                data-testid={`subscription-connect-${provider}`}
                onClick={() => setDialogProvider(provider)}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus size={13} strokeWidth={2} />
                {t('settings.subscription.tile.connect')}
              </button>
            </div>
          );
        })}
      </div>

      {dialogProvider && (
        <SubscriptionProviderDialog
          provider={dialogProvider}
          onClose={() => setDialogProvider(null)}
          onChanged={handleDialogChanged}
        />
      )}

      <p className="text-[11px] text-warning">{t('settings.subscription.tos')}</p>

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
