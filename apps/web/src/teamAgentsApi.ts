import { useQuery } from '@tanstack/react-query'
import { agentPropKey, agentRefOfCell } from '@inkling/shared'
import type { TeamAgentsDTO, WorkspaceConnectionDTO } from '@inkling/shared'
import { api, useMemberScope } from './api'

// Team agents (docs/adr/1860-* .. 1866-*): the members' live agent connections (mention and assignee
// pickers) and the workspace board. Kept out of api.ts like suggestionsApi.ts.

export const qkTeamAgents = {
  connections: (wsId: string) => ['agentConnections', wsId] as const,
  board: (wsId: string, since: string) => ['teamAgents', wsId, since] as const,
}

/** Live connections of the workspace's members ("Bob · Claude Code"). Members only; empty for guests. */
export function useAgentConnections(wsId: string | undefined) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qkTeamAgents.connections(wsId ?? ''),
    queryFn: () => api<{ connections: WorkspaceConnectionDTO[] }>(`/api/workspaces/${wsId}/agent-connections`).then((r) => r.connections),
    enabled: !!wsId && member,
    staleTime: 60_000,
  })
}

/** Start of today in the viewer's time zone (what the board calls "today"). */
export function startOfToday(now = new Date()): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function useTeamAgents(wsId: string | undefined, since: string) {
  const member = useMemberScope(wsId)
  return useQuery({
    queryKey: qkTeamAgents.board(wsId ?? '', since),
    queryFn: () => api<TeamAgentsDTO>(`/api/workspaces/${wsId}/team-agents?since=${encodeURIComponent(since)}`),
    enabled: !!wsId && member,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}

/** "Bob · Claude Code" — the label a chip or a cell shows for a person's connection. */
export function connectionLabel(c: Pick<WorkspaceConnectionDTO, 'userName' | 'client'>): string {
  return `${c.userName} · ${c.client}`
}

/** The live connection a person cell is assigned to (null when none, gone, or not the cell's person). */
export function cellAgent(
  props: Record<string, unknown> | undefined,
  fieldId: string,
  connections: WorkspaceConnectionDTO[] | undefined,
): WorkspaceConnectionDTO | null {
  const ref = agentRefOfCell(props, fieldId)
  if (!ref || !connections) return null
  return connections.find((c) => c.key === ref.connection && c.userId === ref.userId) ?? null
}

export { agentPropKey }
