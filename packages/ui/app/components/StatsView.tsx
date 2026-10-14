'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Clock,
  Loader2,
  PieChart,
  RefreshCw,
  Table2,
  Zap,
} from 'lucide-react';
import { classNames, GATEWAY, withUiHeaders } from '../lib/utils';
import { useI18n } from '../i18n';
import { BarChart, type BarPoint } from './charts/BarChart';
import { DonutChart, type DonutSlice } from './charts/DonutChart';

type StatsRange = 'today' | '7d' | '30d' | '90d' | 'all';
type Granularity = 'day' | 'week' | 'month';
type TrendView = 'table' | 'bar' | 'pie';

type StatsTotals = {
  calls: number;
  errors: number;
  rateLimited: number;
  success: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
};

type StatsModelRow = {
  provider: string;
  model: string;
  calls: number;
  errors: number;
  rateLimited: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
};

type StatsPayload = {
  range: StatsRange;
  since: number;
  totals: StatsTotals;
  byModel: StatsModelRow[];
};

type StatsSeries = {
  range: StatsRange;
  bucket: Granularity;
  since: number;
  until: number;
  points: {
    start: number;
    calls: number;
    errors: number;
    rateLimited: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
  }[];
};

type CallLogEntry = {
  ts: number;
  kind: 'chat' | 'image' | 'video';
  provider: string;
  model: string;
  status: 'success' | 'error' | 'rate_limited';
  httpStatus?: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  gatewayKeyId?: string;
  error?: string;
};

