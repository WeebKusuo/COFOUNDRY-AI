import { useState } from 'react';
import { SAFETY_LIMITS, type CorrectionTargetType } from '@cofoundry/shared';
import { Alert, Button, TextAreaField } from '../../components/ui';
import { MutationError, fieldError } from '../collaboration/parts';
import { useOpenCorrection } from './api';

/**
 * Candidate's correction request for their own report (or profile). A moderator reviews it; the
 * original answers and scores are never overwritten — an accepted correction is shown as an
 * attributed overlay to both report participants.
 */
export function CorrectionControl({
  targetType,
  targetId,
}: {
  targetType: CorrectionTargetType;
  targetId: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const correction = useOpenCorrection();
  if (correction.isSuccess && correction.data) {
    return (
      <Alert
        tone="success"
        title={correction.data.linked ? 'Added to your open request' : 'Correction requested'}
        live
      >
        A moderator will review it. Until then it is shown on the report as an open correction and
        does not change any score. Track it in Safety &amp; account.
      </Alert>
    );
  }
  if (!open) {
    return (
      <Button variant="secondary" size="sm" className="self-start" onClick={() => setOpen(true)}>
        Request a correction
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        correction.mutate({ targetType, targetId, text: text.trim() });
      }}
    >
      <TextAreaField
        label="What is incorrect, and what should it say?"
        hint="Point to the question or section. Only you and the assigned moderator read this."
        value={text}
        maxLength={SAFETY_LIMITS.textMax}
        counter={`${text.length}/${SAFETY_LIMITS.textMax}`}
        error={fieldError(correction.error, 'text')}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          loading={correction.isPending}
          disabled={text.trim().length < SAFETY_LIMITS.textMin}
        >
          Send correction request
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <MutationError error={correction.error} title="Not sent" />
    </form>
  );
}
