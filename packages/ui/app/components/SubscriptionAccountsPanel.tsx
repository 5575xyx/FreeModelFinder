'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { Badge, Dot } from './Badge';
import { GATEWAY, withUiHeaders } from '../lib/utils';
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const aliveRef = useRef(true);

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

      {notice && <p className="text-xs text-success">{notice}</p>}
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
          return (
            <li
              key={`${account.provider}:${account.id}`}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-muted/40 p-2.5"
            >
              <span className="truncate text-sm font-medium text-foreground">{account.label}</span>
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
