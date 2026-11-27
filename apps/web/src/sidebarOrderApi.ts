import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ChildSort, PageMetaDTO, RootSortDTO, WorkspaceDTO, WorkspaceSettingsDTO } from '@inkling/shared'
import { api, qk } from './api'

// Sidebar order (docs/adr/2590-*, 2591-*, 2592-*): pin a page for everyone, sort a parent's children by
// title, sort a section's top level by title, and the page agents' new pages go under. Browser only; the
// server checks who may (people who may edit the page; members; owners and admins).

type SettingsResponse = { settings: WorkspaceSettingsDTO }

/** Writes one page's fields into the cached tree right away; the next poll brings the server's copy. */
function patchPage(qc: ReturnType<typeof useQueryClient>, wsId: string, id: string, patch: Partial<PageMetaDTO>) {
  qc.setQueryData<PageMetaDTO[]>(qk.pages(wsId), (old) => old?.map((p) => (p.id === id ? { ...p, ...patch } : p)))
}

export function usePinPage(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api<{ page: PageMetaDTO }>(`/api/pages/${id}/pin`, { method: 'PUT', body: JSON.stringify({ pinned }) }).then((r) => r.page),
    onSuccess: (page) => patchPage(qc, wsId, page.id, { pinned: page.pinned }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.pages(wsId) }),
  })
}

export function useChildSort(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, childSort }: { id: string; childSort: ChildSort }) =>
      api<{ page: PageMetaDTO }>(`/api/pages/${id}/child-sort`, { method: 'PUT', body: JSON.stringify({ childSort }) }).then((r) => r.page),
    onSuccess: (page) => patchPage(qc, wsId, page.id, { childSort: page.childSort }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.pages(wsId) }),
  })
}

export function useRootSort(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { section: 'shared' | 'private'; childSort: ChildSort }) =>
      api<{ rootSort: RootSortDTO }>(`/api/workspaces/${wsId}/root-sort`, { method: 'PUT', body: JSON.stringify(input) }).then((r) => r.rootSort),
    onSuccess: (rootSort) => {
      qc.setQueryData<WorkspaceDTO[]>(qk.workspaces, (old) =>
        old?.map((w) => (w.id === wsId ? { ...w, rootSort: rootSort.shared || rootSort.private ? rootSort : undefined } : w)),
      )
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces })
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    },
  })
}

export function useSetAgentDefaultParent(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (pageId: string | null) =>
      api<SettingsResponse>(`/api/workspaces/${wsId}/settings/agent-default-parent`, { method: 'PUT', body: JSON.stringify({ pageId }) }),
    onSuccess: (data) => {
      qc.setQueryData<SettingsResponse>(['wsSettings', wsId], (prev) => (prev ? { ...prev, settings: data.settings } : prev))
      const id = data.settings.agentDefaultParent?.id
      qc.setQueryData<WorkspaceDTO[]>(qk.workspaces, (old) =>
        old?.map((w) => (w.id === wsId ? { ...w, agentDefaultParentId: id } : w)),
      )
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.workspaces })
      qc.invalidateQueries({ queryKey: ['wsAudit', wsId] })
    },
  })
}
