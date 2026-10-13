'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import { validateAliasName, type AliasNameError } from '../lib/modelAliases';
import { classNames } from '../lib/utils';

export interface ModelAliasInputProps {
  /** Composed model id the alias points at, e.g. `custom:novay:glm-5.3`. */
  target: string;
  /** Current alias name for this model, if any. */
  alias?: string;
  /** Full global alias map (name → composed target), used for collision checks. */
  aliases: Record<string, string>;
  /** Disables the input, the remove button, and every save path. */
  disabled?: boolean;
  /** Persists one alias edit; `name` is the trimmed draft, `''` means "clear". */
  onSave: (target: string, name: string) => Promise<void>;
}

/**
 * Per-model alias editor for the model cards. Commits on blur and on Enter,
 * resets on Escape, and enforces the alias rules through `validateAliasName`
 * (empty = clear, no `:`, no reserved words, not taken by another model).
 */
export function ModelAliasInput({
  target,
  alias,
  aliases,
  disabled,
  onSave,
}: ModelAliasInputProps) {
  const { t } = useI18n();
  const inputId = useId();
  const [draft, setDraft] = useState(alias ?? '');
  const [error, setError] = useState<AliasNameError | null>(null);
  const [saving, setSaving] = useState(false);
  // Tracked via ref so a parent re-render mid-typing cannot clobber the draft:
  // the alias-prop sync below skips while the input is focused.
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(alias ?? '');
  }, [alias]);

  const commit = useCallback(
    async (rawName: string) => {
      if (disabled) return;
      // validateAliasName trims internally; an empty name means "clear the alias".
      const err = validateAliasName(rawName, target, aliases);
      if (err) {
        setError(err);
        return;
      }
      setError(null);
      const name = rawName.trim();
      setDraft(name);
      setSaving(true);
      try {
        await onSave(target, name);
      } catch (e) {
        setError({
          key: 'finder.alias.error.saveFailed',
          params: { detail: e instanceof Error ? e.message : String(e) },
        });
      } finally {
        setSaving(false);
      }
    },
    [aliases, disabled, onSave, target],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit(draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(alias ?? '');
      setError(null);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          {t('finder.alias.label')}
        </label>
        {saving ? (
          <span className="text-xs text-muted-foreground">{t('finder.alias.saving')}</span>
        ) : alias ? (
          <span className="text-xs text-muted-foreground">{t('finder.alias.saved')}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          value={draft}
          placeholder={t('finder.alias.placeholder')}
          disabled={disabled}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
            void commit(draft);
          }}
          onKeyDown={handleKeyDown}
          onChange={(e) => setDraft(e.target.value)}
          className={classNames(
            'h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus:border-ring disabled:opacity-50',
            error && 'border-destructive',
          )}
        />
        {alias && (
          <button
            type="button"
            aria-label={t('finder.alias.remove')}
            disabled={disabled}
            // Keep the input's focus on click so clearing never races a blur commit.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void commit('')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:text-destructive disabled:opacity-50"
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t(error.key, error.params)}
        </p>
      )}
    </div>
  );
}
