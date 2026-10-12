'use client';

import { AlertTriangle, ChevronDown, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { classNames, GATEWAY, withUiHeaders } from '../lib/utils';
import { fetchAdminStatus, type AdminStatus } from './AdminLoginScreen';

const BANNER_DISMISSAL = 'fmf-admin-banner-dismissed';

export function isAdminBannerDismissed(): boolean {
  try {
    return window.localStorage.getItem(BANNER_DISMISSAL) === '1';
  } catch {
    return false;
  }
}

export function dismissAdminBanner(): void {
  try {
    window.localStorage.setItem(BANNER_DISMISSAL, '1');
  } catch {
    // A blocked storage backend should never keep the hint on screen.
  }
}

interface PasswordReply {
  ok?: boolean;
  error?: { message?: string };
}

type PasswordResult = { ok: true } | { ok: false; message: string | null; network: boolean };

/**
 * One round-trip for every password write. A refusal carries the gateway's own
 * words; a dropped connection does not, so the caller can tell the two apart.
 */
async function changePassword(payload: Record<string, unknown>): Promise<PasswordResult> {
  try {
    const response = await fetch(
      `${GATEWAY}/api/admin/password`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    const body = (await response.json().catch(() => null)) as PasswordReply | null;
    if (response.ok && body?.ok) return { ok: true };
    return { ok: false, message: body?.error?.message ?? null, network: false };
  } catch {
    return { ok: false, message: null, network: true };
  }
}

/**
 * Set, change, or remove the management password from the panel itself. When
 * the gateway does not answer at all the block still renders, but only says so —
 * a control with no endpoint behind it is worse than no control.
 */
export function AdminPasswordPanel({
  focusSignal = 0,
  hidden = false,
}: {
  focusSignal?: number;
  hidden?: boolean;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [open, setOpen] = useState(true);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAdminStatus().then((value) => {
      if (!cancelled) setStatus(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (focusSignal > 0) setOpen(true);
  }, [focusSignal]);

  const available = status !== null;
  const configured = status?.authRequired === true;
  const remoteAndOpen = available && status?.remote === true && !configured;
  const statusKey = !available
    ? 'adminPanel.status.unsupported'
    : configured
      ? 'adminPanel.status.set'
      : 'adminPanel.status.unset';

  function resetDraft() {
    setCurrent('');
    setNext('');
    setConfirm('');
  }

  function failureText(result: Extract<PasswordResult, { ok: false }>): string {
    if (result.message) return result.message;
    return result.network ? t('adminPanel.error.network') : t('adminPanel.error.unsaved');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (next !== confirm) {
      setFeedback({ tone: 'error', text: t('adminPanel.error.mismatch') });
      return;
    }
    if (next.length < 8) {
      setFeedback({ tone: 'error', text: t('adminPanel.error.tooShort') });
      return;
    }
    setBusy(true);
    setFeedback(null);
    const result = await changePassword(
      configured
        ? { action: 'change', currentPassword: current, password: next }
        : { action: 'set', password: next },
    );
    setBusy(false);
    if (!result.ok) {
      setFeedback({ tone: 'error', text: failureText(result) });
      return;
    }
    resetDraft();
    setStatus((previous) => (previous ? { ...previous, authRequired: true } : previous));
    setFeedback({
      tone: 'ok',
      text: configured ? t('adminPanel.success.changed') : t('adminPanel.success.set'),
    });
  }

  async function clearPassword() {
    if (busy || !window.confirm(t('adminPanel.clearConfirm'))) return;
    setBusy(true);
    setFeedback(null);
    const result = await changePassword({ action: 'clear', currentPassword: current });
    setBusy(false);
    if (!result.ok) {
      setFeedback({ tone: 'error', text: failureText(result) });
      return;
    }
    resetDraft();
    setStatus((previous) => (previous ? { ...previous, authRequired: false } : previous));
    setFeedback({ tone: 'ok', text: t('adminPanel.success.cleared') });
  }

  const passwordField = (
    id: string,
    labelKey: string,
    value: string,
    onChange: (value: string) => void,
    autoComplete: string,
  ) => (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <KeyRound size={12} strokeWidth={1.75} />
        {t(labelKey)}
      </label>
      <input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={busy}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground/70 focus:border-ring focus:ring-4 focus:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </div>
  );

  return (
    <section
      aria-label={t('adminPanel.section')}
      className={classNames(
        'space-y-3 rounded-lg border border-border/60 bg-section-b p-3',
        hidden && 'hidden',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={!available}
        className="flex w-full items-center justify-between rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {t('adminPanel.section')}
          </h2>
          <span
            className={classNames(
              'rounded px-1.5 py-0.5 text-[10px] font-medium',
              configured ? 'bg-success/10 text-success' : 'bg-surface-muted text-muted-foreground',
            )}
          >
            {t(statusKey)}
          </span>
        </div>
        {available && (
          <ChevronDown
            size={14}
            strokeWidth={1.75}
            className={classNames(
              'text-muted-foreground transition-transform',
              open ? 'rotate-0' : '-rotate-90',
            )}
          />
        )}
      </button>

      {available && open && (
        <div className="space-y-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-xs leading-relaxed text-muted-foreground">{t('adminPanel.desc')}</p>

          {remoteAndOpen && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
              <AlertTriangle
                size={13}
                strokeWidth={1.75}
                className="mt-0.5 shrink-0 text-warning"
              />
              <p className="text-xs leading-relaxed text-warning">
                {t('adminPanel.remoteWarning')}
              </p>
            </div>
          )}

          <form
            onSubmit={(event) => void submit(event)}
            className="space-y-3 rounded-md border border-input bg-surface-muted/40 p-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {configured &&
                passwordField(
                  'admin-current-password',
                  'adminPanel.label.current',
                  current,
                  setCurrent,
                  'current-password',
                )}
              {passwordField(
                'admin-next-password',
                'adminPanel.label.next',
                next,
                setNext,
                'new-password',
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {passwordField(
                'admin-confirm-password',
                'adminPanel.label.confirm',
                confirm,
                setConfirm,
                'new-password',
              )}
              <div className="flex items-end gap-2">
                <button
                  type="submit"
                  disabled={busy || next.length === 0}
                  className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-foreground text-xs font-semibold text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <KeyRound size={13} />
                  {t(configured ? 'adminPanel.action.change' : 'adminPanel.action.set')}
                </button>
                {configured && (
                  <button
                    type="button"
                    onClick={() => void clearPassword()}
                    disabled={busy}
                    className="flex h-10 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ShieldOff size={13} />
                    {t('adminPanel.action.clear')}
                  </button>
                )}
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">{t('adminPanel.hint.length')}</p>
          </form>

          {feedback && (
            <p
              role="alert"
              className={classNames(
                'flex items-center gap-1.5 text-xs',
                feedback.tone === 'ok' ? 'text-success' : 'text-destructive',
              )}
            >
              <ShieldCheck size={12} strokeWidth={1.75} />
              {feedback.text}
            </p>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t('adminPanel.note.cli')}
          </p>
        </div>
      )}
    </section>
  );
}
