import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { cn } from '../../lib/cn';

const OPTIONS: Array<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light theme', Icon: Sun },
  { value: 'dark', label: 'Dark theme', Icon: Moon },
  { value: 'system', label: 'Match system theme', Icon: Monitor },
];

/** Three-way theme choice as a radio group, so the current state is announced, not implied. */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn('inline-flex rounded-lg border border-line bg-surface p-0.5', className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const checked = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            onClick={() => setPreference(value)}
            className={cn(
              'inline-flex size-8 items-center justify-center rounded-md transition-colors',
              checked ? 'bg-surface-sunk text-ink' : 'text-ink-faint hover:text-ink',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
