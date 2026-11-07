import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AccessRange,
  AdminApiTokenDTO,
  ApiTokenDTO,
  CreateApiTokenInput,
  CreatedApiTokenDTO,
} from '@inkling/shared'
import { api } from './api'

// Connection range for OAuth grants and personal API tokens (docs/adr/1200-*, 1201-*).

const send = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) })

export function useUpdateGrantRange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, range }: { id: string; range: AccessRange }) =>
      api<{ ok: true }>(`/api/oauth/grants/${id}`, send('PATCH', { range })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['oauth', 'grants'] }),
  })
}

export function useApiTokens() {
  return useQuery({
    queryKey: ['apiTokens'] as const,
    queryFn: () => api<{ tokens: ApiTokenDTO[] }>('/api/tokens').then((r) => r.tokens),
  })
}

export function useCreateApiToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateApiTokenInput) => api<CreatedApiTokenDTO>('/api/tokens', send('POST', input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apiTokens'] }),
  })
}

export function useUpdateApiToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; range?: AccessRange }) =>
      api<{ token: ApiTokenDTO }>(`/api/tokens/${id}`, send('PATCH', body)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apiTokens'] }),
  })
}

export function useRevokeApiToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apiTokens'] }),
  })
}

export function useAdminUserTokens(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'apiTokens', userId] as const,
    queryFn: () => api<{ tokens: AdminApiTokenDTO[] }>(`/api/admin/users/${userId}/api-tokens`).then((r) => r.tokens),
    enabled,
  })
}

export function useAdminRevokeUserTokens() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      api<{ revoked: number }>(`/api/admin/users/${userId}/api-tokens`, { method: 'DELETE' }),
    onSuccess: (_d, userId) => qc.invalidateQueries({ queryKey: ['admin', 'apiTokens', userId] }),
  })
}
