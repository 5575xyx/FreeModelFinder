'use client';

import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { GATEWAY, withUiHeaders } from '../lib/utils';

export interface AdminStatus {
  authRequired: boolean;
  authenticated: boolean;
  /**
   * This request did not arrive over loopback. The only evidence the server can
   * give that the panel is reachable from outside the machine. Absent on the
   * local state copies below, which is read as "not remote".
   */
  remote?: boolean;
}

/**
 * Reads the sign-in state without ever failing. `null` means "the gateway does
 * not speak this endpoint" — an older build that predates sign-in — so the
 * caller falls back to its previous behaviour instead of locking anyone out.
 */
export async function fetchAdminStatus(): Promise<AdminStatus | null> {
  try {
    const response = await fetch(`${GATEWAY}/api/admin/status`, withUiHeaders());
    if (!response.ok) return null;
    const body = (await response.json()) as AdminStatus;
    if (typeof body.authRequired !== 'boolean') return null;
    return {
      authRequired: body.authRequired,
      authenticated: body.authenticated === true,
      remote: body.remote === true,
    };
  } catch {
    return null;
  }
}

export function AdminLoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        `${GATEWAY}/api/admin/login`,
        withUiHeaders({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        }),
      );
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setError(body?.error?.message || t('admin.login.failed'));
        setSubmitting(false);
        return;
      }
      const status = await fetchAdminStatus();
      if (status?.authenticated) {
        onSignedIn();
        return;
      }
      setError(t('admin.login.sessionMissing'));
      setSubmitting(false);
    } catch {
      setError(t('admin.login.network'));
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground text-xs font-bold tracking-tight text-background">
            NV
          </span>
          <div>
            <p className="text-sm font-semibold tracking-[-0.02em]">NovaWay Model Gateway</p>
          </div>
        </div>

        <form
          onSubmit={(event) => void submit(event)}
          className="rounded-2xl border border-border bg-surface p-6 shadow-sm"
        >
          <div className="mb-2 flex items-center gap-2.5">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">{t('admin.login.title')}</h1>
          </div>
          <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
            {t('admin.login.subtitle')}
          </p>

          <label
            htmlFor="admin-password"
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
          >
            {t('admin.login.password')}
          </label>
          <input
            id="admin-password"
            name="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            placeholder={t('admin.login.placeholder')}
            className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground/70 focus:border-ring focus:ring-4 focus:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !password}
            className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground text-sm font-semibold text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <KeyRound size={15} />
            {submitting ? t('admin.login.submitting') : t('admin.login.submit')}
          </button>
        </form>
      </div>
    </main>
  );
}

/**
 * Header button shown once a management password exists. The logout call is
 * best-effort: the reload is what actually drops the UI back to the sign-in
 * screen, so a network failure here must not leave the button hanging.
 */
export function AdminSignOutButton() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    await fetch(`${GATEWAY}/api/admin/logout`, withUiHeaders({ method: 'POST' })).catch(
      () => undefined,
    );
    window.location.reload();
  }

  return (
    <button
      type="button"
      aria-label={t('admin.signOut')}
      title={t('admin.signOut')}
      onClick={() => void signOut()}
      disabled={busy}
      className="flex h-9 items-center gap-1.5 rounded-xl border border-border bg-surface px-2.5 text-[11px] font-medium text-muted-foreground transition hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/10 disabled:opacity-50"
    >
      <ShieldCheck size={13} />
      <span className="hidden sm:inline">{t('admin.signOut')}</span>
    </button>
  );
}
