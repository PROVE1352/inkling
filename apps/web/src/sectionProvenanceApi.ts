import { useQuery } from '@tanstack/react-query'
import type { SectionProvenanceResponseDTO } from '@inkling/shared'
import { api } from './api'
import { useIsGuest } from './lib/useGuest'

// Section marks (docs/adr/1627-*): the newest logged change of each section of a page. The key
// sits under ['pageChanges', pageId], so a revert (useRunRevert invalidates ['pageChanges'])
// refreshes the marks too. The change log is filled by a consumer (about a second after a server
// write, 8–30 s after live typing), so the marks poll every 30 s and refresh on focus; SectionMarkers
// also refreshes them when a suggestion is decided and when a mark is opened.

export const qkSectionProvenance = (pageId: string) => ['pageChanges', pageId, 'sections'] as const

export function useSectionProvenance(pageId: string) {
  const guest = useIsGuest()
  return useQuery({
    queryKey: qkSectionProvenance(pageId),
    queryFn: () => api<SectionProvenanceResponseDTO>(`/api/pages/${pageId}/section-provenance`),
    enabled: !!pageId && !guest,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}