const RANGES: readonly StatsRange[] = ['today', '7d', '30d', '90d', 'all'];
const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month'];
const TREND_VIEWS: readonly TrendView[] = ['table', 'bar', 'pie'];
const POLL_INTERVAL = 10_000;
const LOG_LIMIT = 50;

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBucketLabel(ts: number, bucket: Granularity): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (bucket === 'month') return `${pad(d.getMonth() + 1)}`;
  if (bucket === 'week') return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function StatsView() {
  const { t } = useI18n();
  const [range, setRange] = useState<StatsRange>('today');
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [trendView, setTrendView] = useState<TrendView>('table');
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [series, setSeries] = useState<StatsSeries | null>(null);
  const [logs, setLogs] = useState<CallLogEntry[]>([]);
  const [logCursor, setLogCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error' | 'rate_limited'>(
    'all',
  );

  const refresh = useCallback(async () => {
    try {
      const statusQuery = statusFilter !== 'all' ? `&status=${statusFilter}` : '';
      const [statsResp, seriesResp, logsResp] = await Promise.all([
        fetch(`${GATEWAY}/api/stats?range=${range}`, withUiHeaders()),
        fetch(`${GATEWAY}/api/stats/series?range=${range}&bucket=${granularity}`, withUiHeaders()),
        fetch(`${GATEWAY}/api/logs?limit=${LOG_LIMIT}${statusQuery}`, withUiHeaders()),
      ]);
      if (!statsResp.ok) throw new Error(`stats error ${statsResp.status}`);
      setStats((await statsResp.json()) as StatsPayload);
      if (seriesResp.ok) setSeries((await seriesResp.json()) as StatsSeries);
      if (logsResp.ok) {
        const payload = (await logsResp.json()) as {
          data: CallLogEntry[];
          nextCursor: string | null;
        };
        setLogs(payload.data ?? []);
        setLogCursor(payload.nextCursor ?? null);
      }
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [range, granularity, statusFilter]);

  const loadMore = useCallback(async () => {
    if (!logCursor) return;
    try {
      const statusQuery = statusFilter !== 'all' ? `&status=${statusFilter}` : '';
      const resp = await fetch(
        `${GATEWAY}/api/logs?limit=${LOG_LIMIT}&cursor=${encodeURIComponent(logCursor)}${statusQuery}`,
        withUiHeaders(),
      );
      if (!resp.ok) return;
      const payload = (await resp.json()) as { data: CallLogEntry[]; nextCursor: string | null };
      setLogs((prev) => [...prev, ...(payload.data ?? [])]);
      setLogCursor(payload.nextCursor ?? null);
    } catch {
      /* the poll will retry */
    }
  }, [logCursor, statusFilter]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refresh]);

  const totals = stats?.totals;
  const cards: { key: string; label: string; value: string; icon: typeof Zap }[] = [
    {
      key: 'calls',
      label: t('stats.card.calls'),
      value: totals ? String(totals.calls) : '—',
      icon: Activity,
    },
    {
      key: 'success',
      label: t('stats.card.successRate'),
      value: totals ? formatPercent(totals.successRate) : '—',
      icon: CheckCircle2,
    },
    {
      key: 'prompt',
      label: t('stats.card.promptTokens'),
      value: totals ? formatTokens(totals.promptTokens) : '—',
      icon: Zap,
    },
    {
      key: 'completion',
      label: t('stats.card.completionTokens'),
      value: totals ? formatTokens(totals.completionTokens) : '—',
      icon: Zap,
    },
    {
      key: 'cache',
      label: t('stats.card.cacheHitRate'),
      value: totals ? formatPercent(totals.cacheHitRate) : '—',
      icon: Clock,
    },
    {
      key: 'errors',
      label: t('stats.card.errors'),
      value: totals ? String(totals.errors + totals.rateLimited) : '—',
      icon: AlertCircle,
    },
  ];

  return (
    <div className="h-full overflow-y-auto px-5 py-6 md:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={classNames(
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition',
                  r === range
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`stats.range.${r}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            <RefreshCw size={13} />
            {t('stats.refresh')}
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
          >
            {error}
          </div>
        )}

        {loading && !stats ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            {t('stats.loading')}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              {cards.map((card) => (
                <div key={card.key} className="rounded-2xl border border-border bg-surface p-4">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <card.icon size={12} />
                    {card.label}
                  </div>
                  <div className="mt-1.5 text-lg font-semibold tracking-[-0.02em]">
                    {card.value}
                  </div>
                </div>
              ))}
            </div>

            <section className="rounded-2xl border border-border bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <span className="text-sm font-semibold">{t('stats.byModel')}</span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
                    {GRANULARITIES.map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setGranularity(g)}
                        className={classNames(
                          'rounded-md px-2 py-0.5 text-[11px] font-medium transition',
                          g === granularity
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {t(`stats.granularity.${g}`)}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
                    {TREND_VIEWS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setTrendView(v)}
                        aria-label={t(`stats.view.${v}`)}
                        className={classNames(
                          'rounded-md p-1 transition',
                          v === trendView
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {v === 'table' ? (
                          <Table2 size={13} />
                        ) : v === 'bar' ? (
                          <BarChart3 size={13} />
                        ) : (
                          <PieChart size={13} />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {trendView === 'table' ? (
                stats && stats.byModel.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="px-4 py-2.5 font-medium">{t('stats.col.model')}</th>
                          <th className="px-4 py-2.5 font-medium">{t('stats.col.calls')}</th>
                          <th className="px-4 py-2.5 font-medium">{t('stats.col.prompt')}</th>
                          <th className="px-4 py-2.5 font-medium">{t('stats.col.completion')}</th>
                          <th className="px-4 py-2.5 font-medium">{t('stats.col.cache')}</th>
                          <th className="px-4 py-2.5 font-medium">{t('stats.col.errors')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.byModel.map((row) => (
                          <tr
                            key={`${row.provider}:${row.model}`}
                            className="border-b border-border/50 last:border-0"
                          >
                            <td className="max-w-[240px] truncate px-4 py-2.5 font-mono">
                              {row.model}
                            </td>
                            <td className="px-4 py-2.5">{row.calls}</td>
                            <td className="px-4 py-2.5">{formatTokens(row.promptTokens)}</td>
                            <td className="px-4 py-2.5">{formatTokens(row.completionTokens)}</td>
                            <td className="px-4 py-2.5">{formatPercent(row.cacheHitRate)}</td>
                            <td className="px-4 py-2.5">
                              {row.errors + row.rateLimited > 0 ? (
                                <span className="text-destructive">
                                  {row.errors + row.rateLimited}
                                </span>
                              ) : (
                                '0'
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                    {t('stats.empty')}
                  </p>
                )
              ) : trendView === 'bar' ? (
                series && series.points.length > 0 ? (
                  <div className="px-2 pb-3 pt-1">
                    <div className="px-2 pb-1 text-[11px] text-muted-foreground">
                      {t('stats.series.title')} · {t(`stats.granularity.${series.bucket}`)}
                    </div>
                    <BarChart
                      ariaLabel={t('stats.series.title')}
                      points={series.points.map((p): BarPoint => ({
                        label: formatBucketLabel(p.start, series.bucket),
                        value: p.calls,
                        secondary: p.errors + p.rateLimited,
                      }))}
                      formatValue={(v) => String(v)}
                    />
                  </div>
                ) : (
                  <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                    {t('stats.chart.empty')}
                  </p>
                )
              ) : stats && stats.byModel.length > 0 ? (
                (() => {
                  const top = stats.byModel.slice(0, 8);
                  const rest = stats.byModel.slice(8);
                  const slices: DonutSlice[] = top.map((r) => ({
                    label: r.model,
                    value: r.calls,
                  }));
                  if (rest.length > 0) {
                    slices.push({
                      label: t('stats.byModel.other'),
                      value: rest.reduce((n, r) => n + r.calls, 0),
                    });
                  }
                  return (
                    <DonutChart
                      ariaLabel={t('stats.byModel.pie')}
                      slices={slices}
                      formatValue={(v) => String(v)}
                    />
                  );
                })()
              ) : (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                  {t('stats.chart.empty')}
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-border bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <span className="text-sm font-semibold">{t('stats.logs.title')}</span>
                <div className="flex items-center gap-1">
                  {(['all', 'success', 'error', 'rate_limited'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatusFilter(s)}
                      className={classNames(
                        'rounded-lg px-2.5 py-1 text-[11px] font-medium transition',
                        s === statusFilter
                          ? 'bg-foreground text-background'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(`stats.logs.filter.${s}`)}
                    </button>
                  ))}
                </div>
              </div>
              {logs.length > 0 ? (
                <div className="max-h-[420px] overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-surface">
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="px-4 py-2.5 font-medium">{t('stats.col.time')}</th>
                        <th className="px-4 py-2.5 font-medium">{t('stats.col.kind')}</th>
                        <th className="px-4 py-2.5 font-medium">{t('stats.col.model')}</th>
                        <th className="px-4 py-2.5 font-medium">{t('stats.col.status')}</th>
                        <th className="px-4 py-2.5 font-medium">{t('stats.col.latency')}</th>
                        <th className="px-4 py-2.5 font-medium">{t('stats.col.tokens')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log, index) => (
                        <tr
                          key={`${log.ts}-${index}`}
                          data-testid="log-row"
                          className="border-b border-border/50 last:border-0"
                          title={log.error}
                        >
                          <td className="whitespace-nowrap px-4 py-2.5 font-mono text-muted-foreground">
                            {formatTime(log.ts)}
                          </td>
                          <td className="px-4 py-2.5">{t(`stats.kind.${log.kind}`)}</td>
                          <td className="max-w-[220px] truncate px-4 py-2.5 font-mono">
                            {log.model}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={classNames(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                                log.status === 'success'
                                  ? 'bg-success/10 text-success'
                                  : log.status === 'rate_limited'
                                    ? 'bg-warning/10 text-warning'
                                    : 'bg-destructive/10 text-destructive',
                              )}
                            >
                              {log.status === 'success' ? (
                                <CheckCircle2 size={10} />
                              ) : (
                                <AlertCircle size={10} />
                              )}
                              {t(`stats.logs.status.${log.status}`)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono">{log.latencyMs}ms</td>
                          <td className="px-4 py-2.5 font-mono">
                            {log.promptTokens != null || log.completionTokens != null
                              ? `${formatTokens(log.promptTokens ?? 0)}/${formatTokens(log.completionTokens ?? 0)}`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {logCursor && (
                    <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
                      <span className="text-[11px] text-muted-foreground">
                        {t('stats.logs.loadedCount').replace('{count}', String(logs.length))}
                      </span>
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        className="rounded-xl border border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
                      >
                        {t('stats.logs.loadMore')}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                  {t('stats.logs.empty')}
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
