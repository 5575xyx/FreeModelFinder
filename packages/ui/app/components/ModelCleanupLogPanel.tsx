'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Clock, RefreshCw, ShieldOff } from 'lucide-react';
import { GATEWAY, classNames, withUiHeaders } from '../lib/utils';
import { useI18n } from '../i18n';

type Translator = (key: string, params?: Record<string, string | number>) => string;

interface CleanupEntry {
  ts: number;
  removedModelIds: string[];
  fullyRemovedProviders: string[];
  allowlistEntriesPruned: number;
  aliasEntriesPruned: number;
  autoRoutePoolsEmptied: number;
  defaultModelChanged: boolean;
}

interface CleanupLogResponse {
  entries: CleanupEntry[];
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function formatTime(ts: number, t: Translator): string {
  if (!ts) return t('inspect.notInspected');
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('inspect.justNow');
  if (diff < 3_600_000) return t('inspect.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('inspect.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  return t('inspect.daysAgo', { n: Math.floor(diff / 86_400_000) });
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function summarizePruning(entry: CleanupEntry, t: Translator): string[] {
  const bits: string[] = [];
  if (entry.allowlistEntriesPruned > 0) {
    bits.push(t('inspect.cleanup.allowlist', { n: entry.allowlistEntriesPruned }));
  }
  if (entry.aliasEntriesPruned > 0) {
    bits.push(t('inspect.cleanup.aliases', { n: entry.aliasEntriesPruned }));
  }
  if (entry.autoRoutePoolsEmptied > 0) {
    bits.push(t('inspect.cleanup.pools', { n: entry.autoRoutePoolsEmptied }));
  }
  if (entry.defaultModelChanged) {
    bits.push(t('inspect.cleanup.defaultModel'));
  }
  return bits;
}

export function ModelCleanupLogPanel() {
  const { t } = useI18n();
  const [data, setData] = useState<CleanupLogResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${GATEWAY}/api/model-cleanup-log`, withUiHeaders());
      if (!res.ok) throw new Error(`gateway error ${res.status}`);
      const json = (await res.json()) as CleanupLogResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // Latest 24h entries, newest first
  const recent = useMemo(() => {
    if (!data) return [];
    const cutoff = Date.now() - 86_400_000;
    return data.entries.filter((e) => e.ts >= cutoff).slice(0, 20);
  }, [data]);

  return (
    <div className="rounded-md border border-border bg-surface-muted/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
          <ShieldOff size={13} strokeWidth={1.75} />
          <span>{t('inspect.cleanup.title')}</span>
          {recent.length > 0 && (
            <span className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
              {recent.length}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-sm transition hover:border-border-strong disabled:opacity-60"
          >
            <RefreshCw
              size={12}
              strokeWidth={1.75}
              className={classNames(refreshing && 'animate-spin')}
            />
            {refreshing ? t('inspect.running') : t('inspect.refresh')}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-1 py-1 text-xs text-destructive">
          {t('inspect.errorLoad', { err: error })}
        </div>
      )}

      {recent.length === 0 && !error && (
        <p className="px-1 py-1 text-xs text-muted-foreground">{t('inspect.cleanup.empty')}</p>
      )}

      {recent.length > 0 && (
        <ul className="space-y-2">
          {recent.map((entry, i) => {
            const bits = summarizePruning(entry, t);
            const fullyRemoved = entry.fullyRemovedProviders;
            return (
              <li
                key={`${entry.ts}-${i}`}
                className="rounded border border-border bg-surface p-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    <Clock size={11} strokeWidth={1.75} className="text-muted-foreground" />
                    {formatDateTime(entry.ts)}
                  </span>
                  <span className="text-muted-foreground">{formatTime(entry.ts, t)}</span>
                </div>

                {fullyRemoved.length > 0 && (
                  <div className="mt-1 flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <AlertTriangle size={11} strokeWidth={1.75} />
                    <span>
                      {t('inspect.cleanup.providerGone', { providers: fullyRemoved.join(', ') })}
                    </span>
                  </div>
                )}

                {bits.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                    {bits.map((b, j) => (
                      <span key={j} className="text-foreground">
                        {b}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-muted-foreground">{t('inspect.cleanup.noRefs')}</div>
                )}

                {entry.removedModelIds.length > 0 && (
                  <div className="mt-1 text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {t('inspect.cleanup.removedModels', { n: entry.removedModelIds.length })}
                    </span>
                    <code className="ml-1.5 font-mono text-[10px]">
                      {entry.removedModelIds.join(', ')}
                    </code>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
