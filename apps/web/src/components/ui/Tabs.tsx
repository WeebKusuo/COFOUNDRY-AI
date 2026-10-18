import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional count shown after the label, e.g. pending invitations. */
  count?: number;
  content: ReactNode;
}

/**
 * WAI-ARIA tabs with automatic activation: Arrow keys move between tabs, Home/End jump to the
 * ends. Used by the candidate inbox (invitations vs. requests) in later phases.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    const item = items[next];
    if (!item) return;
    onChange(item.id);
    refs.current[next]?.focus();
  };

  const active = items.find((i) => i.id === value) ?? items[0];

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line">
        {items.map((item, index) => {
          const selected = item.id === active?.id;
          return (
            <button
              key={item.id}
              ref={(el) => {
                refs.current[index] = el;
              }}
              id={`${base}-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${base}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                'label-mono -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-3',
                selected
                  ? 'border-ink text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className="tabular rounded-sm border border-line px-1.5 text-ink-muted">
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {active ? (
        // WAI-ARIA tabs pattern: the panel is focusable so keyboard users can reach its content.
        <div
          role="tabpanel"
          id={`${base}-panel-${active.id}`}
          aria-labelledby={`${base}-tab-${active.id}`}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          className="pt-5"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}
