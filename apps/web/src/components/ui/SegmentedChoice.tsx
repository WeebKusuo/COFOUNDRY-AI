import { cn } from '../../lib/cn';

/**
 * Single choice from a short ordered scale (e.g. skill level 1-5) as a native radio group.
 * Each option shows its number and an accessible label.
 */
export function SegmentedChoice({
  legend,
  name,
  options,
  value,
  onChange,
  hideLegend = false,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<{ value: number; label: string }>;
  value: number;
  onChange: (next: number) => void;
  hideLegend?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className={cn('text-sm font-semibold text-ink', hideLegend && 'sr-only')}>
        {legend}
      </legend>
      <div className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              title={option.label}
              className={cn(
                'tabular relative inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-sm font-semibold transition-colors',
                'has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus',
                checked ? 'bg-brand text-on-brand' : 'text-ink-muted hover:bg-surface-sunk',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
                aria-label={`${option.value} — ${option.label}`}
              />
              {option.value}
            </label>
          );
        })}
      </div>
      {current ? <span className="text-xs text-ink-muted">{current.label}</span> : null}
    </fieldset>
  );
}
