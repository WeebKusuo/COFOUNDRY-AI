import { useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Lock } from 'lucide-react';
import {
  INDUSTRY_LABELS,
  MISSION_LABELS,
  SKILL_LABELS,
  SKILL_LEVEL_LABELS,
  formatMatchScore,
  type MatchComponents,
  type MatchWeights,
  type RecommendationEntryView,
} from '@cofoundry/shared';
import { Badge, Button, ExternalLink } from '../../components/ui';
import { cn } from '../../lib/cn';

const FACTORS = [
  { key: 'S', label: 'Skill coverage', hint: 'Weighted coverage of your team’s skill gap' },
  {
    key: 'A',
    label: 'Availability',
    hint: 'Hours and months against your brief; no bonus for extra time',
  },
  { key: 'I', label: 'Interests', hint: 'Overlap with your industries and missions' },
  {
    key: 'P',
    label: 'Project relevance',
    hint: 'Best project’s tags against the skill gap (self-reported)',
  },
] as const;

const pct = (w: number) => `${Math.round(w * 1000) / 10}%`;

/** Factor bars: value text is always present; the bar is decorative (never colour alone). */
export function ScoreBreakdown({
  components,
  weights,
}: {
  components: MatchComponents;
  weights: MatchWeights;
}) {
  return (
    <dl className="flex flex-col gap-3">
      {FACTORS.map((f) => {
        const value = components[f.key];
        const weight = weights[f.key];
        return (
          <div key={f.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="font-medium text-ink" title={f.hint}>
                {f.label}
                <span className="ml-1.5 text-xs font-normal text-ink-muted">
                  {weight === null ? 'not counted' : `weight ${pct(weight)}`}
                </span>
              </dt>
              <dd className="tabular-nums text-ink">
                {value === null ? 'No projects' : formatMatchScore(value)}
              </dd>
            </div>
            <div
              className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunk"
              aria-hidden="true"
            >
              <div
                className={cn(
                  'h-full rounded-full',
                  value === null ? 'bg-transparent' : 'bg-brand',
                )}
                style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
              />
            </div>
          </div>
        );
      })}
    </dl>
  );
}

export function CandidateCard({
  entry,
  rank,
  usable,
}: {
  entry: RecommendationEntryView;
  rank: number;
  /** False once the batch expired: invitations need a fresh search. */
  usable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const p = entry.profile;
  const gaps = entry.skills.filter((s) => s.gap > 0 && s.fit < 1);

  return (
    <li className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
      <article aria-label={`${p.displayName}, score ${formatMatchScore(entry.score)}`}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
              <span
                className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-bold text-brand-strong dark:text-brand"
                aria-label={`Rank ${rank}`}
              >
                {rank}
              </span>
              <div className="min-w-[12rem] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-bold text-ink">{p.displayName}</h3>
                  {p.demoAccount ? <Badge tone="caution">Demo account</Badge> : null}
                  {entry.provisional ? <Badge tone="info">Provisional · no projects</Badge> : null}
                </div>
                {p.headline ? <p className="mt-0.5 text-ink-muted">{p.headline}</p> : null}
              </div>
              <div className="flex items-baseline gap-1.5 max-sm:w-full max-sm:pl-13 sm:block sm:shrink-0 sm:text-right">
                <p className="text-3xl leading-none font-bold tabular-nums text-ink">
                  {formatMatchScore(entry.score)}
                </p>
                <p className="text-xs text-ink-muted sm:mt-1">of 100</p>
              </div>
            </header>

            <p className="text-sm text-ink-muted">
              {p.availableHoursPerWeek ?? '—'} h/week · {p.commitmentMonths ?? '—'} months ·{' '}
              {p.skills.map((s) => `${SKILL_LABELS[s.skillId]} ${s.level}`).join(', ')}
            </p>

            <section aria-label="Why this candidate">
              <ul className="flex flex-col gap-2 text-sm">
                {entry.reasons.map((reason, i) => {
                  // Deficit sentences always follow the positive contributions (Section 05).
                  const deficit = i >= entry.reasons.length - entry.nearMatchDeficits.length;
                  return (
                    <li key={reason} className="flex gap-2">
                      {deficit ? (
                        <AlertTriangle
                          className="mt-0.5 size-4 shrink-0 text-caution"
                          aria-hidden="true"
                        />
                      ) : (
                        <CheckCircle2
                          className="mt-0.5 size-4 shrink-0 text-brand"
                          aria-hidden="true"
                        />
                      )}
                      <span className="text-ink">
                        <span className="sr-only">{deficit ? 'Shortfall: ' : 'Strength: '}</span>
                        {reason}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            {gaps.length > 0 ? (
              <p className="text-sm text-ink-muted">
                <span className="font-semibold text-ink">Remaining skill gaps: </span>
                {gaps
                  .map(
                    (s) =>
                      `${SKILL_LABELS[s.skillId]} (has ${s.candidateLevel}, needs ${s.requiredLevel})`,
                  )
                  .join('; ')}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-4 rounded-xl bg-canvas p-4">
            <ScoreBreakdown components={entry.components} weights={entry.weights} />
            {entry.provisional ? (
              <p className="text-xs text-ink-muted">
                No project evidence supplied, so the score is computed from 80% of the factors and
                shown separately from complete profiles.
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={open}
            aria-controls={detailId}
            icon={
              open ? (
                <ChevronUp className="size-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-4" aria-hidden="true" />
              )
            }
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide details' : 'View details'}
          </Button>
          <Button
            size="sm"
            disabled
            icon={<Lock className="size-4" aria-hidden="true" />}
            aria-describedby={`${detailId}-invite`}
          >
            Invite to interview
          </Button>
          <span id={`${detailId}-invite`} className="text-xs text-ink-muted">
            {usable
              ? 'Not available yet: interview invitations arrive in a later phase.'
              : 'These results expired. Run a new search before inviting anyone.'}
          </span>
        </div>

        {open ? <CandidateDetail id={detailId} entry={entry} /> : null}
      </article>
    </li>
  );
}

function CandidateDetail({ id, entry }: { id: string; entry: RecommendationEntryView }) {
  const p = entry.profile;
  const relevance = new Map(entry.projects.map((r) => [r.projectId, r]));
  return (
    <div id={id} className="mt-5 flex flex-col gap-6">
      {p.bio ? <p className="max-w-prose whitespace-pre-line text-ink">{p.bio}</p> : null}

      <section aria-label="Skill match">
        <h4 className="text-sm font-semibold text-ink">Skill match</h4>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="text-ink-muted">
              <tr className="border-b border-line">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Skill
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Needed
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Your team
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Candidate
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Fit
                </th>
                <th scope="col" className="py-2 font-medium">
                  Share of gap
                </th>
              </tr>
            </thead>
            <tbody>
              {entry.skills.map((s) => (
                <tr key={s.skillId} className="border-b border-line last:border-0">
                  <th scope="row" className="py-2 pr-3 font-medium text-ink">
                    {SKILL_LABELS[s.skillId]}
                    {s.mandatory ? (
                      <span className="ml-1.5 text-xs text-ink-muted">(mandatory)</span>
                    ) : null}
                  </th>
                  <td className="py-2 pr-3 tabular-nums">{s.requiredLevel}</td>
                  <td className="py-2 pr-3 tabular-nums">{s.teamLevel}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {s.candidateLevel}{' '}
                    {s.candidateLevel > 0
                      ? `(${SKILL_LEVEL_LABELS[s.candidateLevel]})`
                      : '(not listed)'}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{Math.round(s.fit * 100)}%</td>
                  <td className="py-2 tabular-nums">
                    {s.gap === 0 ? 'No gap' : pct(s.weightShare)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Projects">
        <h4 className="text-sm font-semibold text-ink">Projects (self-reported)</h4>
        {p.projects.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No project evidence supplied.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {p.projects.map((project) => {
              const r = relevance.get(project.id);
              return (
                <li key={project.id} className="rounded-xl border border-line p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h5 className="font-semibold text-ink">{project.title}</h5>
                    {entry.bestProjectId === project.id ? (
                      <Badge tone="brand">Best match</Badge>
                    ) : null}
                    <span className="ml-auto text-sm tabular-nums text-ink-muted">
                      Relevance {r ? formatMatchScore(r.score) : '0.00'}
                    </span>
                  </div>
                  <p className="mt-2 text-sm whitespace-pre-line text-ink">{project.description}</p>
                  <p className="mt-2 text-xs text-ink-muted">
                    Tags: {project.skillTags.map((t) => SKILL_LABELS[t]).join(', ')}
                    {r && r.matchedGapSkills.length > 0
                      ? ` · covers ${r.matchedGapSkills.map((t) => SKILL_LABELS[t]).join(', ')}`
                      : ' · no gap skills tagged'}
                  </p>
                  {project.url ? (
                    <div className="mt-2">
                      <ExternalLink url={project.url} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="text-sm text-ink-muted">
        <span className="font-semibold text-ink">Interests: </span>
        {[
          ...p.industryTags.map((t) => INDUSTRY_LABELS[t]),
          ...p.missionTags.map((t) => MISSION_LABELS[t]),
        ].join(', ') || '—'}
      </p>
    </div>
  );
}
