import { SearchX } from 'lucide-react';
import { ButtonLink, EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        icon={<SearchX className="size-5" aria-hidden="true" />}
        title="This page doesn’t exist"
        action={
          <ButtonLink to="/" variant="secondary">
            Go to the home page
          </ButtonLink>
        }
      >
        Check the address, or start again from the home page.
      </EmptyState>
    </div>
  );
}
