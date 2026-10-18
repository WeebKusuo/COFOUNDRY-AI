import { useState } from 'react';
import { Ban, Flag } from 'lucide-react';
import {
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS,
  SAFETY_LIMITS,
  type ReportCategory,
  type ReportTargetType,
} from '@cofoundry/shared';
import { Alert, Button, SelectField, TextAreaField } from '../../components/ui';
import { MutationError, fieldError } from '../collaboration/parts';
import { useBlock, useOpenReport } from './api';

/**
 * Block and report controls shown next to a counterpart (requests, matches, sprints, interviews).
 * Both are explicit, confirmed actions; the server re-checks visibility and applies effects.
 */

export function BlockControl({ userId, name }: { userId: string; name: string }) {
  const [confirm, setConfirm] = useState(false);
  const block = useBlock();
  if (block.isSuccess) {
    return (
      <Alert tone="success" title={`You blocked ${name}`} live>
        Pending requests and active work between you have ended. You can unblock in Safety &amp;
        account; nothing ended by the block is restored.
      </Alert>
    );
  }
  return confirm ? (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <p className="text-sm text-ink">
        Block {name}? Pending requests are withdrawn, an active match or sprint ends, and neither of
        you can start anything new. They are not told why.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          size="sm"
          loading={block.isPending}
          onClick={() => block.mutate(userId)}
        >
          Block {name}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
          Keep
        </Button>
      </div>
      <MutationError error={block.error} title="Could not block" />
    </div>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      icon={<Ban className="size-4" aria-hidden="true" />}
      onClick={() => setConfirm(true)}
    >
      Block {name}
    </Button>
  );
}

export function ReportControl({
  targetType,
  targetId,
  label = 'Report a problem',
  defaultCategory = 'other',
}: {
  targetType: ReportTargetType;
  targetId: string;
  label?: string;
  defaultCategory?: ReportCategory;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory>(defaultCategory);
  const [text, setText] = useState('');
  const report = useOpenReport();
  if (report.isSuccess && report.data) {
    return (
      <Alert
        tone="success"
        title={report.data.linked ? 'Added to your open case' : 'Report sent'}
        live
      >
        A moderator will review it. Your report is a claim, not a verified finding; track it in
        Safety &amp; account. The other person cannot see it.
      </Alert>
    );
  }
  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        icon={<Flag className="size-4" aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        report.mutate({ targetType, targetId, category, text: text.trim() });
      }}
    >
      <SelectField
        label="What is the problem?"
        value={category}
        onChange={(e) => setCategory(e.target.value as ReportCategory)}
      >
        {REPORT_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {REPORT_CATEGORY_LABELS[c]}
          </option>
        ))}
      </SelectField>
      <TextAreaField
        label="Describe what happened"
        hint="Only you and the assigned moderator can read this."
        value={text}
        maxLength={SAFETY_LIMITS.textMax}
        counter={`${text.length}/${SAFETY_LIMITS.textMax}`}
        error={fieldError(report.error, 'text')}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          loading={report.isPending}
          disabled={text.trim().length < SAFETY_LIMITS.textMin}
        >
          Send report
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <MutationError error={report.error} title="Could not send the report" />
    </form>
  );
}
