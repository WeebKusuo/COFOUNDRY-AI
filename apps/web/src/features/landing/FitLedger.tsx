import { Badge } from '../../components/ui';

/**
 * The landing page's central figure: one candidate's match score broken into its four factors,
 * exactly as Contract Section 04 defines it. Values are the "Dev" fixture from Section 26 (seeded
 * PayPilot brief); the total is computed here from the factors, never typed in.
 */

export interface LedgerFactor {
  key: string;
  label: string;
  detail: string;
  value: number;
  weight: number;
}

export const DEV_FIXTURE: LedgerFactor[] = [
  {
    key: 'S',
    label: 'Skill gap fit',
    detail: 'Node.js 2 of 4 needed, REST 3 of 3',
    value: 71.428571,
    weight: 0.4,
  },
  { key: 'A', label: 'Availability', detail: '8 h/week for 3 months', value: 100, weight: 0.25 },
  { key: 'I', label: 'Shared interests', detail: 'Fintech, reliability', value: 75, weight: 0.15 },
  {
    key: 'P',
    label: 'Project relevance',
    detail: 'Best project tagged REST only',
    value: 42.857143,
    weight: 0.2,
  },
];

export function ledgerTotal(factors: LedgerFactor[]): number {
  return factors.reduce((sum, f) => sum + f.value * f.weight, 0);
}

const fmt = (n: number) => n.toFixed(2);

export function FitLedger({ factors = DEV_FIXTURE }: { factors?: LedgerFactor[] }) {
  const total = ledgerTotal(factors);
  return (
    <figure className="rounded-2xl border border-line bg-surface p-5 shadow-raised sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-ink-muted">Backend contributor for PayPilot</p>
          <p className="text-lg font-semibold text-ink">Candidate “Dev”</p>
        </div>
        <Badge tone="caution">Seeded demo data</Badge>
      </div>

      <table className="mt-6 w-full border-collapse text-left">
        <caption className="sr-only">
          Match score factors, their values, weights and weighted contributions
        </caption>
        <thead>
          <tr className="text-xs text-ink-faint">
            <th scope="col" className="pb-2 font-medium">
              Factor
            </th>
            <th scope="col" className="hidden pb-2 text-right font-medium sm:table-cell">
              Value × weight
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Adds
            </th>
          </tr>
        </thead>
        <tbody>
          {factors.map((f, i) => (
            <tr key={f.key} className="border-t border-line align-top">
              <th scope="row" className="py-3 pr-3 font-normal">
                <span className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-ink">{f.label}</span>
                </span>
                <span className="block text-sm text-ink-muted">{f.detail}</span>
                <span className="tabular block text-xs text-ink-faint sm:hidden">
                  {fmt(f.value)} × {f.weight.toFixed(2)}
                </span>
                <span
                  className="mt-2 block h-1.5 w-full rounded-full bg-surface-sunk"
                  aria-hidden="true"
                >
                  <span
                    className="ledger-bar block h-full rounded-full bg-brand"
                    style={{ width: `${f.value}%`, animationDelay: `${120 + i * 110}ms` }}
                  />
                </span>
              </th>
              <td className="tabular hidden py-3 pl-2 text-right text-sm whitespace-nowrap text-ink-muted sm:table-cell">
                {fmt(f.value)} × {f.weight.toFixed(2)}
              </td>
              <td className="tabular py-3 pl-3 text-right font-semibold whitespace-nowrap text-ink">
                {fmt(f.value * f.weight)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-ink">
            <th scope="row" className="pt-3 text-sm font-semibold text-ink">
              Match score
              <span className="block text-xs font-normal text-ink-muted">
                Complete profile, <span className="whitespace-nowrap">algorithm match-v3.0</span>
              </span>
            </th>
            <td className="hidden sm:table-cell" />
            <td className="tabular pt-3 text-right text-3xl font-bold tracking-tight text-ink">
              {fmt(total)}
            </td>
          </tr>
        </tfoot>
      </table>

      <figcaption className="mt-5 border-t border-line pt-4 text-sm text-ink-muted">
        Skills and project tags are self-reported. A score ranks who to look at first; it is not a
        probability of success and never decides for you.
      </figcaption>
    </figure>
  );
}
