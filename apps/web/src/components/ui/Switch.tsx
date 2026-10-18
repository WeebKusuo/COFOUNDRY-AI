import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Accessible on/off switch (role="switch"). The state is spelled out in text, not colour. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <span id={`${id}-label`} className="font-medium text-ink">
          {label}
        </span>
        {description ? (
          <p id={`${id}-desc`} className="text-sm text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'label-mono inline-flex h-8 shrink-0 items-center gap-2 rounded-sm border transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-55',
          checked
            ? 'flex-row-reverse border-brand bg-brand pr-1 pl-3 text-on-brand'
            : 'border-line-strong bg-surface-sunk pr-3 pl-1 text-ink-muted',
        )}
      >
        <span aria-hidden="true" className="size-6 rounded-sm border border-line bg-surface" />
        {checked ? 'On' : 'Off'}
      </button>
    </div>
  );
}
