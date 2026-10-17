import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '../../lib/cn';

export type AlertTone = 'info' | 'success' | 'caution' | 'danger';

const styles: Record<AlertTone, { box: string; Icon: typeof Info }> = {
  info: { box: 'border-info/30 bg-info-soft text-ink', Icon: Info },
  success: { box: 'border-success/30 bg-success-soft text-ink', Icon: CheckCircle2 },
  caution: { box: 'border-caution/30 bg-caution-soft text-ink', Icon: AlertTriangle },
  danger: { box: 'border-danger/30 bg-danger-soft text-ink', Icon: XCircle },
};

/**
 * Inline message. Use role="alert" (live) only for errors that appear after a user action;
 * static notices stay as plain regions so screen readers are not interrupted.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  live = false,
  action,
  className,
}: {
  tone?: AlertTone;
  title: ReactNode;
  children?: ReactNode;
  live?: boolean;
  action?: ReactNode;
  className?: string;
}) {
  const { box, Icon } = styles[tone];
  return (
    <div
      className={cn('flex gap-3 rounded-lg border p-4', box, className)}
      {...(live ? { role: 'alert' } : {})}
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-1 text-sm text-ink-muted">{children}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}
