import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentEditLevel, AgentPolicyDTO, AutoAcceptRules } from '@inkling/shared'
import { api } from './api'

// Agent edit policy (direct / auto / review) and auto-accept rules (docs/adr/1544-*, 1545-*):
// the workspace default and the rules of an "auto" lock node.

export const qkAgentPolicy = {
  workspace: (wsId: string) => ['agentPolicy', 'ws', wsId] as const,
  page: (pageId: string) => ['agentPolicy', 'page', pageId] as const,
}

export function useWorkspaceAgentPolicy(wsId: string) {
  return useQuery({
    queryKey: qkAgentPolicy.workspace(wsId),
    queryFn: async () => (await api<{ policy: AgentPolicyDTO }>(`/api/workspaces/${wsId}/agent-policy`)).policy,
    enabled: !!wsId,
  })
}

export function useSetWorkspaceAgentPolicy(wsId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { level: AgentEditLevel; rules: AutoAcceptRules }) =>
      api<{ policy: AgentPolicyDTO }>(`/api/workspaces/${wsId}/agent-policy`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: (r) => qc.setQueryData(qkAgentPolicy.workspace(wsId), r.policy),
  })
}

export function usePageAgentRules(pageId: string, enabled = true) {
  return useQuery({
    queryKey: qkAgentPolicy.page(pageId),
    queryFn: async () => (await api<{ policy: AgentPolicyDTO }>(`/api/pages/${pageId}/agent-rules`)).policy,
    enabled: !!pageId && enabled,
  })
}

export function useSetPageAgentRules(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (rules: AutoAcceptRules) =>
      api<{ policy: AgentPolicyDTO }>(`/api/pages/${pageId}/agent-rules`, { method: 'PUT', body: JSON.stringify({ rules }) }),
    onSuccess: (r) => qc.setQueryData(qkAgentPolicy.page(pageId), r.policy),
  })
}
