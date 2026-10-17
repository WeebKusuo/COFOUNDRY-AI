import { useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api/client';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CheckboxField,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  Switch,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';

const SWATCHES = [
  ['canvas', 'bg-canvas'],
  ['surface', 'bg-surface'],
  ['surface-sunk', 'bg-surface-sunk'],
  ['line', 'bg-line'],
  ['ink', 'bg-ink'],
  ['ink-muted', 'bg-ink-muted'],
  ['brand', 'bg-brand'],
  ['brand-soft', 'bg-brand-soft'],
  ['signal', 'bg-signal'],
  ['caution', 'bg-caution'],
  ['danger', 'bg-danger'],
  ['info', 'bg-info'],
] as const;

const TYPE_SCALE = [
  ['text-4xl', 'Display, 68 px max'],
  ['text-3xl', 'Page title, 39 px'],
  ['text-2xl', 'Section, 31 px'],
  ['text-xl', 'Lead, 25 px'],
  ['text-lg', 'Card title, 20 px'],
  ['text-base', 'Body, 17 px'],
  ['text-sm', 'Secondary, 15 px'],
  ['text-xs', 'Caption, 13 px'],
] as const;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card as="section">
      <CardHeader title={title} description={description} />
      {children}
    </Card>
  );
}

export function DesignSystemPage() {
  const [discoverable, setDiscoverable] = useState(false);
  const [tab, setTab] = useState('invitations');
  const [headline, setHeadline] = useState('Backend developer, Node and MongoDB');
  const [retrying, setRetrying] = useState(false);

  const retry = () => {
    setRetrying(true);
    window.setTimeout(() => setRetrying(false), 1200);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold text-ink">Design system</h1>
      <p className="mt-2 max-w-[60ch] text-ink-muted">
        Tokens and components shared by every screen. Switch the theme in the header to check both
        palettes; every state colour is paired with text.
      </p>

      <div className="mt-10 flex flex-col gap-8">
        <Section title="Colour tokens" description="Semantic names; values change per theme.">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {SWATCHES.map(([name, cls]) => (
              <li key={name} className="text-sm">
                <span
                  className={`block h-14 rounded-lg border border-line ${cls}`}
                  aria-hidden="true"
                />
                <span className="mt-1.5 block font-medium text-ink">{name}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Type"
          description="Schibsted Grotesk throughout; tabular figures for scores."
        >
          <ul className="flex flex-col gap-3">
            {TYPE_SCALE.map(([cls, label]) => (
              <li key={cls} className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className="w-40 text-sm text-ink-faint">{label}</span>
                <span className={`${cls} font-semibold text-ink`}>Test the fit</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Buttons"
          description="One primary action per view. Loading disables and announces busy."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button>Publish brief</Button>
            <Button variant="secondary">Save draft</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Close brief</Button>
            <Button loading>Saving</Button>
            <Button disabled>Not allowed</Button>
            <Button size="sm" variant="secondary">
              Small
            </Button>
          </div>
        </Section>

        <Section
          title="Badges"
          description="Labels for evidence and status. The words carry the meaning."
        >
          <div className="flex flex-wrap gap-2">
            <Badge tone="brand">Complete profile</Badge>
            <Badge tone="caution">Provisional</Badge>
            <Badge>Self-reported link</Badge>
            <Badge tone="caution">Seeded demo data</Badge>
            <Badge tone="info">Experimental assessment</Badge>
            <Badge tone="danger">Disputed</Badge>
          </div>
        </Section>

        <Section
          title="Forms"
          description="Visible labels, linked hints and errors, explicit required markers."
        >
          <div className="grid gap-6 md:grid-cols-2">
            <TextField
              label="Headline"
              hint="Shown on your public profile."
              value={headline}
              maxLength={160}
              counter={`${headline.length}/160`}
              onChange={(e) => setHeadline(e.target.value)}
            />
            <TextField
              label="Weekly hours"
              type="number"
              inputMode="numeric"
              required
              defaultValue="0"
              error="Enter whole hours from 1 to 40."
            />
            <SelectField label="Industry" defaultValue="fintech">
              <option value="fintech">Fintech</option>
              <option value="education">Education</option>
              <option value="developer-tools">Developer tools</option>
            </SelectField>
            <TextAreaField label="Project description" hint="50 to 1,500 characters." />
            <div className="md:col-span-2">
              <CheckboxField
                label="I understand this acknowledgement is not a signed NDA"
                hint="Don’t disclose secrets. Arrange any legal agreement separately."
              />
            </div>
            <div className="md:col-span-2">
              <Switch
                checked={discoverable}
                onChange={setDiscoverable}
                label="Discoverable by founders"
                description="Turning this off hides you from new searches. Existing invitations stay."
              />
            </div>
          </div>
        </Section>

        <Section
          title="Alerts"
          description="Static notices are not live regions; errors after an action are."
        >
          <div className="flex flex-col gap-3">
            <Alert title="No monetary payment promised">
              This sprint is unpaid. Both people acknowledge that before approving.
            </Alert>
            <Alert tone="success" title="Draft saved" />
            <Alert tone="caution" title="Your recommendations are out of date">
              A candidate changed their profile. Refresh the search to invite them.
            </Alert>
            <Alert tone="danger" title="Assessment couldn’t be evaluated">
              Source answers are still available. You can retry once.
            </Alert>
          </div>
        </Section>

        <Section title="Tabs" description="Arrow keys move between tabs.">
          <Tabs
            label="Inbox"
            value={tab}
            onChange={setTab}
            items={[
              {
                id: 'invitations',
                label: 'Interview invitations',
                count: 0,
                content: (
                  <EmptyState title="No invitations yet">
                    Founders’ invitations appear here.
                  </EmptyState>
                ),
              },
              {
                id: 'requests',
                label: 'Collaboration requests',
                count: 0,
                content: (
                  <EmptyState title="No requests yet">
                    Requests appear after an evaluated interview.
                  </EmptyState>
                ),
              },
            ]}
          />
        </Section>

        <Section
          title="Screen states"
          description="Every screen renders loading, empty, error, forbidden and not-found."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <LoadingState label="Loading candidates" />
            <EmptyState title="No briefs yet">
              Create a draft brief to start finding candidates.
            </EmptyState>
            <ErrorState
              error={
                new ApiError({
                  status: 0,
                  code: 'NETWORK_ERROR',
                  message: 'Could not reach the server. Check your connection and try again.',
                })
              }
              onRetry={retry}
              retrying={retrying}
            />
            <ErrorState
              error={new ApiError({ status: 404, code: 'NOT_FOUND', message: 'Not found' })}
            />
          </div>
        </Section>
      </div>
    </div>
  );
}
