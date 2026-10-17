import type { BriefStatus } from '@cofoundry/shared';
import { Badge } from '../../components/ui';

/** Status shown as text plus colour (never colour alone, Section 02). */
export function BriefStatusBadge({ status, version }: { status: BriefStatus; version: number }) {
  if (status === 'draft') return <Badge tone="caution">Draft · version {version}</Badge>;
  if (status === 'open') return <Badge tone="brand">Open · version 1</Badge>;
  return <Badge>Closed</Badge>;
}

/** Date in the viewer's timezone with the timezone label (Section 03). */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
