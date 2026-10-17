import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESUME_CONSENT_HEADER,
  RESUME_CONTENT_TYPE,
  RESUME_EXPECTED_VERSION_HEADER,
  RESUME_FILENAME_HEADER,
  RESUME_POLICY_VERSION,
  type CandidateResumeData,
  type ResumeTextData,
} from '@cofoundry/shared';
import { api } from '../../lib/api/client';

export const resumeKeys = {
  state: ['resume'] as const,
  text: ['resume', 'text'] as const,
};

/** Same-origin download URL; the session cookie authorises it, nothing else does. */
export const RESUME_FILE_URL = '/api/v1/candidate/resume/file';

export function useResume() {
  return useQuery({
    queryKey: resumeKeys.state,
    queryFn: ({ signal }) => api.get<CandidateResumeData>('/candidate/resume', { signal }),
  });
}

export function useResumeText(enabled: boolean) {
  return useQuery({
    queryKey: resumeKeys.text,
    queryFn: ({ signal }) => api.get<ResumeTextData>('/candidate/resume/text', { signal }),
    enabled,
  });
}

export function useUploadResume() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, expectedVersion }: { file: File; expectedVersion: number }) =>
      api.upload<CandidateResumeData>('/candidate/resume', file, RESUME_CONTENT_TYPE, {
        [RESUME_CONSENT_HEADER]: RESUME_POLICY_VERSION,
        [RESUME_EXPECTED_VERSION_HEADER]: String(expectedVersion),
        [RESUME_FILENAME_HEADER]: encodeURIComponent(file.name),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(resumeKeys.state, data);
      queryClient.removeQueries({ queryKey: resumeKeys.text });
    },
  });
}

export function useDeleteResume() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.send('DELETE', '/candidate/resume'),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: resumeKeys.text });
      void queryClient.invalidateQueries({ queryKey: resumeKeys.state });
    },
  });
}
