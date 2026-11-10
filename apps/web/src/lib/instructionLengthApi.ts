import { useQuery } from '@tanstack/react-query'
import { api, useMemberScope } from '../api'
import type { InstructionLengthsDTO } from './instructionLength'

// The instruction-length route (docs/adr/2004-*, 2021-*); kept out of instructionLength.ts so its
// pure helpers load in node tests without the API client.

export const qkInstructionLengths = (wsId: string) => ['agentInstructionLengths', wsId] as const

/**
 * Sizes of the workspace's instruction pages. Members only (guests see lock lines too, so the query is
 * off for them); fetched when a component that shows an instruction page mounts, so a page that was just
 * edited is measured again when the lock dialog opens.
 */
export function useInstructionLengths(wsId: string | undefined, enabled = true) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qkInstructionLengths(wsId ?? ''),
    queryFn: () => api<InstructionLengthsDTO>(`/api/workspaces/${wsId}/agent-instructions/length`),
    enabled: !!wsId && enabled && member,
    retry: false,
    staleTime: 30_000,
  })
}

