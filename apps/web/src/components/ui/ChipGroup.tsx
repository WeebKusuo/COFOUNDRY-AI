import { useId } from 'react';
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Multi-select as a fieldset of real checkboxes styled as chips, so keyboard and screen-reader
 * behaviour is native. Selection state is shown with a check mark and text weight, not colour
 * alone. Unselected options are disabled once `max` is reached.
 */
export function ChipGroup<T extends string>({
  legend,
  hint,
  options,
  value,
  onChange,
  max,
  error,
  name,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  options: ReadonlyArray<ChipOption<T>>;
  value: readonly T[];
  onChange: (next: T[]) => void;
  max?: number;
  error?: string | undefined;
  name: string;
}) {
  const id = useId();
  const atMax = max !== undefined && value.length >= max;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={describedBy || undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="label-mono mb-1 flex w-full items-baseline justify-between gap-3 text-ink-muted">
        <span>{legend}</span>
        {max !== undefined ? (
          <span className="tabular text-ink-faint">
            {value.length}/{max}
          </span>
        ) : null}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const checked = value.includes(option.value);
          const disabled = !checked && atMax;
          return (
            <label
              key={option.value}
              className={cn(
                'relative inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-3 py-1.5 text-sm transition-colors',
                'has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
                checked
                  ? 'border-ink bg-brand-soft font-semibold text-ink'
                  : 'border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="checkbox"
                name={name}
                value={option.value}
                checked={checked}
                disabled={disabled}
                className="sr-only"
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value, option.value]
                      : value.filter((v) => v !== option.value),
                  )
                }
              />
              {checked ? <Check className="size-3.5 text-ink" aria-hidden="true" /> : null}
              {option.label}
            </label>
          );
        })}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
