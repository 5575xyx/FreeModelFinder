'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Copy, ExternalLink, Loader2, LogOut, Plus, RotateCcw } from 'lucide-react';
import { Badge, Dot } from './Badge';
import { GATEWAY, classNames, formatNumber, withUiHeaders } from '../lib/utils';
import { useI18n } from '../i18n';

export const CLINE_POLL_INTERVAL_MS = 2_500;
export const CLINE_POLL_TIMEOUT_MS = 15_000;
export const CLINE_LOGOUT_ARM_MS = 4_000;

export type ClineCooldown = { model: string; resetAt: number | string };

export type ClineAccount = {
  id: string;
  label: string;
  status: 'active' | 'invalid';
  addedAt: number;
  lastUsedAt?: number | null;
  cooldowns?: ClineCooldown[];
  usage?: {
    requests?: number;
    promptTokens?: number;
    completionTokens?: number;
    lastError?: string;
  };
};

type Phase = 'idle' | 'starting' | 'awaiting' | 'complete' | 'expired' | 'denied' | 'error';
type Flow = { flowId: string; code: string; userUrl: string; expiresAt: number };
type StartResponse = {
  flowId?: string;
  code?: string;
  userUrl?: string;
  expiresAt?: number;
  error?: string;
};
type PollResponse = {
  status?: string;
  account?: { id?: string; label?: string; status?: string };
  error?: string;
};

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function toMillis(value: number | string | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const accountsUrl = `${GATEWAY}/api/cline/accounts`;

export function ClineAccountsPanel({
  enabled = false,
  dynamicModels,
  onChanged,
  onLoginSuccess,
}: {
  enabled?: boolean;
  dynamicModels?: boolean;
  onChanged?: () => void;
  onLoginSuccess?: (label: string) => void;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<ClineAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [flow, setFlow] = useState<Flow | null>(null);
  const [wizardError, setWizardError] = useState('');
  const [lastLabel, setLastLabel] = useState('');
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmLogoutId, setConfirmLogoutId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowRef = useRef<Flow | null>(null);

  const refreshAccounts = useCallback(async () => {
    try {
      const res = await fetch(accountsUrl, withUiHeaders());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { accounts?: ClineAccount[] };
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
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    };
  }, [refreshAccounts]);

  const needsClock =
    phase === 'awaiting' || accounts.some((account) => (account.cooldowns ?? []).length > 0);

  useEffect(() => {
    if (!needsClock) return;
    const id = setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      const active = flowRef.current;
      if (active && stamp >= active.expiresAt) {
        endFlow();
        setPhase('expired');
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [needsClock]);

  function clearPollTimer(): void {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function beginFlow(next: Flow): void {
    flowRef.current = next;
    setFlow(next);
    setCopied(false);
  }

  function endFlow(): void {
    flowRef.current = null;
    clearPollTimer();
    setFlow(null);
  }

  function schedulePoll(delayMs: number): void {
    clearPollTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void pollOnce();
    }, delayMs);
  }

  async function finishLogin(account: { id?: string; label?: string } | undefined): Promise<void> {
    endFlow();
    const label = account?.label ?? '';
    setPhase('complete');
    setLastLabel(label);
    onLoginSuccess?.(label);
    if (!enabled) {
      try {
        await postEnabled(true);
      } catch {
        if (aliveRef.current) {
          setActionError(t('settings.cline.enableFailed'));
        }
      }
    }
    if (!aliveRef.current) return;
    await refreshAccounts();
    onChanged?.();
  }

  async function pollOnce(): Promise<void> {
    const active = flowRef.current;
    if (!active || !aliveRef.current) return;
    if (Date.now() >= active.expiresAt) {
      endFlow();
      if (aliveRef.current) setPhase('expired');
      return;
    }
    try {
      const res = await fetch(
        `${GATEWAY}/api/cline/login/poll`,
        withUiHeaders({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ flowId: active.flowId }),
          signal: AbortSignal.timeout(CLINE_POLL_TIMEOUT_MS),
        }),
      );
      const data = (await res.json().catch(() => null)) as PollResponse | null;
      if (!aliveRef.current || flowRef.current !== active) return;
      if (!res.ok || !data) throw new Error(data?.error ?? `HTTP ${res.status}`);
      if (data.status === 'pending') {
        schedulePoll(CLINE_POLL_INTERVAL_MS);
        return;
      }
      if (data.status === 'complete') {
        await finishLogin(data.account);
        return;
      }
      endFlow();
      if (!aliveRef.current) return;
      if (data.status === 'denied') {
        setPhase('denied');
      } else if (data.status === 'expired') {
        setPhase('expired');
      } else {
        setWizardError(data.error ?? '');
        setPhase('error');
      }
    } catch (error) {
      if (!aliveRef.current || flowRef.current !== active) return;
      endFlow();
      setWizardError(messageOf(error));
      setPhase('error');
    }
  }

  async function postEnabled(value: boolean): Promise<void> {
    const res = await fetch(
      `${GATEWAY}/api/providers`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cline', enabled: value }),
      }),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function postDynamicModels(value: boolean): Promise<void> {
    const res = await fetch(
      `${GATEWAY}/api/providers`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cline', dynamicModels: value }),
      }),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function handleDynamicToggle(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const next = event.target.checked;
    setActionError('');
    setNotice('');
    try {
      await postDynamicModels(next);
      onChanged?.();
    } catch (error) {
      if (aliveRef.current) setActionError(messageOf(error));
    }
  }

  async function startLogin(): Promise<void> {
    if (phase === 'starting' || phase === 'awaiting') return;
    setPhase('starting');
    setActionError('');
    setNotice('');
    try {
      const res = await fetch(
        `${GATEWAY}/api/cline/login/start`,
        withUiHeaders({ method: 'POST' }),
      );
      const data = (await res.json().catch(() => null)) as StartResponse | null;
      if (!res.ok || !data?.flowId) throw new Error(data?.error ?? `HTTP ${res.status}`);
      if (!aliveRef.current) return;
      beginFlow({
        flowId: data.flowId,
        code: data.code ?? '',
        userUrl: data.userUrl ?? '',
        expiresAt: toMillis(data.expiresAt) || Date.now() + 300_000,
      });
      setPhase('awaiting');
      schedulePoll(0);
    } catch (error) {
      if (!aliveRef.current) return;
      setWizardError(messageOf(error));
      setPhase('error');
    }
  }

  function cancelLogin(): void {
    endFlow();
    setPhase('idle');
  }

  function restartLogin(): void {
    setWizardError('');
    void startLogin();
  }

  async function clearCooldowns(accountId: string): Promise<void> {
    if (busyId) return;
    setBusyId(accountId);
    setActionError('');
    setNotice('');
    try {
      const res = await fetch(
        `${accountsUrl}/${encodeURIComponent(accountId)}/cooldowns/clear`,
        withUiHeaders({ method: 'POST' }),
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { cleared?: number };
      if (!aliveRef.current) return;
      setNotice(t('settings.cline.cooldown.cleared', { n: data.cleared ?? 0 }));
      await refreshAccounts();
    } catch (error) {
      if (aliveRef.current) setActionError(messageOf(error));
    } finally {
      if (aliveRef.current) setBusyId(null);
    }
  }

  async function logout(accountId: string): Promise<void> {
    if (busyId) return;
    if (confirmLogoutId !== accountId) {
      setConfirmLogoutId(accountId);
      if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = setTimeout(() => {
        logoutTimerRef.current = null;
        if (aliveRef.current) setConfirmLogoutId(null);
      }, CLINE_LOGOUT_ARM_MS);
      return;
    }
    if (logoutTimerRef.current) {
      clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    }
    setBusyId(accountId);
    setActionError('');
    setNotice('');
    try {
      const res = await fetch(
        `${accountsUrl}/${encodeURIComponent(accountId)}/logout`,
        withUiHeaders({ method: 'POST' }),
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!aliveRef.current) return;
      setConfirmLogoutId(null);
      await refreshAccounts();
      onChanged?.();
    } catch (error) {
      if (aliveRef.current) setActionError(messageOf(error));
    } finally {
      if (aliveRef.current) setBusyId(null);
    }
  }

  async function handleToggle(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const next = event.target.checked;
    setActionError('');
    setNotice('');
    try {
      await postEnabled(next);
      onChanged?.();
    } catch (error) {
      if (aliveRef.current) setActionError(messageOf(error));
    }
  }

  async function copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(code);
      if (aliveRef.current) setCopied(true);
    } catch {
      if (aliveRef.current) setActionError(t('settings.copyFailed'));
    }
  }

  const busy = busyId !== null;

  return (
    <div className="space-y-2.5" data-testid="cline-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-semibold text-foreground">
            {t('settings.cline.accounts.title')}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('settings.cline.accounts.count', { n: accounts.length })}
          </span>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => void handleToggle(event)}
            aria-label={t('settings.cline.enable')}
            className="h-3.5 w-3.5 accent-[var(--color-primary,#4f7cff)]"
          />
          {t('settings.cline.enable')}
        </label>
      </div>

      <label className="inline-flex cursor-pointer items-start gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={dynamicModels !== false}
          onChange={(event) => void handleDynamicToggle(event)}
          aria-label={t('settings.cline.dynamicModels')}
          className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-primary,#4f7cff)]"
        />
        <span className="space-y-0.5">
          <span className="block text-foreground">{t('settings.cline.dynamicModels')}</span>
          <span className="block text-[11px] text-muted-foreground">
            {t('settings.cline.dynamicModels.hint')}
          </span>
        </span>
      </label>

      {loadFailed && (
        <p className="text-xs text-destructive">{t('settings.cline.accounts.loadFailed')}</p>
      )}
      {loaded && !loadFailed && accounts.length === 0 && (
        <p className="rounded-md border border-dashed border-border bg-surface-muted/30 px-3 py-3 text-center text-xs text-muted-foreground">
          {t('settings.cline.accounts.empty')}
        </p>
      )}

      <ul className="space-y-2">
        {accounts.map((account) => {
          const cooling = (account.cooldowns ?? []).filter(
            (entry) => toMillis(entry.resetAt) > now,
          );
          const active = account.status === 'active';
          return (
            <li
              key={account.id}
              className="space-y-1.5 rounded-md border border-border bg-surface-muted/40 p-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">
                    {account.label}
                  </span>
                  {active ? (
                    <Badge tone="success">
                      <Dot tone="success" />
                      {t('settings.cline.status.active')}
                    </Badge>
                  ) : (
                    <Badge tone="danger">
                      <Dot tone="danger" />
                      {t('settings.cline.status.invalid')}
                    </Badge>
                  )}
                  {cooling.length > 0 && (
                    <Badge tone="warning">
                      <Dot tone="warning" />
                      {t('settings.cline.cooldown.badge')}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {cooling.length > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void clearCooldowns(account.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('settings.cline.cooldown.clear')}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void logout(account.id)}
                    className={classNames(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                      confirmLogoutId === account.id
                        ? 'border-destructive/40 bg-destructive/10 text-destructive'
                        : 'border-border bg-surface text-foreground hover:bg-surface-muted',
                    )}
                  >
                    <LogOut size={12} strokeWidth={1.75} />
                    {confirmLogoutId === account.id
                      ? t('settings.cline.logout.confirm')
                      : t('settings.cline.logout')}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t('settings.cline.addedAt', {
                    time: new Date(toMillis(account.addedAt)).toLocaleString(),
                  })}
                </span>
                <span>
                  {account.lastUsedAt
                    ? t('settings.cline.lastUsed', {
                        time: new Date(toMillis(account.lastUsedAt)).toLocaleString(),
                      })
                    : t('settings.cline.lastUsed.never')}
                </span>
                <span>
                  {t('settings.cline.usage', {
                    requests: formatNumber(account.usage?.requests ?? 0),
                    prompt: formatNumber(account.usage?.promptTokens ?? 0),
                    completion: formatNumber(account.usage?.completionTokens ?? 0),
                  })}
                </span>
              </div>

              {cooling.map((entry) => (
                <p key={entry.model} className="text-xs text-warning">
                  {t('settings.cline.cooldown', {
                    model: entry.model,
                    time: formatRemaining(toMillis(entry.resetAt) - now),
                  })}
                </p>
              ))}

              {account.usage?.lastError && (
                <p className="truncate text-xs text-destructive">
                  {t('settings.cline.lastError', {
                    error: account.usage.lastError.slice(0, 160),
                  })}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {notice && <p className="text-xs text-success">{notice}</p>}
      {actionError && (
        <p className="text-xs text-destructive">
          {t('settings.cline.actionFailed', { err: actionError })}
        </p>
      )}

      <div className="space-y-2 rounded-md border border-dashed border-border bg-surface-muted/30 p-2.5">
        {phase === 'idle' && (
          <button
            type="button"
            onClick={() => void startLogin()}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus size={14} strokeWidth={2} />
            {t('settings.cline.login')}
          </button>
        )}

        {phase === 'starting' && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            {t('settings.cline.login.starting')}
          </p>
        )}

        {phase === 'awaiting' && flow && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <code
                aria-label={t('settings.cline.login.code', { code: flow.code })}
                className="rounded bg-surface px-2 py-1 font-mono text-sm font-semibold text-foreground"
              >
                {flow.code}
              </code>
              <button
                type="button"
                onClick={() => void copyCode(flow.code)}
                aria-label={
                  copied ? t('settings.cline.login.copied') : t('settings.cline.login.copy')
                }
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Copy size={12} strokeWidth={1.75} />
                {copied ? t('settings.cline.login.copied') : t('settings.cline.login.copy')}
              </button>
              <a
                href={flow.userUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-blue-500 underline underline-offset-2 transition hover:text-blue-400"
              >
                {t('settings.cline.login.open')}
                <ExternalLink size={11} strokeWidth={2} />
              </a>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.cline.login.waiting')}{' '}
              {t('settings.cline.login.expiresIn', {
                time: formatRemaining(flow.expiresAt - now),
              })}
            </p>
            <button
              type="button"
              onClick={cancelLogin}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('settings.cline.login.cancel')}
            </button>
          </div>
        )}

        {phase === 'complete' && (
          <div className="space-y-2">
            <p className="text-xs text-success">
              {t('settings.cline.login.success', { label: lastLabel })}
            </p>
            <button
              type="button"
              onClick={() => setPhase('idle')}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('settings.cline.login.another')}
            </button>
          </div>
        )}

        {(phase === 'expired' || phase === 'denied' || phase === 'error') && (
          <div className="space-y-2">
            <p className="text-xs text-destructive">
              {phase === 'expired'
                ? t('settings.cline.login.expired')
                : phase === 'denied'
                  ? t('settings.cline.login.denied')
                  : t('settings.cline.login.failed', { err: wizardError })}
            </p>
            <button
              type="button"
              onClick={restartLogin}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw size={12} strokeWidth={1.75} />
              {t('settings.cline.login.retry')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
