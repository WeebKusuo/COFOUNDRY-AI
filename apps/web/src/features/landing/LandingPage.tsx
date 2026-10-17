import { Check, X } from 'lucide-react';
import { buttonClasses } from '../../components/ui';
import { SessionCta } from '../../components/layout/SessionCta';
import { FitLedger } from './FitLedger';

const JOURNEY = [
  {
    title: 'Publish a brief',
    who: 'Founder',
    body: 'Name the skills your team lacks, weekly hours, pay and IP terms. Published terms can’t be edited later.',
  },
  {
    title: 'Discover candidates',
    who: 'Founder',
    body: 'Scores come from skills, availability, interests and tagged projects. Profiles without project evidence are listed separately as provisional.',
  },
  {
    title: 'Interview',
    who: 'Candidate',
    body: 'Four fixed backend questions, fifteen minutes at most. You see the time limits and the terms before you agree to start.',
  },
  {
    title: 'Request to collaborate',
    who: 'Both',
    body: 'Both sides read the same report and the original answers. The founder sends one request; the candidate accepts or declines.',
  },
  {
    title: 'Run a trial sprint',
    who: 'Both',
    body: 'Up to 10 hours of agreed scope, a deadline within 14 days, and both approve the same version of the terms.',
  },
];

const SCORE_IS = [
  'A weighted sum of four factors you can inspect',
  'A way to decide who to look at first',
  'Versioned, so the same inputs give the same result',
];

const SCORE_IS_NOT = [
  'A probability that the collaboration will work',
  'Proof of unaided skill or verified project work',
  'A hiring recommendation from an AI',
];

export function LandingPage() {
  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-20 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pt-20">
        <div>
          <h1 className="max-w-[14ch] text-4xl leading-[1.04] font-bold text-ink">
            Find the people your startup is missing.
          </h1>
          <p className="mt-5 text-xl font-medium text-ink">Test the fit. Build together.</p>
          <p className="mt-4 max-w-[52ch] text-ink-muted">
            CoFoundry AI connects founders with backend contributors. You see how every match score
            is built, read the same interview report the candidate sees, and agree a capped trial
            sprint before anyone commits further.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <SessionCta size="lg" />
            <a href="#journey" className={buttonClasses('secondary', 'lg')}>
              See how it works
            </a>
          </div>
        </div>
        <FitLedger />
      </section>

      <section
        id="journey"
        aria-labelledby="journey-title"
        className="scroll-mt-6 border-y border-line bg-surface"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 id="journey-title" className="text-2xl font-bold text-ink">
            From brief to trial sprint
          </h2>
          <p className="mt-2 max-w-[60ch] text-ink-muted">
            One path, in this order. Each step needs the other person’s consent before the next one
            opens.
          </p>
          <ol className="mt-10 grid gap-8 md:grid-cols-5 md:gap-5">
            {JOURNEY.map((step, i) => (
              <li key={step.title} className="relative md:pt-8">
                <span
                  aria-hidden="true"
                  className="absolute top-3 right-0 left-9 hidden h-px bg-line-strong md:block"
                />
                <div className="flex items-center gap-3 md:absolute md:top-0 md:left-0">
                  <span className="tabular flex size-7 items-center justify-center rounded-full bg-ink text-sm font-bold text-canvas">
                    {i + 1}
                  </span>
                  <span className="text-xs font-medium text-ink-muted md:hidden">{step.who}</span>
                </div>
                <h3 className="mt-3 font-semibold text-ink md:mt-4">{step.title}</h3>
                <p className="mt-0.5 hidden text-xs font-medium text-ink-faint md:block">
                  {step.who}
                </p>
                <p className="mt-2 text-sm text-ink-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="scores-title" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 id="scores-title" className="text-2xl font-bold text-ink">
              What a number means here
            </h2>
            <p className="mt-3 max-w-[48ch] text-ink-muted">
              Scores and AI-assisted interview grades are labelled experimental. Original answers
              stay visible to both people, and either side can ask for a correction.
            </p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
            <div className="bg-surface p-6">
              <h3 className="font-semibold text-ink">A score is</h3>
              <ul className="mt-4 space-y-3">
                {SCORE_IS.map((t) => (
                  <li key={t} className="flex gap-3 text-sm text-ink-muted">
                    <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-surface p-6">
              <h3 className="font-semibold text-ink">A score is not</h3>
              <ul className="mt-4 space-y-3">
                {SCORE_IS_NOT.map((t) => (
                  <li key={t} className="flex gap-3 text-sm text-ink-muted">
                    <X className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
