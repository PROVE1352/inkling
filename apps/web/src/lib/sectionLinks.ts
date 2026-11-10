import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { QueryClient } from '@tanstack/react-query'
import { parseSectionFragment, type SectionRef } from '@inkling/shared/sectionLink'
import { api } from '../api'
import { t } from '../i18n'
import { toast } from './toast'
import { findHeadingBlock, type BlockLike } from './sectionLinkMatch'

// Section links `[[Page#Heading]]` in the web app (docs/adr/2100-*, 2102-*).
//
// - The `[[Page#` autocomplete lists the target page's section headings (GET /pages/:id/headings).
// - Opening a section link (`/w/<ws>/p/<page>#h=…&b=…`): the editor looks for the heading block id
//   in the document, then a heading with the link's text, then asks the server (the change log knows
//   renames, GET /pages/:id/section-link). Found → the `?block=<id>` jump that tasks and search use
//   (open folds, scroll, flash); not found → the page stays at the top and a toast says so.

export interface PageHeading {
  blockId: string
  text: string
  level: number
  anchor: string
}

export const headingsKey = (pageId: string) => ['pageHeadings', pageId] as const

/** The page's section headings, cached for 30 s (the autocomplete asks per keystroke). */
export function fetchHeadings(qc: QueryClient, pageId: string): Promise<PageHeading[]> {
  return qc.fetchQuery({
    queryKey: headingsKey(pageId),
    queryFn: () => api<{ headings: PageHeading[] }>(`/api/pages/${pageId}/headings`).then((r) => r.headings),
    staleTime: 30_000,
  })
}

/** The server's answer for a heading the document does not have under the link's id or name. */
async function resolveRemote(pageId: string, ref: SectionRef): Promise<string | null> {
  const q = new URLSearchParams({ heading: ref.heading })
  if (ref.blockId) q.set('block', ref.blockId)
  try {
    const r = await api<{ status: string; blockId: string | null }>(`/api/pages/${pageId}/section-link?${q}`)
    return r.status !== 'missing' ? r.blockId : null
  } catch {
    return null // guests, a page gone meanwhile: treated as not found
  }
}

/**
 * Follows a section link's fragment once the document is synced: replaces `#h=…` with `?block=<id>`
 * (CollabEditor's jump) or tells that the heading was not found. The fragment is removed either way,
 * so clicking the same link again jumps again.
 */
export function useSectionLinkJump(pageId: string, synced: boolean, getDocument: () => BlockLike[]): void {
  const location = useLocation()
  const navigate = useNavigate()
  const ref = parseSectionFragment(location.hash)
  const key = ref ? `${ref.blockId ?? ''}\u0000${ref.heading}` : ''
  useEffect(() => {
    if (!synced || !ref) return
    let cancelled = false
    const go = (blockId: string | null) => {
      if (cancelled) return
      const search = new URLSearchParams(location.search)
      if (blockId) search.set('block', blockId)
      navigate({ pathname: location.pathname, search: search.toString() ? `?${search}` : '', hash: '' }, { replace: true })
      if (!blockId) toast({ message: t('sectionLink.notFound', { heading: ref.heading }) })
    }
    const local = findHeadingBlock(getDocument(), ref)
    if (local) go(local)
    else void resolveRemote(pageId, ref).then(go)
    return () => {
      cancelled = true
    }
    // the fragment (key) is the trigger; location fields are read when it fires
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, key, pageId])
}
