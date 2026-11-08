import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AccessCandidateDTO,
  PageAccessDTO,
  PageAccessLevel,
  PageInvitePreviewDTO,
  SetPageAccessResult,
  WorkspaceGuestDTO,
} from '@inkling/shared'
import { api, qk, qkAdmin } from './api'

// People with access to a page tree, guests and page invitations (docs/adr/1250-* .. 1253-*).
// Kept out of api.ts like sidebarApi.ts / notificationsApi.ts.

export const qkAccess = {
  page: (pageId: string) => ['pageAccess', pageId] as const,
  candidates: (pageId: string, q: string) => ['pageAccessCandidates', pageId, q] as const,
  guests: (wsId: string) => ['wsGuests', wsId] as const,
  invite: (token: string) => ['pageInvite', token] as const,
}

/** GET /pages/:id/access — members only (a guest gets 403, so callers keep it off for guests). */
export function usePageAccess(pageId: string, enabled = true) {
  return useQuery({
    queryKey: qkAccess.page(pageId),
    queryFn: () => api<{ access: PageAccessDTO }>(`/api/pages/${pageId}/access`).then((r) => r.access),
    enabled: !!pageId && enabled,
    retry: false,
  })
}

/** People to add: members by name/email part, other accounts only on an exact email. */
export function useAccessCandidates(pageId: string, q: string, enabled = true) {
  return useQuery({
    queryKey: qkAccess.candidates(pageId, q),
    queryFn: () =>
      api<{ candidates: AccessCandidateDTO[] }>(
        `/api/pages/${pageId}/access/candidates?q=${encodeURIComponent(q)}`,
      ).then((r) => r.candidates),
    enabled: !!pageId && enabled && q.length > 0,
    staleTime: 10_000,
    retry: false,
  })
}

/** Every access change can move levels in the subtree: refresh the lists and the lock answers. */
function useAfterAccessChange(pageId: string) {
  const qc = useQueryClient()
  return (access: PageAccessDTO) => {
    qc.setQueryData(qkAccess.page(pageId), access)
    qc.invalidateQueries({ queryKey: ['pageAccess'] })
    qc.invalidateQueries({ queryKey: ['pageLock'] })
    qc.invalidateQueries({ queryKey: ['wsGuests'] })
    qc.invalidateQueries({ queryKey: ['wsAudit'] })
  }
}

export function useSetPageAccess(pageId: string) {
  const after = useAfterAccessChange(pageId)
  return useMutation({
    mutationFn: (input: { userId?: string; email?: string; level: PageAccessLevel }) =>
      api<SetPageAccessResult>(`/api/pages/${pageId}/access`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (r) => after(r.access),
  })
}

export function useRemovePageAccess(pageId: string) {
  const after = useAfterAccessChange(pageId)
  return useMutation({
    mutationFn: (userId: string) =>
      api<{ access: PageAccessDTO }>(`/api/pages/${pageId}/access/${userId}`, { method: 'DELETE' }).then((r) => r.access),
    onSuccess: after,
  })
}

export function useCancelPageInvite(pageId: string) {
  const after = useAfterAccessChange(pageId)
  return useMutation({
    mutationFn: (inviteId: string) =>
      api<{ access: PageAccessDTO }>(`/api/pages/${pageId}/invites/${inviteId}`, { method: 'DELETE' }).then((r) => r.access),
    onSuccess: after,
  })
}

/** GET /workspaces/:id/guests — owners and admins. */
export function useWorkspaceGuests(wsId: string, enabled = true) {
  return useQuery({
    queryKey: qkAccess.guests(wsId),
    queryFn: () => api<{ guests: WorkspaceGuestDTO[] }>(`/api/workspaces/${wsId}/guests`).then((r) => r.guests),
    enabled: !!wsId && enabled,
  })
}

export function useRemoveGuests(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userIds: string[]) =>
      api<{ removed: number }>(`/api/workspaces/${wsId}/guests/remove`, {
        method: 'POST',
        body: JSON.stringify({ userIds }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkAccess.guests(wsId) })
      qc.invalidateQueries({ queryKey: ['pageAccess'] })
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}

/** GET /page-invites/:token (signed in). */
export function usePageInvite(token: string, enabled = true) {
  return useQuery({
    queryKey: qkAccess.invite(token),
    queryFn: () => api<{ invite: PageInvitePreviewDTO }>(`/api/page-invites/${encodeURIComponent(token)}`).then((r) => r.invite),
    enabled: !!token && enabled,
    retry: false,
  })
}

export function useAcceptPageInvite(token: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api<{ workspaceId: string; pageId: string }>(`/api/page-invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: qk.workspaces })
      qc.invalidateQueries({ queryKey: qk.pages(r.workspaceId) })
      qc.invalidateQueries({ queryKey: qkAdmin.pageLock(r.pageId) })
    },
  })
}
