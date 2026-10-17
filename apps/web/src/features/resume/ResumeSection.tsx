import { useId, useRef, useState } from 'react';
import { Download, FileText, ShieldCheck, Trash2, Upload } from 'lucide-react';
import {
  RESUME_LIMITS,
  RESUME_PROCESSING_NOTICE,
  formatBytes,
  type CandidateResumeData,
  type ResumeMetadata,
} from '@cofoundry/shared';
import { ApiError } from '../../lib/api/client';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CheckboxField,
  ErrorState,
  LoadingState,
} from '../../components/ui';
import { RESUME_FILE_URL, useDeleteResume, useResume, useResumeText, useUploadResume } from './api';
import { formatDate } from '../briefs/status';

/**
 * Private resume management inside the candidate profile (Phase 4 amendment). The resume is
 * independent of the profile save: uploads, replacements and deletion take effect immediately.
 */
export function ResumeSection() {
  const query = useResume();
  return (
    <Card as="section" aria-label="Resume">
      <CardHeader
        title="Resume (optional)"
        description="A private PDF used only to prepare interview questions about your experience."
        action={
          <Badge tone="info" icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}>
            Private
          </Badge>
        }
      />
      {query.isPending ? (
        <LoadingState label="Loading your resume" />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <ResumeManager state={query.data} />
      )}
    </Card>
  );
}

function clientFileError(file: File): string | null {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) return 'Choose a PDF file.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > RESUME_LIMITS.maxBytes) return 'Resumes can be at most 5 MB.';
  return null;
}

function ResumeManager({ state }: { state: CandidateResumeData }) {
  const upload = useUploadResume();
  const remove = useDeleteResume();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'uploaded' | 'deleted' | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showText, setShowText] = useState(false);

  const resume = state.resume;
  const choosing = !resume || replacing;

  const onUpload = async () => {
    setDone(null);
    if (!file) return setError('Choose a PDF file.');
    const fileError = clientFileError(file);
    if (fileError) return setError(fileError);
    if (!consent) return setError('Agree to the resume processing notice to upload.');
    setError(null);
    try {
      await upload.mutateAsync({ file, expectedVersion: state.currentVersion });
      setFile(null);
      setReplacing(false);
      setShowText(false);
      if (inputRef.current) inputRef.current.value = '';
      setDone('uploaded');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.fieldErrors?.file?.[0] ?? err.fieldErrors?.consent?.[0] ?? err.message)
          : 'Uploading failed. Try again.',
      );
    }
  };

  const onDelete = async () => {
    setDone(null);
    setError(null);
    try {
      await remove.mutateAsync();
      setConfirmDelete(false);
      setShowText(false);
      setConsent(false);
      setDone('deleted');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Deleting failed. Try again.');
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {done === 'uploaded' ? <Alert tone="success" title="Resume saved" live /> : null}
      {done === 'deleted' ? (
        <Alert tone="success" title="Resume deleted" live>
          The file and its extracted text were removed, and your resume consent was withdrawn.
        </Alert>
      ) : null}
      {error ? <Alert tone="danger" title={error} live /> : null}

      {resume ? <ResumeDetails resume={resume} /> : null}
      {!resume ? (
        <p className="text-sm text-ink-muted">
          No resume uploaded. That’s fine: interviews can use your profile skills and projects
          instead.
        </p>
      ) : null}

      {choosing ? (
        <div className="flex flex-col gap-4 rounded-xl border border-line p-4 sm:p-5">
          <p className="max-w-prose text-sm text-ink">{RESUME_PROCESSING_NOTICE}</p>
          <CheckboxField
            label="I agree to the resume processing notice"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <div className="flex flex-col gap-2">
            <label htmlFor={inputId} className="text-sm font-semibold text-ink">
              {resume ? 'Replacement PDF' : 'Resume PDF'}
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept="application/pdf,.pdf"
              aria-describedby={`${inputId}-hint`}
              className="block w-full max-w-md text-sm text-ink file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-surface-sunk"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setError(null);
              }}
            />
            <p id={`${inputId}-hint`} className="text-sm text-ink-muted">
              PDF only, up to 5 MB. Password-protected PDFs can’t be read. The first{' '}
              {RESUME_LIMITS.maxPages} pages are used.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              icon={<Upload className="size-4" aria-hidden="true" />}
              loading={upload.isPending}
              disabled={!file || !consent}
              onClick={() => void onUpload()}
            >
              {resume ? 'Replace resume' : 'Upload resume'}
            </Button>
            {replacing ? (
              <Button variant="ghost" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {resume && !replacing ? (
        <div className="flex flex-wrap gap-2">
          <a
            href={RESUME_FILE_URL}
            download
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-sunk"
          >
            <Download className="size-4" aria-hidden="true" /> Download
          </a>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileText className="size-4" aria-hidden="true" />}
            aria-expanded={showText}
            onClick={() => setShowText((v) => !v)}
          >
            {showText ? 'Hide extracted text' : 'View extracted text'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 className="size-4" aria-hidden="true" />}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        </div>
      ) : null}

      {confirmDelete ? (
        <Alert
          tone="caution"
          title="Delete your resume?"
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="danger"
                loading={remove.isPending}
                onClick={() => void onDelete()}
              >
                Delete resume
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </div>
          }
        >
          The file and its extracted text are removed now. Future interviews will use your profile
          instead.
        </Alert>
      ) : null}

      {showText && resume ? <ExtractedText /> : null}
    </div>
  );
}

