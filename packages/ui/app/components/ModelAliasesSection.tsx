'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { classNames, GATEWAY, withUiHeaders } from '../lib/utils';
import { useI18n } from '../i18n';

type AliasRow = { alias: string; target: string };
type ModelOption = { id: string; provider: string; displayName?: string };

export function ModelAliasesSection() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [aliasRes, modelRes] = await Promise.all([
          fetch(`${GATEWAY}/api/model-aliases`, withUiHeaders()),
          fetch(`${GATEWAY}/api/auto-route/model-options`, withUiHeaders()),
        ]);
        if (cancelled) return;
        const aliasJson = (await aliasRes.json().catch(() => ({}))) as {
          modelAliases?: Record<string, string>;
        };
        const modelJson = (await modelRes.json().catch(() => ({}))) as { models?: ModelOption[] };
        setRows(
          Object.entries(aliasJson.modelAliases ?? {}).map(([alias, target]) => ({
            alias,
            target,
          })),
        );
        setModels(modelJson.models ?? []);
      } catch {
        if (!cancelled) setError(t('settings.aliases.loadFailed'));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: AliasRow[]) => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const modelAliases: Record<string, string> = {};
      for (const row of next) {
        const alias = row.alias.trim();
        if (alias) modelAliases[alias] = row.target;
      }
      const res = await fetch(
        `${GATEWAY}/api/model-aliases`,
        withUiHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelAliases }),
        }),
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `save failed ${res.status}`);
        return;
      }
      setRows(
        next
          .filter((row) => row.alias.trim())
          .map((row) => ({ alias: row.alias.trim(), target: row.target })),
      );
      setSaved(true);
    } catch {
      setError(t('settings.aliases.saveFailed'));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section
      aria-label={t('settings.aria.aliases')}
      className="space-y-3 rounded-lg border border-border/60 bg-section-c p-3"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {t('settings.section.aliases')}
          </h2>
          <span className="text-xs text-muted-foreground">
            {t('settings.section.aliases.desc')}
          </span>
        </div>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={classNames(
            'text-muted-foreground transition-transform',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
      </button>
      {open && loaded && (
        <div className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-xs text-muted-foreground">{t('settings.aliases.hint')}</p>
          {rows.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('settings.aliases.empty')}</p>
          )}
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={row.alias}
                aria-label={t('settings.aliases.aliasLabel', { index: index + 1 })}
                placeholder={t('settings.aliases.aliasPlaceholder')}
                onChange={(e) =>
                  setRows((cur) =>
                    cur.map((r, i) => (i === index ? { ...r, alias: e.target.value } : r)),
                  )
                }
                className="h-9 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring"
              />
              <select
                value={row.target}
                aria-label={t('settings.aliases.targetLabel', { index: index + 1 })}
                onChange={(e) =>
                  setRows((cur) =>
                    cur.map((r, i) => (i === index ? { ...r, target: e.target.value } : r)),
                  )
                }
                className="h-9 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring"
              >
                <option value="">{t('settings.aliases.targetPlaceholder')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id} ({m.id})
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={t('settings.aliases.remove', { index: index + 1 })}
                onClick={() => setRows((cur) => cur.filter((_, i) => i !== index))}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRows((cur) => [...cur, { alias: '', target: '' }])}
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              <Plus size={14} />
              {t('settings.aliases.add')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(rows)}
              className="inline-flex h-9 items-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-85 disabled:opacity-50"
            >
              {t('settings.aliases.save')}
            </button>
            {saved && <span className="text-xs text-success">{t('settings.aliases.saved')}</span>}
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
