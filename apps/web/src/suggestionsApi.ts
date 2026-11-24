import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import type { PageSuggestionsDTO, SuggestionDTO } from '@inkling/shared'
import { api, pollingQuery, useMemberScope } from './api'
import { createNoticeRefresher } from './lib/pageNotices'

// Suggested edits from agents and section claims of one page (docs/adr/1530-* .. 1536-*).
// Polled like comments (conditional GET); kept out of api.ts like largePagesApi.ts.
// The server also sends {t:'suggestions'} on the page's collab document whenever a claim or a
// suggestion of the page changes (docs/adr/2556-*): read again at once instead of at the next poll.
// The poll and the focus refetch stay for a closed socket.

export const qkSuggestions = {
  page: (pageId: string) => ['pageSuggestions', pageId] as const,
  history: (pageId: string) => ['pageSuggestions', pageId, 'all'] as const,
}

/** Every suggestion of the page with its outcome (accepted by whom or by which rule, rejected, withdrawn). */
export function usePageSuggestionHistory(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: qkSuggestions.history(pageId),
    queryFn: () => api<PageSuggestionsDTO>(`/api/pages/${pageId}/suggestions?all=1`),
    enabled: !!pageId && enabled,
  })
}

/** Notices closer than this become one read (a batch of suggestions, accept + release, ...). */
export const SUGGESTIONS_NOTICE_DELAY_MS = 200

const refreshers = new WeakMap<QueryClient, (pageId: string) => () => void>()
function watchSuggestionNotices(queryClient: QueryClient, pageId: string): () => void {
  let watch = refreshers.get(queryClient)
  if (!watch) {
    // the history query shares the prefix and refreshes too
    watch = createNoticeRefresher('suggestions', (id) => void queryClient.invalidateQueries({ queryKey: qkSuggestions.page(id) }), SUGGESTIONS_NOTICE_DELAY_MS)
    refreshers.set(queryClient, watch)
  }
  return watch(pageId)
}

/** Open suggestions (with their diff against the current text) and live claims of a page. */
export function usePageSuggestions(pageId: string | undefined) {
  const queryClient = useQueryClient()
  const member = useMemberScope()
  useEffect(() => {
    if (!pageId || !member) return
    return watchSuggestionNotices(queryClient, pageId)
  }, [queryClient, pageId, member])
  return useQuery({
    ...pollingQuery<PageSuggestionsDTO>(queryClient, qkSuggestions.page(pageId ?? ''), `/api/pages/${pageId}/suggestions?preview=1`),
    enabled: !!pageId && member,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/**
 * Accept (optionally confirming that the section changed since the agent read it) or reject.
 * `hunks` + `mergeKey`: apply only the chosen hunks of a replace (3-way, docs/adr/1621-*).
 */
export function useDecideSuggestion(pageId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; decision: 'accept' | 'reject'; confirmChanged?: boolean; hunks?: number[]; mergeKey?: string }) =>
      api<{ suggestion: SuggestionDTO }>(`/api/suggestions/${v.id}/${v.decision}`, {
        method: 'POST',
        body: JSON.stringify(
          v.decision !== 'accept'
            ? {}
            : v.hunks
              ? { hunks: v.hunks, mergeKey: v.mergeKey }
              : v.confirmChanged
                ? { confirmChanged: true }
                : {},
        ),
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qkSuggestions.page(pageId) }),
    // the history query shares the prefix and refreshes too
  })
}
