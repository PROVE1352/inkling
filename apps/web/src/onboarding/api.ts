import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  OnboardingClientEvent,
  OnboardingDTO,
  OnboardingItemId,
  SamplePageResultDTO,
  UpdateOnboardingInput,
} from '@inkling/shared'
import { api, qk, useMe } from '../api'

// Onboarding state per person on the server (docs/adr/2380-*). Kept out of api.ts like sidebarApi.ts.
// Offline or unanswered: the query fails at once (networkMode 'always', no retry) and every caller
// treats a missing answer as "show nothing", so a start without the server is never blocked by it.

export const qkOnboarding = (userId: string) => ['onboarding', userId] as const

// What the last answer said, for noteOnboarding() calls from the editor (no hook there).
let latest: OnboardingDTO | null = null
let latestKey: readonly unknown[] | null = null
let client: QueryClient | null = null
const sent = new Set<string>()

/** The person's onboarding, or null while unknown, offline, turned off by the server or failed. */
export function useOnboarding(): OnboardingDTO | null {
  const qc = useQueryClient()
  const userId = useMe().data?.id ?? ''
  const key = qkOnboarding(userId)
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<OnboardingDTO>('/api/me/onboarding'),
    enabled: !!userId,
    staleTime: 30_000,
    retry: false,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
  })
  useEffect(() => {
    client = qc
    if (q.data) {
      latest = q.data
      latestKey = key
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, qc])
  return q.data?.enabled ? q.data : null
}

export function useUpdateOnboarding() {
  const qc = useQueryClient()
  const key = qkOnboarding(useMe().data?.id ?? '')
  return useMutation({
    networkMode: 'always',
    mutationFn: (body: UpdateOnboardingInput) =>
      api<OnboardingDTO>('/api/me/onboarding', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (dto) => qc.setQueryData(key, dto),
  })
}

export function useCreateSample() {
  const qc = useQueryClient()
  const userId = useMe().data?.id ?? ''
  return useMutation({
    networkMode: 'always',
    mutationFn: (workspaceId: string) =>
      api<SamplePageResultDTO>('/api/me/onboarding/sample', { method: 'POST', body: JSON.stringify({ workspaceId }) }),
    onSuccess: (r) => {
      qc.setQueryData<OnboardingDTO>(qkOnboarding(userId), (d) => (d ? { ...d, samples: { ...d.samples, [r.workspaceId]: r.pageId } } : d))
      void qc.invalidateQueries({ queryKey: qk.pages(r.workspaceId) })
      void qc.invalidateQueries({ queryKey: qkOnboarding(userId) })
    },
  })
}

/** Whether the open checklist still waits for this item (so a browser event is worth sending). */
export function wantsItem(dto: OnboardingDTO | null, id: OnboardingItemId): boolean {
  return !!dto?.enabled && !dto.checklist.dismissed && dto.checklist.items.some((i) => i.id === id && !i.done)
}

/**
 * Record something only the browser sees (slash menu opened, link inserted from the [[ menu, MCP
 * address copied, someone else's page opened, app installed). Cheap enough for a keystroke handler:
 * nothing is sent unless the open checklist still waits for that item, and each event at most once
 * per page load.
 */
export function noteOnboarding(event: OnboardingClientEvent): void {
  if (sent.has(event) || !wantsItem(latest, event)) return
  sent.add(event)
  const key = latestKey
  void api<OnboardingDTO>('/api/me/onboarding', { method: 'PATCH', body: JSON.stringify({ event }) }).then(
    (dto) => {
      latest = dto
      if (client && key) client.setQueryData(key, dto)
    },
    () => sent.delete(event),
  )
}

/** Ask the host (onboarding/Host.tsx) to play the intro, e.g. from Settings or the card. */
export const INTRO_EVENT = 'inkling:intro'
export function playIntro(): void {
  window.dispatchEvent(new Event(INTRO_EVENT))
}