function ResumeDetails({ resume }: { resume: ResumeMetadata }) {
  const x = resume.extraction;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-ink">File</dt>
          <dd className="break-all text-ink-muted">{resume.filename}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">Size and pages</dt>
          <dd className="text-ink-muted">
            {formatBytes(resume.sizeBytes)} · {x.pageCount} {x.pageCount === 1 ? 'page' : 'pages'}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">Uploaded</dt>
          <dd className="text-ink-muted">
            {formatDate(resume.uploadedAt)} · version {resume.version}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">Text extraction</dt>
          <dd className="flex flex-wrap items-center gap-2 text-ink-muted">
            <Badge tone={x.status === 'succeeded' ? 'brand' : 'caution'}>
              {x.status === 'succeeded' ? 'Text extracted' : 'No text found'}
            </Badge>
            {x.status === 'succeeded' ? `${x.textChars.toLocaleString()} characters` : null}
          </dd>
        </div>
      </dl>
      {x.status === 'no_text' ? (
        <Alert tone="caution" title="This PDF has no readable text">
          It may be a scanned image. Resume-based questions won’t be available; interviews will use
          your profile. Upload a text-based PDF to change that.
        </Alert>
      ) : null}
      {x.truncated ? (
        <p className="text-sm text-ink-muted">
          Only the first {x.pagesProcessed} pages or {RESUME_LIMITS.maxTextChars.toLocaleString()}{' '}
          characters were used.
        </p>
      ) : null}
    </div>
  );
}

function ExtractedText() {
  const text = useResumeText(true);
  if (text.isPending) return <LoadingState label="Loading extracted text" />;
  if (text.isError) return <ErrorState error={text.error} onRetry={() => void text.refetch()} />;
  const r = text.data.redactions;
  return (
    <section aria-label="Extracted text" className="flex flex-col gap-2">
      <p className="text-sm text-ink-muted">
        This is the text an interview service would receive, after removing {r.emails} email
        {r.emails === 1 ? '' : 's'}, {r.phones} phone number{r.phones === 1 ? '' : 's'} and {r.urls}{' '}
        link{r.urls === 1 ? '' : 's'}. Founders never see it.
      </p>
      <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-sunk p-4 font-sans text-sm whitespace-pre-wrap text-ink">
        {text.data.redactedText || '(no text)'}
      </pre>
    </section>
  );
}
