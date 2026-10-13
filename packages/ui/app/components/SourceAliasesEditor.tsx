'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { GATEWAY, withUiHeaders } from '../lib/utils';
import type { SourceAliasEdit } from '../lib/sourceAliases';
import { useI18n } from '../i18n';

export interface SourceAliasesEditorProps {
  /** Custom source id, e.g. `novay`. Rows are reported as `<sourceId>/<alias>` entries upstream. */
  sourceId: string;
  /** Display name of the source; used in the section title. */
  sourceLabel?: string;
  /** Model ids belonging to this source; the target dropdown lists only these. */
  sourceModels: string[];
  /** Receives the current list of valid rows on every row add/edit/remove. */
  onAliasesChange: (edits: SourceAliasEdit[]) => void;
}

/** Alias names that collide with reserved routing keywords are not reported. */
const RESERVED_ALIAS_NAMES = new Set(['auto', 'default']);

/**
 * The single validity predicate shared by hydration and reporting: an alias
 * name is usable only when it is non-empty after trimming, contains neither
 * `/` (which would double the source prefix) nor `:`, and is not a reserved
 * routing keyword.
 */
function isValidAliasName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.includes('/') &&
    !trimmed.includes(':') &&
    !RESERVED_ALIAS_NAMES.has(trimmed)
  );
}

/**
 * Reduce editing-state rows to the reportable edits: keep only valid,
 * fully-targeted rows and normalize the alias name by trimming it (so
 * `' glm '` reports as `'glm'` and never creates a distinct `sourceId/glm `
 * key). The raw value stays in editing state so the user can keep typing.
 */
function toReportedEdits(rows: SourceAliasEdit[]): SourceAliasEdit[] {
  return rows
    .filter((row) => isValidAliasName(row.alias) && row.targetModel.length > 0)
    .map((row) => ({ alias: row.alias.trim(), targetModel: row.targetModel }));
}

/**
 * The target `<option>` values are the composed `custom:<sourceId>:<model>`
 * form (so the dropdown is unambiguous), but a row stores the bare model id
 * expected by `SourceAliasEdit.targetModel`. Strip the prefix on change.
 */
function stripTargetPrefix(value: string, sourceId: string): string {
  const prefix = `custom:${sourceId}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : '';
}

export function SourceAliasesEditor({
  sourceId,
  sourceLabel,
  sourceModels,
  onAliasesChange,
}: SourceAliasesEditorProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<SourceAliasEdit[]>([]);
  const [legacyNames, setLegacyNames] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // The hydration effect must key on the *content* of `sourceModels`, not its
  // array identity: the parent passes `source.models.map(m => m.id)`, a fresh
  // array on every render, and an identity-keyed effect would re-fetch and
  // wipe the user's in-progress edit. React compares string deps by value, so
  // `modelsKey` stays stable across equal-content arrays.
  const modelsKey = useMemo(() => sourceModels.join('\u0000'), [sourceModels]);
  const onAliasesChangeRef = useRef(onAliasesChange);
  onAliasesChangeRef.current = onAliasesChange;

  // Hydrate once per (sourceId, content-of-sourceModels): back-fill rows from
  // `sourceId/*` entries of the global table; bare (prefix-less) entries only
  // drive the legacy migration hint. On success, report the hydrated rows once
  // (even when empty) so the source becomes an authoritative namespace.
  useEffect(() => {
    let cancelled = false;
    const modelSet = new Set(modelsKey.length > 0 ? modelsKey.split('\u0000') : []);
    void (async () => {
      try {
        const res = await fetch(`${GATEWAY}/api/model-aliases`, withUiHeaders());
        if (!res.ok) {
          if (!cancelled) setLoadFailed(true);
          return;
        }
        const json = (await res.json().catch(() => ({}))) as {
          modelAliases?: Record<string, string>;
        };
        if (cancelled) return;
        const aliases = json.modelAliases ?? {};
        const prefix = `${sourceId}/`;
        const expectedTargetPrefix = `custom:${sourceId}:`;
        const nextRows: SourceAliasEdit[] = [];
        const bare: string[] = [];
        for (const [key, value] of Object.entries(aliases)) {
          if (key.startsWith(prefix)) {
            const alias = key.slice(prefix.length);
            // Strict: only accept a composed target of *this* source; no
            // `split(':').pop()` fallback that could hydrate a bogus row.
            if (isValidAliasName(alias) && value.startsWith(expectedTargetPrefix)) {
              const targetModel = value.slice(expectedTargetPrefix.length);
              if (targetModel.length > 0 && modelSet.has(targetModel)) {
                nextRows.push({ alias, targetModel });
              }
            }
          } else if (!key.includes('/')) {
            bare.push(key);
          }
        }
        setRows(nextRows);
        setLegacyNames(bare);
        // Authoritative report: exactly once per hydration run.
        onAliasesChangeRef.current(toReportedEdits(nextRows));
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, modelsKey]);

  const commit = useCallback((next: SourceAliasEdit[]) => {
    setRows(next);
    onAliasesChangeRef.current(toReportedEdits(next));
  }, []);

  const addRow = useCallback(
    () => commit([...rows, { alias: '', targetModel: '' }]),
    [commit, rows],
  );

  const removeRow = useCallback(
    (index: number) => commit(rows.filter((_, i) => i !== index)),
    [commit, rows],
  );

  const setRowField = useCallback(
    (index: number, patch: Partial<SourceAliasEdit>) =>
      commit(rows.map((r, i) => (i === index ? { ...r, ...patch } : r))),
    [commit, rows],
  );

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-foreground">
        {t('settings.sourceAliases.title')}
        {sourceLabel ? ` · ${sourceLabel}` : ''}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t('settings.sourceAliases.hint', { prefix: sourceId })}
      </p>
      {hydrated && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('settings.aliases.empty')}</p>
      )}
      {legacyNames.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('settings.sourceAliases.legacyHint', { names: legacyNames.join(', ') })}
        </p>
      )}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <span className="shrink-0 select-none font-mono text-xs text-muted-foreground">
            {t('settings.sourceAliases.lockedPrefix', { sourceId })}
          </span>
          <input
            value={row.alias}
            aria-label={t('settings.aliases.aliasLabel', { index: index + 1 })}
            placeholder={t('settings.sourceAliases.aliasPlaceholder')}
            onChange={(e) => setRowField(index, { alias: e.target.value })}
            className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring"
          />
          <select
            value={row.targetModel ? `custom:${sourceId}:${row.targetModel}` : ''}
            aria-label={t('settings.aliases.targetLabel', { index: index + 1 })}
            onChange={(e) =>
              setRowField(index, {
                targetModel: stripTargetPrefix(e.target.value, sourceId),
              })
            }
            className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring"
          >
            <option value="">{t('settings.sourceAliases.targetPlaceholder')}</option>
            {sourceModels.map((m) => (
              <option key={m} value={`custom:${sourceId}:${m}`}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={t('settings.sourceAliases.remove', { index: index + 1 })}
            onClick={() => removeRow(index)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:text-destructive"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {hydrated && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={addRow}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            <Plus size={14} />
            {t('settings.sourceAliases.add')}
          </button>
        </div>
      )}
      {loadFailed && (
        <p role="alert" className="text-xs text-destructive">
          {t('settings.aliases.loadFailed')}
        </p>
      )}
    </div>
  );
}
