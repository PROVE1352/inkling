import { useQuery } from '@tanstack/react-query'
import type { WorkspaceUsageDTO } from '@inkling/shared'
import { api, useAuthMode } from '../../api'

/** GET /api/workspaces/:id/usage (docs/adr/2506-*). */
export function useWorkspaceUsage(wsId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['workspaceUsage', wsId],
    queryFn: () => api<WorkspaceUsageDTO>(`/api/workspaces/${wsId}/usage`),
    enabled: !!wsId && enabled,
    staleTime: 60_000,
  })
}

/** The server set a storage limit (only then can a workspace become read-only for storage). */
export function useStorageLimited(): boolean {
  return useAuthMode().data?.limits?.workspaceStorageMb != null
}

/** Used storage reached the limit: the workspace is read-only until something is deleted. */
export function isStorageFull(u: WorkspaceUsageDTO | undefined): boolean {
  const limit = u?.limits.storageBytes
  return limit != null && u!.storageBytes >= limit
}
