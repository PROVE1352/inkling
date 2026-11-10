import { z } from 'zod'

/**
 * Suggest-only connections after flagged content (docs/adr/2040-* .. 2043-*).
 *
 * A connection (OAuth/MCP grant or personal API token) that was handed content the injection
 * heuristics flagged (docs/adr/0977-*) writes only as suggestions for TAINT_WINDOW_MINUTES after
 * the last such read, in every workspace that keeps the rule on (the default). Other writes are
 * refused with 403 CONNECTION_SUGGEST_ONLY; comments, claims and the connection's own bookkeeping
 * keep working. A person lifts it early: the connection's owner everywhere, a workspace owner/admin
 * for the content of their workspace.
 */
export const TAINT_WINDOW_MINUTES = 60

/** Error code of a write refused because the connection is suggest-only. */
export const CONNECTION_SUGGEST_ONLY = 'CONNECTION_SUGGEST_ONLY'

/** "This connection is suggest-only right now" (connection lists, team agents board). */
export interface SuggestOnlyDTO {
  /** End of the window (ISO), unless a person lifts it first or the connection reads flagged content again. */
  until: string
  /** Pages and files whose flagged content keeps it suggest-only (unreleased, inside the window). */
  sources: number
  /**
   * Workspace views only: how many of `sources` are in this workspace, i.e. what an owner/admin of
   * the workspace can lift there. The rest only the connection's owner can lift.
   */
  sourcesHere?: number
}

/** PUT /workspaces/:id/settings/agent-taint (owners and admins, browser only). */
export const setAgentTaintSchema = z.object({ enabled: z.boolean() }).strict()
export type SetAgentTaintInput = z.infer<typeof setAgentTaintSchema>

/** POST /workspaces/:id/agent-connections/release (owners/admins, or the connection's owner; browser only). */
export const releaseTaintSchema = z.object({ connection: z.string().regex(/^(grant|token):[0-9a-f-]{36}$/i) }).strict()
export type ReleaseTaintInput = z.infer<typeof releaseTaintSchema>
