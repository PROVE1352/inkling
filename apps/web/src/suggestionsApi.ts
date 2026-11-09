import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PageSuggestionsDTO, SuggestionDTO } from '@inkling/shared'
import { api, pollingQuery, useMemberScope } from './api'

// Suggested edits from agents and section claims of one page (docs/adr/1530-* .. 1536-*).
// Polled like comments (conditional GET); kept out of api.ts like largePagesApi.ts.

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

/** Open suggestions (with their diff against the current text) and live claims of a page. */
export function usePageSuggestions(pageId: string | undefined) {
  const queryClient = useQueryClient()
  const member = useMemberScope()
  return useQuery({
    ...pollingQuery<PageSuggestionsDTO>(queryClient, qkSuggestions.page(pageId ?? ''), `/api/pages/${pageId}/suggestions?preview=1`),
    enabled: !!pageId && member,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** Accept (optionally confirming that the section changed since the agent read it) or reject. */
export function useDecideSuggestion(pageId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; decision: 'accept' | 'reject'; confirmChanged?: boolean }) =>
      api<{ suggestion: SuggestionDTO }>(`/api/suggestions/${v.id}/${v.decision}`, {
        method: 'POST',
        body: JSON.stringify(v.decision === 'accept' && v.confirmChanged ? { confirmChanged: true } : {}),
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qkSuggestions.page(pageId) }),
    // the history query shares the prefix and refreshes too
  })
}
