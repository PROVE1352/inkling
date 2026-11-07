import { useQuery } from '@tanstack/react-query'
import type { PublicPageDTO, PublicTreeNodeDTO } from '@inkling/shared'
import { api } from '../api'

// Client hooks/utilities for folder sharing (public folders) only. Kept out of api.ts so it doesn't overlap other work.

// Body of a page under a folder token (unauthenticated). ref is an opaque id issued by the server.
// Outside the subtree / trashed / private / missing → 404 → error. Never retry on 4xx.
export function usePublicChildPage(token: string | undefined, ref: string | undefined) {
  return useQuery({
    queryKey: ['public', token ?? '', 'p', ref ?? ''] as const,
    queryFn: () => api<PublicPageDTO>(`/api/public/${token}/p/${ref}`),
    enabled: !!token && !!ref,
    retry: false,
    staleTime: 30_000,
  })
}

/** Finds the ref node and its ancestor ref path in the tree (null when absent). */
export function findTreePath(
  nodes: PublicTreeNodeDTO[],
  ref: string,
  trail: PublicTreeNodeDTO[] = [],
): PublicTreeNodeDTO[] | null {
  for (const n of nodes) {
    const next = [...trail, n]
    if (n.ref === ref) return next
    const hit = findTreePath(n.children, ref, next)
    if (hit) return hit
  }
  return null
}

/** Number of viewable (doc/collection) nodes. */
export function countReadable(nodes: PublicTreeNodeDTO[]): number {
  let c = 0
  for (const n of nodes) {
    if (n.kind === 'doc' || n.kind === 'collection') c++
    c += countReadable(n.children)
  }
  return c
}
