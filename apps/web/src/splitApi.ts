import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PageRotationDTO, SetRotationInput, SplitPlanDTO } from '@inkling/shared'
import { api, qk } from './api'
import { qkLargePages } from './largePagesApi'

// Splitting a page into subpages and automatic splitting (docs/adr/1140-*, 1141-*). Kept out of
// api.ts like largePagesApi.ts.

export const qkSplit = {
  preview: (pageId: string, level: number) => ['splitPreview', pageId, level] as const,
  rotation: (pageId: string) => ['pageRotation', pageId] as const,
}

/** What a split at `level` would create (nothing is written). */
export function useSplitPreview(pageId: string, level: number, enabled: boolean) {
  return useQuery({
    queryKey: qkSplit.preview(pageId, level),
    queryFn: () =>
      api<SplitPlanDTO>(`/api/pages/${pageId}/split`, { method: 'POST', body: JSON.stringify({ level, preview: true }) }),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

export function useSplitPage(wsId: string, pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { level: number; sections: string[] }) =>
      api<SplitPlanDTO>(`/api/pages/${pageId}/split`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      void qc.invalidateQueries({ queryKey: qkLargePages.size(pageId) })
      void qc.invalidateQueries({ queryKey: ['splitPreview', pageId] })
    },
  })
}

export function usePageRotation(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: qkSplit.rotation(pageId),
    queryFn: () => api<PageRotationDTO>(`/api/pages/${pageId}/rotation`),
    enabled,
    retry: false,
  })
}

export function useSetRotation(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SetRotationInput) =>
      api<PageRotationDTO>(`/api/pages/${pageId}/rotation`, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (data) => qc.setQueryData(qkSplit.rotation(pageId), data),
  })
}
