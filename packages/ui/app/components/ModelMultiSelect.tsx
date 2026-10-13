'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
// Chip remove spans stay nested inside the trigger button (established pattern
// with e.stopPropagation); structural extraction deferred to Task 6/7 if needed.
import { Check, ChevronDown, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { classNames } from '../lib/utils';

export interface ModelOption {
  id: string;
  provider: string;
  displayName?: string;
  capabilities?: string[];
  vision?: boolean;
  /** user-facing alias name; searched alongside the other fields (Task 6 fills it) */
  alias?: string;
}

interface ModelMultiSelectProps {
  label: string;
  hint?: string;
  value: string[];
  onChange: (next: string[]) => void;
  filterCapability?: 'image' | 'video' | 'text' | 'vision';
  placeholder?: string;
  /** options supplied by parent (Task 6 fetches once and shares) */
  options: ModelOption[];
  disabled?: boolean;
}

// Mirror of core VISION_ID_RE (packages/core/src/vision.ts) — keep in sync.
const VISION_FALLBACK_RE =
  /vision|4v|vl|qwen2?\.?vl|glm-4v|llava|moondream|pixtral|mistral-small-vision|internvl|falcon-vision/i;

export function matchesCapability(
  option: ModelOption,
  filter?: 'image' | 'video' | 'text' | 'vision',
): boolean {
  if (!filter) return true;
  if (filter === 'vision') {
    if (typeof option.vision === 'boolean') return option.vision;
    return VISION_FALLBACK_RE.test(`${option.id} ${option.displayName ?? ''}`);
  }
  const caps = option.capabilities;
  const hasCaps = Array.isArray(caps) && caps.length > 0;
  const bare = `${option.id} ${option.displayName ?? ''}`;
  if (filter === 'image') {
    return hasCaps ? caps!.includes('image') : /image/i.test(bare);
  }
  if (filter === 'video') {
    return hasCaps ? caps!.includes('video') : /video/i.test(bare);
  }
  // text: multimodal text-capable models OK; exclude only pure image/video
  if (!hasCaps) return !/image|video/i.test(bare);
  return caps!.includes('text') || (!caps!.includes('image') && !caps!.includes('video'));
}

/** Case-insensitive substring match over every user-visible field of an option. */
function matchesQuery(option: ModelOption, q: string): boolean {
  return (
    option.id.toLowerCase().includes(q) ||
    option.provider.toLowerCase().includes(q) ||
    (option.displayName?.toLowerCase().includes(q) ?? false) ||
    (option.alias?.toLowerCase().includes(q) ?? false)
  );
}

export function ModelMultiSelect({
  label,
  hint,
  value,
  onChange,
  filterCapability,
  placeholder,
  options,
  disabled = false,
}: ModelMultiSelectProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // The search query only makes sense for the current panel session.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const filtered = useMemo(() => {
    const byCapability = options.filter((o) => matchesCapability(o, filterCapability));
    const q = query.trim().toLowerCase();
    // An empty/whitespace-only query is "no filter", not "no matches".
    if (!q) return byCapability;
    return byCapability.filter((o) => matchesQuery(o, q));
  }, [options, filterCapability, query]);

  const selectedSet = useMemo(() => new Set(value), [value]);

  const optionLabel = (opt: ModelOption) => opt.displayName ?? opt.id;

  function toggle(opt: ModelOption) {
    if (disabled) return;
    // Keep existing value order; append newly added ids at the end.
    if (selectedSet.has(opt.id)) {
      onChange(value.filter((id) => id !== opt.id));
    } else {
      onChange([...value, opt.id]);
    }
  }

  function clear() {
    if (disabled) return;
    onChange([]);
    setQuery('');
  }

  const displayPlaceholder = placeholder ?? t('modelMultiSelect.placeholder');

  return (
    <div ref={rootRef} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {value.length > 0 && !disabled && (
          <button
            type="button"
            onClick={clear}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t('modelMultiSelect.clear')}
          </button>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((v) => !v)}
          className={classNames(
            'flex w-full min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border border-input bg-surface px-2.5 py-1.5 text-left text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {value.length === 0 ? (
            <span className="text-muted-foreground/70">{displayPlaceholder}</span>
          ) : (
            <>
              {value.map((id) => (
                <span
                  key={id}
                  className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                >
                  <span className="truncate">{id}</span>
                  {!disabled && (
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`${label}: ${id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onChange(value.filter((x) => x !== id));
                      }}
                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                    >
                      <X size={11} strokeWidth={2} />
                    </span>
                  )}
                </span>
              ))}
              <span className="ml-auto shrink-0 pl-1 text-[11px] text-muted-foreground">
                {t('modelMultiSelect.selected', { count: value.length })}
              </span>
            </>
          )}
          <ChevronDown
            size={14}
            strokeWidth={1.75}
            className={classNames(
              'shrink-0 text-muted-foreground transition-transform',
              open ? 'rotate-0' : '-rotate-90',
            )}
          />
        </button>

        {open && !disabled && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface shadow-md">
            <div className="border-b border-border px-2 py-1.5">
              <input
                type="search"
                role="searchbox"
                aria-label={label}
                placeholder={t('modelMultiSelect.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-md border border-input bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <ul role="listbox" aria-label={label} className="max-h-56 overflow-auto py-1">
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  {t('modelMultiSelect.empty')}
                </li>
              )}
              {filtered.map((opt) => {
                const selected = selectedSet.has(opt.id);
                return (
                  <li key={`${opt.provider}:${opt.id}`} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      onClick={() => toggle(opt)}
                      className={classNames(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition',
                        selected
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:bg-surface-muted/60 hover:text-foreground',
                      )}
                    >
                      <span
                        className={classNames(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                          selected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input bg-surface',
                        )}
                      >
                        {selected && <Check size={10} strokeWidth={2.5} />}
                      </span>
                      <span className="truncate font-mono text-[11px]">{opt.id}</span>
                      <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">
                        {optionLabel(opt) !== opt.id ? optionLabel(opt) : opt.provider}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
