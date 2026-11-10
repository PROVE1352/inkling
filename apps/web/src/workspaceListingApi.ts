import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkspaceDTO, WorkspaceGroupDTO, WorkspaceListingDTO } from '@inkling/shared'
import { api, qk, useMe } from './api'
import { t } from './i18n'
import { toast } from './lib/toast'

// A person's own workspace list: groups, order, archive (docs/adr/2300-*). Kept out of api.ts like
// sidebarApi.ts. The per-workspace part rides on GET /workspaces (`listing`), so every change
// refetches that list; the groups have their own small query.

export const qkWorkspaceGroups = (userId: string) => ['workspaceGroups', userId] as const

const NO_GROUPS: WorkspaceGroupDTO[] = []

/** The person's groups in their order ([] while loading or for a fresh account). */
export function useWorkspaceGroups(): WorkspaceGroupDTO[] {
  const userId = useMe().data?.id ?? ''
  const q = useQuery({
    queryKey: qkWorkspaceGroups(userId),
    queryFn: () => api<{ groups: WorkspaceGroupDTO[] }>('/api/me/workspace-groups').then((r) => r.groups),
    staleTime: 30_000,
    enabled: !!userId,
  })
  return q.data ?? NO_GROUPS
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
})

export type ListingChange =
  | { kind: 'createGroup'; name: string }
  | { kind: 'updateGroup'; id: string; name?: string; collapsed?: boolean }
  | { kind: 'deleteGroup'; id: string }
  | { kind: 'orderGroups'; ids: string[] }
  | { kind: 'archiveGroup'; id: string; archived: boolean }
  | { kind: 'listing'; workspaceId: string; archived?: boolean; groupId?: string | null }
  | { kind: 'orderWorkspaces'; groupId: string | null; ids: string[] }

async function send(c: ListingChange): Promise<unknown> {
  switch (c.kind) {
    case 'createGroup':
      return api('/api/me/workspace-groups', json('POST', { name: c.name }))
    case 'updateGroup':
      return api(`/api/me/workspace-groups/${c.id}`, json('PATCH', { name: c.name, collapsed: c.collapsed }))
    case 'deleteGroup':
      return api(`/api/me/workspace-groups/${c.id}`, { method: 'DELETE' })
    case 'orderGroups':
      return api('/api/me/workspace-groups/order', json('PUT', { ids: c.ids }))
    case 'archiveGroup':
      return api(`/api/me/workspace-groups/${c.id}/archive`, json('POST', { archived: c.archived }))
    case 'listing':
      return api(`/api/me/workspaces/${c.workspaceId}/listing`, json('PATCH', { archived: c.archived, groupId: c.groupId }))
    case 'orderWorkspaces':
      return api('/api/me/workspace-order', json('PUT', { groupId: c.groupId, ids: c.ids }))
  }
}

/** What the switcher should show right away, before the server answers (folding, archive, order). */
function optimistic(c: ListingChange, ws: WorkspaceDTO[] | undefined, groups: WorkspaceGroupDTO[] | undefined) {
  const set = (w: WorkspaceDTO, patch: Partial<WorkspaceListingDTO>, drop: (keyof WorkspaceListingDTO)[] = []): WorkspaceDTO => {
    const next: WorkspaceListingDTO = { ...(w.listing ?? {}), ...patch }
    for (const k of drop) delete next[k]
    return { ...w, listing: next }
  }
  switch (c.kind) {
    case 'updateGroup':
      return { ws, groups: groups?.map((g) => (g.id === c.id ? { ...g, ...(c.name !== undefined ? { name: c.name } : {}), ...(c.collapsed !== undefined ? { collapsed: c.collapsed } : {}) } : g)) }
    case 'orderGroups': {
      const byId = new Map((groups ?? []).map((g) => [g.id, g]))
      return { ws, groups: [...c.ids.map((id) => byId.get(id)!).filter(Boolean), ...(groups ?? []).filter((g) => !c.ids.includes(g.id))] }
    }
    case 'listing':
      return {
        ws: ws?.map((w) =>
          w.id !== c.workspaceId
            ? w
            : c.archived === false
              ? set(w, {}, ['archived'])
              : set(w, c.archived ? { archived: true } : {}, c.groupId === null ? ['groupId', 'group', 'position'] : []),
        ),
        groups,
      }
    case 'orderWorkspaces': {
      const pos = new Map(c.ids.map((id, i) => [id, i]))
      const name = groups?.find((g) => g.id === c.groupId)?.name
      return {
        ws: ws?.map((w) => (pos.has(w.id) ? set(w, { position: pos.get(w.id)!, ...(c.groupId ? { groupId: c.groupId, group: name } : {}) }, c.groupId ? [] : ['groupId', 'group']) : w)),
        groups,
      }
    }
    default:
      return { ws, groups }
  }
}

/** One mutation for every change; one at a time, optimistic, then both lists are refetched. */
export function useWorkspaceListingChange() {
  const qc = useQueryClient()
  const userId = useMe().data?.id ?? ''
  const gKey = qkWorkspaceGroups(userId)
  return useMutation({
    scope: { id: 'workspaceListing' },
    mutationFn: send,
    onMutate: async (c) => {
      await Promise.all([qc.cancelQueries({ queryKey: qk.workspaces }), qc.cancelQueries({ queryKey: gKey })])
      const prevWs = qc.getQueryData<WorkspaceDTO[]>(qk.workspaces)
      const prevGroups = qc.getQueryData<WorkspaceGroupDTO[]>(gKey)
      const next = optimistic(c, prevWs, prevGroups)
      if (next.ws) qc.setQueryData(qk.workspaces, next.ws)
      if (next.groups) qc.setQueryData(gKey, next.groups)
      return { prevWs, prevGroups }
    },
    onError: (_e, _c, ctx) => {
      if (ctx?.prevWs) qc.setQueryData(qk.workspaces, ctx.prevWs)
      if (ctx?.prevGroups) qc.setQueryData(gKey, ctx.prevGroups)
      toast({ message: t('wsGroups.saveFailed') })
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.workspaces })
      void qc.invalidateQueries({ queryKey: gKey })
    },
  })
}
