import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PageVerificationStatusDTO, VerifiedListDTO, VerifyPageInput } from '@inkling/shared'
import { api } from './api'

// Page verification (docs/adr/1840-*). Kept out of api.ts like laterApi.ts.

export const qkVerify = {
  all: ['verify'] as const,
  page: (pageId: string) => ['verify', 'page', pageId] as const,
  list: (wsId: string, mine: boolean) => ['verify', 'list', wsId, mine] as const,
}

export function usePageVerification(pageId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qkVerify.page(pageId ?? ''),
    queryFn: () => api<PageVerificationStatusDTO>(`/api/pages/${pageId}/verification`),
    enabled: !!pageId && enabled,
    // the expiry is compared on the server clock; a page left open re-reads it now and then
    staleTime: 60_000,
    refetchInterval: 10 * 60_000,
  })
}

export function useVerifiedList(wsId: string | undefined, mine = false) {
  return useQuery({
    queryKey: qkVerify.list(wsId ?? '', mine),
    queryFn: () => api<VerifiedListDTO>(`/api/workspaces/${wsId}/verified${mine ? '?mine=1' : ''}`),
    enabled: !!wsId,
  })
}

export function useVerifyPage(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: VerifyPageInput | null) =>
      input
        ? api<PageVerificationStatusDTO>(`/api/pages/${pageId}/verification`, { method: 'POST', body: JSON.stringify(input) })
        : api<PageVerificationStatusDTO>(`/api/pages/${pageId}/verification`, { method: 'DELETE' }),
    onSuccess: (data) => {
      qc.setQueryData(qkVerify.page(pageId), data)
      void qc.invalidateQueries({ queryKey: ['verify', 'list'] })
    },
  })
}
