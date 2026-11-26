import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentPendingWorkspaceDTO } from '@inkling/shared'
import { api, qk } from './api'

// Workspaces someone else added me to that my agent connections do not see yet, and including one
// (docs/adr/2580-*). Browser sessions only on the server.

export const agentPendingKey = ['agentPendingWorkspaces'] as const

export function useAgentPendingWorkspaces() {
  return useQuery({
    queryKey: agentPendingKey,
    queryFn: () => api<{ workspaces: AgentPendingWorkspaceDTO[] }>('/api/me/agent-pending-workspaces').then((r) => r.workspaces),
  })
}

export function useIncludeForAgents() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (workspaceId: string) =>
      api<{ workspaceId: string }>(`/api/workspaces/${workspaceId}/agent-include`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentPendingKey })
      void qc.invalidateQueries({ queryKey: qk.notifications })
    },
  })
}
