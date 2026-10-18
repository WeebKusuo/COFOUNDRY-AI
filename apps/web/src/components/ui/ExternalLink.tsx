import { useState } from 'react';
import { ExternalLink as ExternalIcon } from 'lucide-react';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Section 23: user-supplied links open only after a visible external-site notice, with
 * rel="noopener noreferrer". The link is labelled self-reported: CoFoundry never fetches or
 * verifies it.
 */
export function ExternalLink({
  url,
  label = 'Self-reported link',
}: {
  url: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const host = hostOf(url);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
        aria-expanded={false}
      >
        <ExternalIcon className="size-3.5" aria-hidden="true" />
        {label}: {host}
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label="External link notice"
      className="rounded-sm border border-line bg-surface-sunk p-3 text-sm"
    >
      <p className="text-ink">
        You’re leaving CoFoundry to visit <strong className="font-semibold">{host}</strong>. This is
        a self-reported link that CoFoundry has not checked. Access may require permission.
      </p>
      <div className="mt-2 flex gap-4">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-ink underline underline-offset-4"
        >
          Open {host}
        </a>
        <button
          type="button"
          className="text-ink-muted hover:text-ink"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
