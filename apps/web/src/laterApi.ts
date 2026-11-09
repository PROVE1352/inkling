import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  LaterItemDTO,
  LaterListDTO,
  SaveLaterInput,
  ThreadFollowDTO,
  ThreadListDTO,
  UpdateLaterInput,
} from '@inkling/shared'
import { api, qk } from './api'

// Later list with reminders and followed comment threads (docs/adr/1410-* .. 1413-*). Kept out of
// api.ts like notificationsApi.ts.

export const qkLater = {
  all: ['later'] as const,
  list: (wsId: string, state: 'open' | 'done') => ['later', 'list', wsId, state] as const,
  target: (key: string) => ['later', 'target', key] as const,
  threadsAll: ['threads'] as const,
  threads: (wsId: string, all: boolean) => ['threads', 'list', wsId, all] as const,
  follows: (pageId: string) => ['threads', 'follows', pageId] as const,
}

export type LaterTarget =
  | { kind: 'page'; pageId: string; anchor?: string }
  | { kind: 'thread'; threadId: string }
  | { kind: 'notification'; notificationId: string }
  /** An item already on the list (the Later screen): changes its reminder, never saves anew. */
  | { kind: 'item'; id: string }

export const targetKey = (t: LaterTarget): string =>
  t.kind === 'page'
    ? `page:${t.pageId}`
    : t.kind === 'thread'
      ? `thread:${t.threadId}`
      : t.kind === 'notification'
        ? `notification:${t.notificationId}`
        : `item:${t.id}`

/** The device time zone the reminder was picked in (stored with it; the list shows local time). */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export function useLaterList(wsId: string, state: 'open' | 'done') {
  return useQuery({
    queryKey: qkLater.list(wsId, state),
    queryFn: () => api<LaterListDTO>(`/api/later?workspaceId=${encodeURIComponent(wsId)}&state=${state}`),
    enabled: !!wsId,
    refetchInterval: 60_000,
  })
}

export function useLaterTarget(t: LaterTarget | null) {
  const key = t ? targetKey(t) : ''
  const q = t
    ? t.kind === 'page'
      ? `pageId=${t.pageId}`
      : t.kind === 'thread'
        ? `threadId=${t.threadId}`
        : t.kind === 'notification'
          ? `notificationId=${t.notificationId}`
          : `id=${t.id}`
    : ''
  return useQuery({
    queryKey: qkLater.target(key),
    queryFn: () => api<{ item: LaterItemDTO | null }>(`/api/later/target?${q}`).then((r) => r.item),
    enabled: !!t,
  })
}

export function useSaveLater() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SaveLaterInput) =>
      api<{ item: LaterItemDTO }>('/api/later', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.item),
    onSettled: () => qc.invalidateQueries({ queryKey: qkLater.all }),
  })
}

export function useUpdateLater() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateLaterInput & { id: string }) =>
      api<{ item: LaterItemDTO }>(`/api/later/${id}`, { method: 'PATCH', body: JSON.stringify(input) }).then((r) => r.item),
    onSettled: () => qc.invalidateQueries({ queryKey: qkLater.all }),
  })
}

export function useDeleteLater() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/later/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: qkLater.all }),
  })
}

// --- threads ----------------------------------------------------------------------

export function useThreads(wsId: string, all = false) {
  return useQuery({
    queryKey: qkLater.threads(wsId, all),
    queryFn: () => api<ThreadListDTO>(`/api/threads?workspaceId=${encodeURIComponent(wsId)}${all ? '&all=1' : ''}`),
    enabled: !!wsId,
    refetchInterval: 60_000,
  })
}

export function useThreadFollows(pageId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qkLater.follows(pageId ?? ''),
    queryFn: () => api<{ follows: ThreadFollowDTO[] }>(`/api/pages/${pageId}/thread-follows`).then((r) => r.follows),
    enabled: !!pageId && enabled,
  })
}

export function useFollowThread(pageId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ threadId, following }: { threadId: string; following: boolean }) =>
      api<ThreadFollowDTO>(`/api/threads/${threadId}/follow`, { method: 'PUT', body: JSON.stringify({ following }) }),
    onMutate: ({ threadId, following }) => {
      if (!pageId) return
      qc.setQueryData<ThreadFollowDTO[]>(qkLater.follows(pageId), (old) => {
        const rest = (old ?? []).filter((f) => f.threadId !== threadId)
        return [...rest, { threadId, following, source: 'manual' }]
      })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qkLater.threadsAll }),
  })
}

export function useMarkThreadRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (threadId: string) => api<{ ok: true; notificationsRead: number }>(`/api/threads/${threadId}/read`, { method: 'POST', body: '{}' }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qkLater.threadsAll })
      qc.invalidateQueries({ queryKey: qk.notifications })
    },
  })
}
