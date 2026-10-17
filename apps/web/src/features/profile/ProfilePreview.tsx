import {
  INDUSTRY_LABELS,
  MISSION_LABELS,
  SKILL_LABELS,
  SKILL_LEVEL_LABELS,
  type ProfilePublic,
} from '@cofoundry/shared';
import { Badge, ExternalLink } from '../../components/ui';

/**
 * ProfilePublic as other signed-in users see it. Everything is labelled self-reported; seeded
 * identities are labelled "demo account", never "verified".
 */
export function ProfilePreview({ profile }: { profile: ProfilePublic }) {
  const c = profile.candidate;
  return (
    <article
      aria-label={`Public profile of ${profile.displayName}`}
      className="flex flex-col gap-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-bold text-ink">{profile.displayName}</h3>
          {c?.headline ? <p className="text-ink-muted">{c.headline}</p> : null}
        </div>
        {profile.demoAccount ? <Badge tone="caution">Demo account</Badge> : null}
      </header>

      {c ? (
        <>
          {c.bio ? <p className="max-w-prose text-ink">{c.bio}</p> : null}
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-semibold text-ink">Availability</dt>
              <dd className="text-ink-muted">
                {c.availableHoursPerWeek ?? '—'} h/week for {c.commitmentMonths ?? '—'} months
              </dd>
            </div>
            <div>
              <dt className="text-sm font-semibold text-ink">Interests</dt>
              <dd className="text-ink-muted">
                {[
                  ...c.industryTags.map((t) => INDUSTRY_LABELS[t]),
                  ...c.missionTags.map((t) => MISSION_LABELS[t]),
                ].join(', ') || '—'}
              </dd>
            </div>
          </dl>
          <section aria-label="Skills">
            <h4 className="text-sm font-semibold text-ink">Skills (self-assessed)</h4>
            <ul className="mt-2 flex flex-wrap gap-2">
              {c.skills.map((s) => (
                <li
                  key={s.skillId}
                  className="rounded-md border border-line bg-surface-sunk px-2 py-1 text-sm text-ink"
                >
                  {SKILL_LABELS[s.skillId]}{' '}
                  <span className="text-ink-muted">
                    {s.level}/5 {SKILL_LEVEL_LABELS[s.level]}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Projects">
            <h4 className="text-sm font-semibold text-ink">Projects</h4>
            {c.projects.length === 0 ? (
              <p className="mt-1 text-sm text-ink-muted">No project evidence supplied.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-3">
                {c.projects.map((p) => (
                  <li key={p.id} className="rounded-lg border border-line p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{p.title}</span>
                      <Badge tone={p.evidenceStatus === 'project_linked' ? 'info' : 'neutral'}>
                        {p.evidenceStatus === 'project_linked'
                          ? 'Link added, not verified'
                          : 'Self-reported'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm whitespace-pre-line text-ink-muted">
                      {p.description}
                    </p>
                    <p className="mt-2 text-xs text-ink-faint">
                      Tags: {p.skillTags.map((t) => SKILL_LABELS[t]).join(', ')}
                    </p>
                    {p.url ? (
                      <div className="mt-2">
                        <ExternalLink url={p.url} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      {profile.founder ? (
        <section aria-label="Founder details" className="flex flex-col gap-2">
          {profile.founder.bio ? <p className="text-ink">{profile.founder.bio}</p> : null}
          {profile.founder.companyUrl ? <ExternalLink url={profile.founder.companyUrl} /> : null}
        </section>
      ) : null}
    </article>
  );
}
