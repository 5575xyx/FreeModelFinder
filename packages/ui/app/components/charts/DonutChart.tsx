'use client';

import { classNames } from '../../lib/utils';

export interface DonutSlice {
  label: string;
  value: number;
}

/**
 * Donut chart drawn with stroke-dasharray on circles — no path arc math, and a
 * total of zero renders an explicit empty state instead of NaN segments.
 */
export function DonutChart({
  slices,
  ariaLabel,
  formatValue = (v) => String(v),
}: {
  slices: DonutSlice[];
  ariaLabel: string;
  formatValue?: (v: number) => string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) {
    return (
      <p data-testid="chart-empty" className="px-4 py-8 text-center text-xs text-muted-foreground">
        {ariaLabel}
      </p>
    );
  }

  // r for a 42-unit viewBox: 2*pi*r = 100 makes dasharray math percentage-based.
  const radius = 15.9155;
  const circumference = 100;
  const colors = [
    'stroke-foreground/80',
    'stroke-foreground/55',
    'stroke-foreground/35',
    'stroke-foreground/20',
    'stroke-foreground/12',
  ];

  let offset = 0;
  return (
    <div className="flex items-center gap-4 px-4 py-4">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox="0 0 42 42"
        className="h-28 w-28 shrink-0 -rotate-90"
      >
        {slices
          .filter((slice) => slice.value > 0)
          .map((slice, index) => {
            const fraction = (slice.value / total) * circumference;
            const dash = `${fraction} ${circumference - fraction}`;
            const element = (
              <circle
                key={slice.label}
                cx="21"
                cy="21"
                r={radius}
                fill="transparent"
                strokeWidth="4"
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                className={classNames(colors[index % colors.length])}
                data-testid="slice"
              >
                <title>{`${slice.label}: ${formatValue(slice.value)}`}</title>
              </circle>
            );
            offset += fraction;
            return element;
          })}
      </svg>
      <ul className="space-y-1 text-xs">
        {slices
          .filter((slice) => slice.value > 0)
          .map((slice, index) => (
            <li key={slice.label} className="flex items-center gap-2">
              <span
                aria-hidden
                className={classNames(
                  'inline-block h-2 w-2 rounded-full',
                  [
                    'bg-foreground/80',
                    'bg-foreground/55',
                    'bg-foreground/35',
                    'bg-foreground/20',
                    'bg-foreground/12',
                  ][index % 5],
                )}
              />
              <span className="font-mono text-muted-foreground">{slice.label}</span>
              <span>{formatValue(slice.value)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
