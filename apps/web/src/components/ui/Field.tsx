import { useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';

/**
 * Labelled form controls. Every control has a visible label; hints and errors are linked with
 * aria-describedby, and errors set aria-invalid so screen readers announce them (Section 02).
 */

const control =
  'w-full rounded-sm border bg-surface px-3 text-base text-ink placeholder:text-ink-faint ' +
  'transition-colors hover:border-ink-muted focus-visible:border-ink ' +
  'disabled:bg-surface-sunk disabled:text-ink-faint';

/** Border colour by state — set exclusively so classes never compete. */
const borderFor = (error: unknown) => (error ? 'border-danger' : 'border-line-strong');

interface FieldShellProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | string[] | undefined;
  required?: boolean;
  counter?: ReactNode;
  children: ReactNode;
}

function errorText(error: FieldShellProps['error']): string | null {
  if (!error) return null;
  return Array.isArray(error) ? error.join(' ') : error;
}

function FieldShell({ id, label, hint, error, required, counter, children }: FieldShellProps) {
  const err = errorText(error);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label-mono text-ink-muted">
          {label}
          {required ? <span className="ml-1 text-ink-faint">(required)</span> : null}
        </label>
        {counter ? (
          <span className="tabular font-mono text-[0.6875rem] text-ink-faint">{counter}</span>
        ) : null}
      </div>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      {err ? (
        <p id={`${id}-error`} className="text-sm font-medium text-danger">
          {err}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [hint ? `${id}-hint` : null, errorText(error as never) ? `${id}-error` : null];
  const joined = ids.filter(Boolean).join(' ');
  return joined || undefined;
}

interface CommonFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | string[] | undefined;
  counter?: ReactNode;
}

export function TextField({
  label,
  hint,
  error,
  counter,
  id: idProp,
  className,
  required,
  ...rest
}: CommonFieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      counter={counter}
    >
      <input
        id={id}
        className={cn(control, 'h-11', borderFor(error), className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        required={required}
        {...rest}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  counter,
  id: idProp,
  className,
  required,
  ...rest
}: CommonFieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      counter={counter}
    >
      <textarea
        id={id}
        className={cn(control, 'min-h-28 py-2.5 leading-relaxed', borderFor(error), className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        required={required}
        {...rest}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  id: idProp,
  className,
  required,
  children,
  ...rest
}: CommonFieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        className={cn(control, 'h-11', borderFor(error), className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        required={required}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
}

/** Checkbox with label text to its right — used for consent and acknowledgement rows. */
export function CheckboxField({
  label,
  hint,
  error,
  id: idProp,
  ...rest
}: CommonFieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const generated = useId();
  const id = idProp ?? generated;
  const err = errorText(error);
  return (
    <div className="flex gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-brand"
        aria-invalid={err ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
      <div>
        <label htmlFor={id} className="text-ink">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-sm text-ink-muted">
            {hint}
          </p>
        ) : null}
        {err ? (
          <p id={`${id}-error`} className="text-sm font-medium text-danger">
            {err}
          </p>
        ) : null}
      </div>
    </div>
  );
}
