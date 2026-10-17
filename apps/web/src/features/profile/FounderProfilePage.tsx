import { useState } from 'react';
import type { FormEvent } from 'react';
import { PROFILE_LIMITS as L, checkHttpsUrl, type FounderProfileData } from '@cofoundry/shared';
import { ApiError } from '../../lib/api/client';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ErrorState,
  ExternalLink,
  LoadingState,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { useFounderProfile, useSaveFounderProfile } from './api';

export function FounderProfilePage() {
  const [generation, setGeneration] = useState(0);
  const query = useFounderProfile();
  if (query.isPending) return <LoadingState label="Loading your profile" />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  // Re-key only on an explicit reload, so a successful save keeps its confirmation on screen.
  const reload = async () => {
    await query.refetch();
    setGeneration((g) => g + 1);
  };
  return (
    <FounderProfileEditor key={generation} profile={query.data} onReload={() => void reload()} />
  );
}

const count = (s: string) => Array.from(s).length;

/**
 * Founder profile (Section 14): bio and an optional company link. Terms completeness and the
 * completed-trials count are computed from briefs and sprints, never typed in.
 */
function FounderProfileEditor({
  profile,
  onReload,
}: {
  profile: FounderProfileData;
  onReload: () => void;
}) {
  const save = useSaveFounderProfile();
  const [bio, setBio] = useState(profile.bio);
  const [companyUrl, setCompanyUrl] = useState(profile.companyUrl ?? '');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState<'idle' | 'saved' | 'conflict' | 'failed'>('idle');
  const [failure, setFailure] = useState('');

  const dirty = bio !== profile.bio || companyUrl.trim() !== (profile.companyUrl ?? '');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const local: Record<string, string[]> = {};
    if (count(bio.trim()) > L.bioMax)
      local['body.bio'] = [`Bio can be at most ${L.bioMax} characters.`];
    const url = companyUrl.trim();
    if (url && !checkHttpsUrl(url).ok)
      local['body.companyUrl'] = ['Enter a public link starting with https://.'];
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    try {
      await save.mutateAsync({ expectedRevision: profile.revision, bio, companyUrl: url || null });
      setStatus('saved');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED')
        setErrors(err.fieldErrors ?? {});
      else if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setStatus('conflict');
      else {
        setFailure(err instanceof ApiError ? err.message : 'Saving failed. Try again.');
        setStatus('failed');
      }
    }
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Founder profile</h1>
        <p className="mt-2 text-ink-muted">
          Candidates see this next to your briefs. Links are labelled self-reported; CoFoundry does
          not verify founders.
        </p>
      </div>

      {status === 'saved' ? <Alert tone="success" title="Profile saved" live /> : null}
      {status === 'failed' ? <Alert tone="danger" title={failure} live /> : null}
      {status === 'conflict' ? (
        <Alert
          tone="caution"
          title="Your profile changed somewhere else"
          live
          action={
            <Button variant="secondary" size="sm" onClick={onReload}>
              Load the latest version
            </Button>
          }
        />
      ) : null}

      <Card as="section" aria-label="About you">
        <CardHeader title="About you" description="Who you are and what you are building." />
        <div className="flex flex-col gap-5">
          <TextAreaField
            label="Bio"
            value={bio}
            counter={`${count(bio)}/${L.bioMax}`}
            error={errors['body.bio']}
            onChange={(e) => {
              setBio(e.target.value);
              setStatus('idle');
            }}
          />
          <TextField
            label="Company link (optional)"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={companyUrl}
            hint="Shown as a self-reported link."
            error={errors['body.companyUrl']}
            onChange={(e) => {
              setCompanyUrl(e.target.value);
              setStatus('idle');
            }}
          />
          {profile.companyUrl ? (
            <div className="text-sm">
              <span className="text-ink-muted">Saved link: </span>
              <ExternalLink url={profile.companyUrl} />
            </div>
          ) : null}
        </div>
      </Card>

      <Card as="section" aria-label="Shown to candidates">
        <CardHeader
          title="Shown to candidates"
          description="Calculated by CoFoundry from your briefs and trials. You can’t edit these."
        />
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-semibold text-ink">Brief terms completeness</dt>
            <dd className="text-ink-muted">Shown once you publish a brief.</dd>
          </div>
          <div>
            <dt className="text-sm font-semibold text-ink">Completed trials</dt>
            <dd className="text-ink-muted">Counted once trial sprints are available.</dd>
          </div>
        </dl>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending} disabled={!dirty && profile.revision > 0}>
          Save profile
        </Button>
        <span role="status" className="text-sm text-ink-muted">
          {dirty
            ? 'Unsaved changes'
            : profile.revision === 0
              ? 'Not saved yet'
              : `Saved, revision ${profile.revision}`}
        </span>
      </div>
    </form>
  );
}
