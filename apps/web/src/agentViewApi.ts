import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from './api'

// "What an agent reads" (docs/adr/2389-*): the three REST routes an agent's find_context and
// read_page tools call (server routes/context.ts), read here with the session cookie. Response types
// are local on purpose: the shared package does not describe these answers and this screen only reads
// the fields below. Every hook runs only while the dialog is open.

export interface AgentOutlineSection {
  anchor: string
  headingPath: string
  level: number
  tokens: number
  version: string
}

export interface AgentOutline {
  page: { id: string; title: string; kind: string; workspaceId: string; updatedAt?: string }
  sections: AgentOutlineSection[]
  tokens: number
}

export interface AgentSection {
  section: { anchor: string; headingPath: string; level: number; version: string }
  markdown: string
  truncated: boolean
  totalChars: number
}

export interface AgentContextFragment {
  pageId: string
  workspaceId: string
  title: string
  anchor: string
  headingPath: string
  sections: { anchor: string; version: string; short: string; heading: string }[]
  tokens: number
  truncated: boolean
  fullTokens?: number
}

export interface AgentContextResult {
  fragments: AgentContextFragment[]
  more: { pageId: string; title: string; anchor: string; tokens: number }[]
  titleOnly: { pageId: string; title: string; kind: string }[]
  budget: number
  usedTokens: number
  candidates: number
}

/** Longest section text shown in the dialog; the rest is counted, not drawn. */
export const AGENT_SECTION_MAX_CHARS = 20_000

export const qkAgentView = {
  outline: (pageId: string) => ['agentView', 'outline', pageId] as const,
  section: (pageId: string, anchor: string) => ['agentView', 'section', pageId, anchor] as const,
  context: (wsId: string, q: string) => ['agentView', 'context', wsId, q] as const,
}

/** The page's sections with their token estimates; read again every time the dialog opens. */
export function useAgentOutline(pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: qkAgentView.outline(pageId),
    queryFn: () => api<AgentOutline>(`/api/pages/${pageId}/outline`),
    enabled: enabled && !!pageId,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/** One section as the Markdown an agent receives; null anchor = nothing expanded. */
export function useAgentSection(pageId: string, anchor: string | null, version?: string) {
  return useQuery({
    queryKey: [...qkAgentView.section(pageId, anchor ?? ''), version ?? ''],
    queryFn: () =>
      api<AgentSection>(
        `/api/pages/${pageId}/section?ref=${encodeURIComponent(anchor ?? '')}&maxChars=${AGENT_SECTION_MAX_CHARS}`,
      ),
    enabled: !!pageId && !!anchor,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/** What find_context returns for `q` in this workspace, with the default budget (as the MCP tool). */
export function useAgentContext(wsId: string, q: string, enabled: boolean) {
  const query = q.trim()
  return useQuery({
    queryKey: qkAgentView.context(wsId, query),
    queryFn: () =>
      api<AgentContextResult>(`/api/context?q=${encodeURIComponent(query)}&workspaceId=${encodeURIComponent(wsId)}`),
    enabled: enabled && !!wsId && query.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    retry: false,
  })
}
