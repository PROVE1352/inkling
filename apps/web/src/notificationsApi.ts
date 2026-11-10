import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ActivityPageDTO,
  ChangeDiffDTO,
  EmailDigestMode,
  NotificationLevel,
  NotificationSettingsDTO,
  PageProvenanceDTO,
  PageSubscriptionDTO,
  SetPageSubscriptionInput,
  SnapshotDiffDTO,
} from '@inkling/shared'
import { api, qk, useMemberScope } from './api'

// Notification settings, page subscriptions ("follow"), the workspace activity screen, diffs and
// the AI provenance badge (docs/adr/1000-* .. 1006-*). Kept out of api.ts like templatesApi.ts.

export const qkNotif = {
  settings: ['notificationSettings'] as const,
  pageSub: (pageId: string) => ['pageSubscription', pageId] as const,
  activity: (wsId: string, filters: ActivityFilters) => ['activity', wsId, filters] as const,
  changeDiff: (seq: string) => ['changeDiff', seq] as const,
  snapshotDiff: (pageId: string, sid: string, against: string) => ['snapshotDiff', pageId, sid, against] as const,
  provenance: (pageId: string) => ['pageProvenance', pageId] as const,
}

function put(data: unknown): RequestInit {
  return { method: 'PUT', body: JSON.stringify(data) }
}

// ---------------------------------------------------------------------------
// Settings → Notifications
// ---------------------------------------------------------------------------

export function useNotificationSettings() {
  return useQuery({
    queryKey: qkNotif.settings,
    queryFn: () => api<NotificationSettingsDTO>('/api/me/notification-settings'),
  })
}

export function useUpdateNotificationSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { emailInstant?: boolean; emailDigest?: EmailDigestMode; threadAutoFollow?: boolean; threadReplies?: boolean; agentHandoffCopy?: boolean }) =>
      api<NotificationSettingsDTO | void>('/api/me/notification-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    // Optimistic: the toggle/select flips at once; a failure refetches the server state.
    onMutate: (input) => {
      qc.setQueryData<NotificationSettingsDTO>(qkNotif.settings, (old) => (old ? { ...old, ...input } : old))
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qkNotif.settings }),
  })
}

// ---------------------------------------------------------------------------
// Page subscription
// ---------------------------------------------------------------------------

export function usePageSubscription(pageId: string | undefined, enabled = true) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qkNotif.pageSub(pageId ?? ''),
    queryFn: () => api<PageSubscriptionDTO>(`/api/pages/${pageId}/subscription`),
    enabled: enabled && !!pageId && member,
  })
}

/** PUT /pages/:id/subscription — level null removes my row (inherit again). */
export function useSetPageSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ pageId, input }: { pageId: string; input: SetPageSubscriptionInput }) =>
      api<PageSubscriptionDTO>(`/api/pages/${pageId}/subscription`, put(input)),
    onSuccess: (r, { pageId }) => {
      // The PUT answers with the new state of this page.
      if (r && typeof r === 'object' && 'effective' in r) qc.setQueryData(qkNotif.pageSub(pageId), r)
      qc.invalidateQueries({ queryKey: qkNotif.settings })
      // Subpages inherit from this row, so cached answers for them may be stale too.
      qc.invalidateQueries({ queryKey: ['pageSubscription'] })
    },
  })
}

/** PUT /workspaces/:id/notification-level — my default for the whole workspace. */
export function useSetWorkspaceNotificationLevel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      workspaceId,
      level,
      agentDigest,
    }: {
      workspaceId: string
      level: NotificationLevel
      agentDigest?: boolean
    }) => api<unknown>(`/api/workspaces/${workspaceId}/notification-level`, put({ level, agentDigest })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkNotif.settings })
      qc.invalidateQueries({ queryKey: ['pageSubscription'] })
      qc.invalidateQueries({ queryKey: qk.notifications })
    },
  })
}

// ---------------------------------------------------------------------------
// Activity screen
// ---------------------------------------------------------------------------

export interface ActivityFilters {
  actor: 'any' | 'human' | 'ai'
  via: string
  userId: string
  rootId: string
  kind: 'any' | 'edit' | 'page'
  aiPagesOnly: boolean
}

export const DEFAULT_ACTIVITY_FILTERS: ActivityFilters = {
  actor: 'any',
  via: '',
  userId: '',
  rootId: '',
  kind: 'any',
  aiPagesOnly: false,
}

/** Query string for GET /workspaces/:id/activity (empty filters are left out). */
export function activityQueryString(f: ActivityFilters, before?: string | null, limit = 50): string {
  const p = new URLSearchParams()
  if (before) p.set('before', before)
  p.set('limit', String(limit))
  if (f.actor !== 'any') p.set('actor', f.actor)
  if (f.via) p.set('via', f.via)
  if (f.userId) p.set('userId', f.userId)
  if (f.rootId) p.set('rootId', f.rootId)
  if (f.kind !== 'any') p.set('kind', f.kind)
  if (f.aiPagesOnly) p.set('aiPagesOnly', '1')
  return p.toString()
}

export function useActivity(wsId: string, filters: ActivityFilters) {
  return useInfiniteQuery({
    queryKey: qkNotif.activity(wsId, filters),
    queryFn: ({ pageParam }) =>
      api<ActivityPageDTO>(`/api/workspaces/${wsId}/activity?${activityQueryString(filters, pageParam)}`),
    initialPageParam: null as string | null,
    // seq is a bigint string — passed through as-is, never converted to a number.
    getNextPageParam: (last) => last.next,
    enabled: !!wsId,
  })
}

export function useChangeDiff(seq: string | null) {
  return useQuery({
    queryKey: qkNotif.changeDiff(seq ?? ''),
    queryFn: () => api<ChangeDiffDTO>(`/api/changes/${seq}/diff`),
    enabled: !!seq,
    staleTime: Infinity,
  })
}

/** Snapshot diff against the current document or another snapshot. */
export function useSnapshotDiff(pageId: string, sid: string | null, against: 'current' | string = 'current') {
  return useQuery({
    queryKey: qkNotif.snapshotDiff(pageId, sid ?? '', against),
    queryFn: () =>
      api<SnapshotDiffDTO>(
        `/api/pages/${pageId}/snapshots/${sid}/diff?against=${encodeURIComponent(against)}`,
      ),
    enabled: !!pageId && !!sid,
    // "current" moves while the page is edited; snapshot-to-snapshot never changes.
    staleTime: against === 'current' ? 0 : Infinity,
  })
}

// ---------------------------------------------------------------------------
// Provenance badge
// ---------------------------------------------------------------------------

export function usePageProvenance(pageId: string | undefined, enabled = true) {
  const member = useMemberScope()
  return useQuery({
    queryKey: qkNotif.provenance(pageId ?? ''),
    queryFn: () => api<PageProvenanceDTO>(`/api/pages/${pageId}/provenance`),
    enabled: enabled && !!pageId && member,
    staleTime: 60_000,
  })
}
