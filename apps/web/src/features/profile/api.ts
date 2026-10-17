import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CandidateProfileData,
  CandidateProfileUpdate,
  FounderProfileData,
  FounderProfileUpdate,
  ProfilePublic,
} from '@cofoundry/shared';
import { api } from '../../lib/api/client';
import { meQueryKey } from '../../lib/auth';

export const profileKeys = {
  candidate: ['profile', 'candidate'] as const,
  founder: ['profile', 'founder'] as const,
  public: (userId: string) => ['profile', 'public', userId] as const,
};

export function useCandidateProfile() {
  return useQuery({
    queryKey: profileKeys.candidate,
    queryFn: ({ signal }) => api.get<CandidateProfileData>('/candidate/profile', { signal }),
  });
}

export function useSaveCandidateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CandidateProfileUpdate) =>
      (await api.send<CandidateProfileData>(
        'PUT',
        '/candidate/profile',
        body,
      )) as CandidateProfileData,
    onSuccess: (data) => {
      queryClient.setQueryData(profileKeys.candidate, data);
      void queryClient.invalidateQueries({ queryKey: ['profile', 'public'] });
      void queryClient.invalidateQueries({ queryKey: meQueryKey });
    },
  });
}

export function useFounderProfile() {
  return useQuery({
    queryKey: profileKeys.founder,
    queryFn: ({ signal }) => api.get<FounderProfileData>('/founder/profile', { signal }),
  });
}

export function useSaveFounderProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: FounderProfileUpdate) =>
      (await api.send<FounderProfileData>('PUT', '/founder/profile', body)) as FounderProfileData,
    onSuccess: (data) => {
      queryClient.setQueryData(profileKeys.founder, data);
      void queryClient.invalidateQueries({ queryKey: meQueryKey });
    },
  });
}

export function usePublicProfile(userId: string, enabled = true) {
  return useQuery({
    queryKey: profileKeys.public(userId),
    queryFn: ({ signal }) =>
      api.get<ProfilePublic>(`/profiles/${encodeURIComponent(userId)}`, { signal }),
    enabled,
  });
}
