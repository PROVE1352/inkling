import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_SIDEBAR_PREFS, type SidebarPrefsDTO } from '@inkling/shared'
import { api, qk, useMe, type MeDTO } from './api'
import { t } from './i18n'
import { toast } from './lib/toast'

// Sidebar menu order / hidden menus, stored per user on the server (docs/adr/1020-*).
// Kept out of api.ts like notificationsApi.ts.

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Keyed by user: signing in as someone else in the same tab must not show the previous person's sidebar.
export const qkSidebar = (userId: string) => ['sidebarPrefs', userId] as const
const SAVE_KEY = ['saveSidebarPrefs'] as const

/**
 * The saved preference. Seeded from /auth/me (already loaded before the app renders, so the first
 * paint is in the saved order), then refreshed when the window regains focus so a change made on
 * another device shows up without a reload.
 */
export function useSidebarPrefs(): SidebarPrefsDTO {
  const qc = useQueryClient()
  const userId = useMe().data?.id ?? ''
  const q = useQuery({
    queryKey: qkSidebar(userId),
    queryFn: () => api<SidebarPrefsDTO>('/api/me/sidebar'),
    initialData: () => {
      const me = qc.getQueryData<MeDTO>(qk.me)
      return me?.id === userId ? me.sidebar : undefined
    },
    initialDataUpdatedAt: () => qc.getQueryState(qk.me)?.dataUpdatedAt,
    staleTime: 30_000,
    // Always on focus (not only when stale): coming back from another device is exactly when it changed.
    refetchOnWindowFocus: 'always',
    enabled: !!userId,
  })
  return q.data ?? DEFAULT_SIDEBAR_PREFS
}

/**
 * PUT /me/sidebar with the whole value. Optimistic: the sidebar changes at once. Saves run one at a
 * time (mutation scope) and each sends the full value, so the last one wins on the server. A failed
 * save is undone only while the cache still holds the value it wrote (a later edit owns it otherwise),
 * and a toast says so.
 */
export function useSaveSidebarPrefs() {
  const qc = useQueryClient()
  const key = qkSidebar(useMe().data?.id ?? '')
  return useMutation({
    mutationKey: SAVE_KEY,
    scope: { id: 'sidebarPrefs' },
    mutationFn: (next: SidebarPrefsDTO) =>
      api<SidebarPrefsDTO>('/api/me/sidebar', { method: 'PUT', body: JSON.stringify(next) }),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<SidebarPrefsDTO>(key)
      qc.setQueryData<SidebarPrefsDTO>(key, next)
      return { prev, next }
    },
    onError: (_err, _next, ctx) => {
      if (ctx && sameValue(qc.getQueryData(key), ctx.next)) {
        qc.setQueryData<SidebarPrefsDTO>(key, ctx.prev ?? DEFAULT_SIDEBAR_PREFS)
      }
      toast({ message: t('sidebarSettings.saveFailed') })
    },
    onSettled: () => {
      // Only the last save in a burst refetches; earlier ones would briefly show an older state.
      if (qc.isMutating({ mutationKey: SAVE_KEY }) <= 1) qc.invalidateQueries({ queryKey: key })
    },
  })
}
