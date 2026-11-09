import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ActivityItemDTO, RevertResultDTO } from '@inkling/shared'
import { api, useWorkspaces } from './api'

// Reverting logged changes (docs/adr/1620-* .. 1624-*): the page's own change list for the right
// panel, and one call shape for preview (dryRun) and run, for one change, an agent's changes on a
// page, or in the workspace.

export const qkRevert = {
  pageChanges: (pageId: string) => ['pageChanges', pageId] as const,
}

export function usePageChanges(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: qkRevert.pageChanges(pageId),
    queryFn: () => api<{ items: ActivityItemDTO[]; next: string | null }>(`/api/pages/${pageId}/changes?limit=8`),
    enabled: !!pageId && enabled,
    refetchOnWindowFocus: true,
  })
}

export type RevertTarget =
  | { kind: 'change'; seq: string }
  | { kind: 'page'; pageId: string; via: string; actorId?: string | null; since: string }
  | { kind: 'workspace'; wsId: string; via: string; actorId?: string | null; since: string }

function request(target: RevertTarget, dryRun: boolean): Promise<RevertResultDTO> {
  const init = (body: object) => ({ method: 'POST', body: JSON.stringify({ ...body, dryRun }) })
  if (target.kind === 'change') return api<RevertResultDTO>(`/api/changes/${target.seq}/revert`, init({}))
  const body = { via: target.via, since: target.since, ...(target.actorId ? { actorId: target.actorId } : {}) }
  if (target.kind === 'page') return api<RevertResultDTO>(`/api/pages/${target.pageId}/revert`, init(body))
  return api<RevertResultDTO>(`/api/workspaces/${target.wsId}/revert`, init(body))
}

/** The preview: what a revert would apply and what conflicts, nothing written. */
export function useRevertPreview(target: RevertTarget | null) {
  return useQuery({
    queryKey: ['revertPreview', target],
    queryFn: () => request(target!, true),
    enabled: !!target,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

export function useRunRevert() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (target: RevertTarget) => request(target, false),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['activity'] })
      void queryClient.invalidateQueries({ queryKey: ['pageChanges'] })
      void queryClient.invalidateQueries({ queryKey: ['revertPreview'] })
    },
  })
}

/** Owners and admins may revert an agent's changes across the workspace. */
export function useCanRevertWorkspace(wsId: string): boolean {
  const { data } = useWorkspaces()
  const role = data?.find((w) => w.id === wsId)?.role
  return role === 'owner' || role === 'admin'
}
