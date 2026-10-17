import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { FileText, Plus } from 'lucide-react';
import { BRIEF_LIMITS as L, type BriefOwnerSummary, type BriefStatus } from '@cofoundry/shared';
import { ApiError } from '../../lib/api/client';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Tabs,
  TextField,
} from '../../components/ui';
import { useCreateBrief, useMyBriefs } from './api';
import { BriefStatusBadge, formatDate } from './status';

type Filter = 'all' | BriefStatus;

export function BriefsListPage() {
  const briefs = useMyBriefs();
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);

  const all = briefs.data?.pages.flatMap((p) => p.data) ?? [];
  const count = (s: BriefStatus) => all.filter((b) => b.status === s).length;
  const visible = filter === 'all' ? all : all.filter((b) => b.status === filter);

  const list = (
    <>
      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong p-6 text-center text-sm text-ink-muted">
          {filter === 'all' ? 'No briefs yet.' : `No ${filter} briefs.`}
        </p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {visible.map((b) => (
            <BriefCard key={b.id} brief={b} />
          ))}
        </ul>
      )}
      {briefs.hasNextPage ? (
        <div className="mt-4">
          <Button
            variant="secondary"
            loading={briefs.isFetchingNextPage}
            onClick={() => void briefs.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-bold text-ink sm:text-3xl">Briefs</h1>
          <p className="mt-2 text-ink-muted">
            Write a draft, publish it with fixed terms, and close it when you stop looking.
            Published terms can’t be edited — clone a brief to change them.
          </p>
        </div>
        {!creating ? (
          <Button
            icon={<Plus className="size-4" aria-hidden="true" />}
            onClick={() => setCreating(true)}
          >
            New brief
          </Button>
        ) : null}
      </div>

      {creating ? <NewBriefForm onCancel={() => setCreating(false)} /> : null}

      {briefs.isPending ? (
        <LoadingState label="Loading your briefs" />
      ) : briefs.isError ? (
        <ErrorState
          error={briefs.error}
          onRetry={() => void briefs.refetch()}
          retrying={briefs.isFetching}
        />
      ) : all.length === 0 && !creating ? (
        <EmptyState
          icon={<FileText className="size-5" aria-hidden="true" />}
          title="No briefs yet"
          action={
            <Button
              icon={<Plus className="size-4" aria-hidden="true" />}
              onClick={() => setCreating(true)}
            >
              Create your first brief
            </Button>
          }
        >
          A brief describes the backend contributor you need, your team’s current skills and the
          terms of a bounded trial.
        </EmptyState>
      ) : (
        <Tabs
          label="Filter briefs by status"
          value={filter}
          onChange={(id) => setFilter(id as Filter)}
          items={[
            { id: 'all', label: 'All', count: all.length, content: list },
            { id: 'draft', label: 'Drafts', count: count('draft'), content: list },
            { id: 'open', label: 'Open', count: count('open'), content: list },
            { id: 'closed', label: 'Closed', count: count('closed'), content: list },
          ]}
        />
      )}
    </div>
  );
}

function BriefCard({ brief }: { brief: BriefOwnerSummary }) {
  return (
    <Card as="li" className="relative flex flex-col gap-3 shadow-none">
      <div className="flex flex-wrap items-center gap-2">
        <BriefStatusBadge status={brief.status} version={brief.version} />
        {brief.clonedFromId ? <Badge>Cloned</Badge> : null}
      </div>
      <h2 className="font-semibold text-ink">
        <Link
          to={`/founder/briefs/${brief.id}`}
          className="rounded after:absolute after:inset-0 hover:underline"
        >
          {brief.title}
        </Link>
      </h2>
      <p className="line-clamp-2 text-sm text-ink-muted">{brief.teaser || 'No teaser yet.'}</p>
      <p className="mt-auto text-xs text-ink-muted">
        {brief.status === 'draft'
          ? `Edited ${formatDate(brief.updatedAt)}`
          : brief.status === 'open'
            ? `Published ${formatDate(brief.publishedAt)}`
            : `Closed ${formatDate(brief.closedAt)}`}
      </p>
    </Card>
  );
}

function NewBriefForm({ onCancel }: { onCancel: () => void }) {
  const create = useCreateBrief();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return setError('Title is required.');
    if (Array.from(trimmed).length > L.titleMax) {
      return setError(`Use at most ${L.titleMax} characters.`);
    }
    setError(null);
    try {
      const brief = await create.mutateAsync({ title: trimmed });
      void navigate(`/founder/briefs/${brief.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.fieldErrors?.['body.title']?.[0] ?? err.message)
          : 'Creating the brief failed. Try again.',
      );
    }
  };

  return (
    <Card as="section" aria-label="New brief">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Brief title"
          required
          value={title}
          counter={`${Array.from(title).length}/${L.titleMax}`}
          hint="You can change everything else in the draft before publishing."
          error={error ?? undefined}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Payment reconciliation API"
        />
        {create.isError && !(create.error instanceof ApiError) ? (
          <Alert tone="danger" title="Creating the brief failed. Try again." live />
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={create.isPending}>
            Create draft
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
