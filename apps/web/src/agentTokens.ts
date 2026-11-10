import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccessRange, AgentTokenDTO, CreateAgentTokenInput, CreatedAgentTokenDTO, SuggestOnlyDTO } from '@inkling/shared'
import { api } from './api'

// Agent connection tokens (docs/adr/2060-*) and lifting a connection's suggest-only state (docs/adr/2042-*)
// on Settings › Connections.

const send = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) })

export function useAgentTokens() {
  return useQuery({
    queryKey: ['agentTokens'] as const,
    queryFn: () => api<{ tokens: AgentTokenDTO[] }>('/api/agent-tokens').then((r) => r.tokens),
  })
}

export function useCreateAgentToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateAgentTokenInput) => api<CreatedAgentTokenDTO>('/api/agent-tokens', send('POST', input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agentTokens'] }),
  })
}

export function useRevokeAgentToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/agent-tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agentTokens'] }),
  })
}

/** An agent connection token is a grant: its range changes through the grant route. */
export function useUpdateAgentTokenRange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, range }: { id: string; range: AccessRange }) =>
      api<{ ok: true }>(`/api/oauth/grants/${id}`, send('PATCH', { range })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agentTokens'] }),
  })
}

/** The connection's owner lifts its suggest-only state everywhere: `grant:<id>` or `token:<id>`. */
export function useReleaseConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (connection: string) =>
      api<{ released: number; suggestOnly: SuggestOnlyDTO | null }>('/api/connections/release', send('POST', { connection })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agentTokens'] })
      void qc.invalidateQueries({ queryKey: ['oauth', 'grants'] })
      void qc.invalidateQueries({ queryKey: ['apiTokens'] })
    },
  })
}
