import { Lock } from 'lucide-react';
import {
  EXTERNAL_PAYMENT_NOTICE,
  IP_POLICY_NOTICE,
  NO_MONETARY_PAYMENT_NOTICE,
  SKILL_LABELS,
  SKILL_LEVEL_LABELS,
  formatInr,
  type BriefPreview,
} from '@cofoundry/shared';
import { Badge, ExternalLink } from '../../components/ui';

/**
 * Section 06 teaser projection, exactly as a candidate sees it before acknowledging
 * confidentiality. Problem and solution are never part of this data.
 */
export function BriefPreviewCard({ preview }: { preview: BriefPreview }) {
  const c = preview.compensation;
  return (
    <article aria-label={`Brief preview: ${preview.title}`} className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Badge tone="brand">Backend contributor</Badge>
          <Badge>Remote</Badge>
          {preview.founder.demoAccount ? <Badge tone="caution">Demo account</Badge> : null}
        </div>
        <h3 className="text-xl font-bold text-balance text-ink">{preview.title}</h3>
        <p className="max-w-prose text-ink">{preview.teaser || '—'}</p>
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Lock className="size-4 shrink-0" aria-hidden="true" />
          The full problem and solution stay confidential until a candidate acknowledges the
          confidentiality notice.
        </p>
      </header>

      <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <div>
          <dt className="text-sm font-semibold text-ink">Time</dt>
          <dd className="text-ink-muted">
            {preview.hoursRequiredPerWeek ?? '—'} h/week for {preview.commitmentMonths ?? '—'}{' '}
            months
          </dd>
        </div>
        <div>
          <dt className="text-sm font-semibold text-ink">Trial cap</dt>
          <dd className="text-ink-muted">
            At most {preview.trialCapHours} hours in total for the trial sprint
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-sm font-semibold text-ink">Compensation</dt>
          <dd className="text-ink-muted">
            {!c ? (
              'Terms not complete yet'
            ) : c.type === 'paid' ? (
              <>
                Paid {formatInr(c.amountMinor)} (INR), due within {c.paymentDueDays} days of
                submission. {c.methodNote}
              </>
            ) : c.type === 'credit_reference' ? (
              <>
                <strong className="font-semibold text-ink">{NO_MONETARY_PAYMENT_NOTICE}.</strong>{' '}
                Credit or reference: {c.benefitDescription}
              </>
            ) : (
              <strong className="font-semibold text-ink">
                Unpaid. {NO_MONETARY_PAYMENT_NOTICE}.
              </strong>
            )}
            <span className="mt-1 block text-sm">{EXTERNAL_PAYMENT_NOTICE}</span>
          </dd>
        </div>
      </dl>

      <section aria-label="Skills needed">
        <h4 className="text-sm font-semibold text-ink">Skills needed</h4>
        {preview.requiredSkills.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No skills listed yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {preview.requiredSkills.map((s) => (
              <li
                key={s.skillId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-sm"
              >
                <span className="font-medium text-ink">{SKILL_LABELS[s.skillId]}</span>
                <span className="text-ink-muted">
                  level {s.level} ({SKILL_LEVEL_LABELS[s.level]}) · importance {s.importance}/5
                </span>
                <Badge tone={s.mandatory ? 'danger' : 'neutral'} className="ml-auto">
                  {s.mandatory ? 'Required' : 'Preferred'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Intellectual property">
        <h4 className="text-sm font-semibold text-ink">Intellectual property</h4>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">{IP_POLICY_NOTICE}</p>
      </section>

      <footer className="flex flex-col gap-2 border-t border-line pt-4 text-sm">
        <p className="text-ink">
          <span className="font-semibold">{preview.founder.displayName}</span>
          <span className="text-ink-muted">
            {' '}
            · {preview.founder.completedSprintCount} completed trials
          </span>
        </p>
        {preview.founder.companyUrl ? <ExternalLink url={preview.founder.companyUrl} /> : null}
      </footer>
    </article>
  );
}
