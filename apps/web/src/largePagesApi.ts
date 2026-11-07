import { useQuery } from '@tanstack/react-query'
import type { LargePagesDTO, PageSizeDTO } from '@inkling/shared'
import { api } from './api'

// "Large page" notice and the workspace list (docs/adr/1103-*). Kept out of api.ts like sidebarApi.ts.

export const qkLargePages = {
  size: (pageId: string) => ['pageSize', pageId] as const,
  list: (wsId: string) => ['largePages', wsId] as const,
}

/** Size facts of one page (cheap: two column reads on the server). Refreshed at most every 5 minutes. */
export function usePageSize(pageId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qkLargePages.size(pageId ?? ''),
    queryFn: () => api<PageSizeDTO>(`/api/pages/${pageId}/size`),
    enabled: !!pageId && enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Large pages of a workspace (owners and admins). */
export function useLargePages(wsId: string) {
  return useQuery({
    queryKey: qkLargePages.list(wsId),
    queryFn: () => api<LargePagesDTO>(`/api/workspaces/${wsId}/large-pages`),
    enabled: !!wsId,
    staleTime: 60_000,
    retry: false,
  })
}

/** Human size: 1.2 MB, 830 KB. */
export function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** Rounded token count: 52k, 1.2M. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// Dismissed notices, per page, on this device (docs/adr/1103-*). A bounded list; storage can be
// missing (private window) or throw, and the notice then simply shows again.
const DISMISS_KEY = 'inkling-large-page-dismissed'
const MAX_DISMISSED = 200

function readDismissed(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(DISMISS_KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function isLargeNoticeDismissed(pageId: string): boolean {
  return readDismissed().includes(pageId)
}

export function dismissLargeNotice(pageId: string): void {
  try {
    const next = [pageId, ...readDismissed().filter((id) => id !== pageId)].slice(0, MAX_DISMISSED)
    globalThis.localStorage?.setItem(DISMISS_KEY, JSON.stringify(next))
  } catch {
    // not persisted: the notice comes back on the next visit
  }
}
