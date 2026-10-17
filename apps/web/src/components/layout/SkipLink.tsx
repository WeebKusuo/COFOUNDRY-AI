export function SkipLink({ target = 'main' }: { target?: string }) {
  return (
    <a
      href={`#${target}`}
      className="sr-only rounded-md bg-surface px-4 py-2 font-semibold text-ink shadow-raised focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
    >
      Skip to content
    </a>
  );
}
