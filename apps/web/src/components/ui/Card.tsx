import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Card({
  className,
  as: Tag = 'div',
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li' }) {
  return (
    <Tag
      className={cn('rounded-sm border border-line bg-surface p-5 sm:p-6', className)}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  headingLevel = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Heading className="text-base font-semibold tracking-[-0.01em] text-ink">{title}</Heading>
        {description ? (
          <p className="mt-1 max-w-[70ch] text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
