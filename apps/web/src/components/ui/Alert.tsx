import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '../../lib/cn';

export type AlertTone = 'info' | 'success' | 'caution' | 'danger';

// Flat panel with a coloured left rule; the icon and title carry the tone, not a filled box.
const styles: Record<AlertTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: 'border-l-info', icon: 'text-info', Icon: Info },
  success: { box: 'border-l-success', icon: 'text-success', Icon: CheckCircle2 },
  caution: { box: 'border-l-caution', icon: 'text-caution', Icon: AlertTriangle },
  danger: { box: 'border-l-danger', icon: 'text-danger', Icon: XCircle },
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
  const { box, icon, Icon } = styles[tone];
  return (
    <div
      className={cn(
        'flex gap-3 rounded-sm border border-l-2 border-line bg-surface p-4 text-ink',
        box,
        className,
      )}
      {...(live ? { role: 'alert' } : {})}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-1 text-sm text-ink-muted">{children}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}
