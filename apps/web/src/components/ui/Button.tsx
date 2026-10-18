import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

// Square, flat controls with monospace uppercase labels (the label text itself is unchanged).
const base =
  'inline-flex items-center justify-center gap-2 rounded-sm border font-mono font-medium ' +
  'uppercase tracking-[0.08em] whitespace-nowrap transition-colors select-none ' +
  'disabled:cursor-not-allowed disabled:opacity-45';

const variants: Record<ButtonVariant, string> = {
  primary: 'border-brand bg-brand text-on-brand hover:border-brand-strong hover:bg-brand-strong',
  secondary: 'border-line-strong bg-surface text-ink hover:border-ink hover:bg-surface-sunk',
  ghost: 'border-transparent text-ink hover:bg-surface-sunk',
  danger: 'border-danger bg-surface text-danger hover:bg-danger hover:text-on-brand',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-[0.6875rem]',
  md: 'h-11 px-4 text-xs',
  lg: 'h-12 px-6 text-xs',
};

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and announces busy state. */
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading = false, icon, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size="sm" label={null} /> : icon}
      {children}
    </button>
  );
});

export interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** A navigation link styled as a button — use for navigation, never for actions. */
export function ButtonLink({ variant, size, className, ...rest }: ButtonLinkProps) {
  return <Link className={buttonClasses(variant, size, className)} {...rest} />;
}
