import { eq } from 'drizzle-orm'
import './env'
import { db } from './db'
import { workspaces } from './db/schema'
import { AppError } from './errors'

/**
 * Uploads through connections on or off (docs/adr/2065-*).
 *
 * Who may attach files through a connection (MCP upload_file and a bearer `POST /api/files`) is
 * decided by the server's default and the workspace's own choice:
 *
 *   AGENT_UPLOADS=on     (default) on unless the workspace turned it off
 *   AGENT_UPLOADS=off    off unless the workspace turned it on
 *   AGENT_UPLOADS=never  off everywhere; the workspace setting cannot turn it on
 *
 * An unknown value boots with a warning and counts as `off` (the safe side that a workspace can
 * still open). People's uploads in the browser, read_file and PDF reading are not affected.
 *
 * Limits:
 * - AGENT_UPLOAD_MAX_MB (default 5) per file, at most AGENT_UPLOAD_HARD_MAX_MB (64). upload_file carries the
 *   file as base64 inside one MCP request, so the /mcp body limit follows it: 12 MB as before, or
 *   base64(max) + 1 MB when that is larger — only for requests that call upload_file (directly or through
 *   more_tools); every other request keeps 12 MB. Memory per upload in flight is about four times the file
 *   (the body, the parsed string, the decoded bytes). 0 is not "unlimited": write the size you mean.
 * - AGENT_UPLOAD_DAILY_MB (default 200) per account per rolling 24 hours, over the files its connections
 *   uploaded (files.uploaded_via). People's own uploads in the browser do not count and have no budget,
 *   as before 0.16. 0 = no budget.
 */

export type AgentUploadsMode = 'on' | 'off' | 'never'
/** The workspace's choice; null = follow the server default. */
export type WorkspaceAgentUploads = 'on' | 'off' | null

export const AGENT_UPLOAD_DEFAULT_MB = 5
/** Sanity ceiling: an upload_file request holds about four times the file in memory. */
export const AGENT_UPLOAD_HARD_MAX_MB = 64
/** The /mcp body limit every request has had since 0.x (import_folder). */
export const MCP_BASE_BODY_BYTES = 12 * 1024 * 1024
export const AGENT_UPLOAD_DAILY_DEFAULT_MB = 200

export interface AgentUploadEnv {
  mode: AgentUploadsMode
  maxBytes: number
  /** null = no budget (AGENT_UPLOAD_DAILY_MB=0). */
  dailyBytes: number | null
  /** /mcp body limit for requests that call upload_file (≥ MCP_BASE_BODY_BYTES). */
  mcpUploadBodyBytes: number
  /** Boot warnings for values that were not taken as written. */
  warnings: string[]
}

const MB = 1024 * 1024

/** Parse the three variables (pure, for tests). */
export function parseAgentUploadEnv(e: Record<string, string | undefined>): AgentUploadEnv {
  const warnings: string[] = []
  const rawMode = e.AGENT_UPLOADS?.trim().toLowerCase() ?? ''
  let mode: AgentUploadsMode = 'on'
  if (rawMode === 'on' || rawMode === 'off' || rawMode === 'never') mode = rawMode
  else if (rawMode !== '') {
    mode = 'off'
    warnings.push(`AGENT_UPLOADS=${e.AGENT_UPLOADS?.trim()} is not on, off or never: treated as off (workspaces can still turn uploads by agents on)`)
  }

  let maxMb = AGENT_UPLOAD_DEFAULT_MB
  const rawMax = e.AGENT_UPLOAD_MAX_MB?.trim()
  if (rawMax) {
    const n = Number(rawMax)
    if (!Number.isFinite(n) || n <= 0) warnings.push(`AGENT_UPLOAD_MAX_MB=${rawMax} is not a positive number: using ${AGENT_UPLOAD_DEFAULT_MB}`)
    else if (n > AGENT_UPLOAD_HARD_MAX_MB) {
      maxMb = AGENT_UPLOAD_HARD_MAX_MB
      warnings.push(
        `AGENT_UPLOAD_MAX_MB=${rawMax} is above ${AGENT_UPLOAD_HARD_MAX_MB} (an upload holds about four times the file in memory); using ${AGENT_UPLOAD_HARD_MAX_MB}`,
      )
    } else maxMb = n
  }

  let dailyMb = AGENT_UPLOAD_DAILY_DEFAULT_MB
  const rawDaily = e.AGENT_UPLOAD_DAILY_MB?.trim()
  if (rawDaily) {
    const n = Number(rawDaily)
    if (!Number.isFinite(n) || n < 0) warnings.push(`AGENT_UPLOAD_DAILY_MB=${rawDaily} is not 0 or a positive number: using ${AGENT_UPLOAD_DAILY_DEFAULT_MB}`)
    else dailyMb = n
  }

  const maxBytes = Math.floor(maxMb * MB)
  return {
    mode,
    maxBytes,
    dailyBytes: dailyMb === 0 ? null : Math.floor(dailyMb * MB),
    mcpUploadBodyBytes: Math.max(MCP_BASE_BODY_BYTES, base64Size(maxBytes) + MB),
    warnings,
  }
}

/** Length of the base64 text of n bytes. */
export function base64Size(n: number): number {
  return Math.ceil(n / 3) * 4
}

/** The boot line that says which limits apply, or null for the defaults. */
export function agentUploadLimitsLine(e: AgentUploadEnv): string | null {
  const max = e.maxBytes !== AGENT_UPLOAD_DEFAULT_MB * MB
  const daily = e.dailyBytes !== AGENT_UPLOAD_DAILY_DEFAULT_MB * MB
  if (!max && !daily) return null
  const body =
    e.mcpUploadBodyBytes > MCP_BASE_BODY_BYTES
      ? `; MCP requests that call upload_file accept up to ${mbText(e.mcpUploadBodyBytes)} (others stay at ${mbText(MCP_BASE_BODY_BYTES)})`
      : ''
  return `uploads by AI agents: up to ${mbText(e.maxBytes)} per file${body}; ${e.dailyBytes === null ? 'no daily budget' : `${mbText(e.dailyBytes)} per account per 24 hours`}`
}

/** The process's settings, read once at import. Mutable only through setAgentUploadModeForTests. */
export const agentUploadEnv: AgentUploadEnv = parseAgentUploadEnv(process.env)

/** Tests switch the server default without restarting (never used by the app). */
export function setAgentUploadModeForTests(mode: AgentUploadsMode): void {
  agentUploadEnv.mode = mode
}

/** "5 MB", "2.5 MB" */
export function mbText(bytes: number): string {
  return `${Math.round((bytes / MB) * 10) / 10} MB`
}

export type AgentUploadsDecision =
  | { allowed: true; by: 'server' | 'workspace' }
  | { allowed: false; by: 'server' | 'workspace' | 'never' }

/** Effective rule for a workspace, from the server mode and the workspace's choice. */
export function decideAgentUploads(mode: AgentUploadsMode, ws: WorkspaceAgentUploads): AgentUploadsDecision {
  if (mode === 'never') return { allowed: false, by: 'never' }
  if (ws === 'on') return { allowed: true, by: 'workspace' }
  if (ws === 'off') return { allowed: false, by: 'workspace' }
  return mode === 'on' ? { allowed: true, by: 'server' } : { allowed: false, by: 'server' }
}

export const AGENT_UPLOADS_OFF = 'AGENT_UPLOADS_OFF'

/** The one-line refusal for a decision that is not allowed. */
export function agentUploadsOffMessage(by: 'server' | 'workspace' | 'never'): string {
  if (by === 'never') return 'Uploads by AI agents are turned off on this server (AGENT_UPLOADS=never); a workspace cannot turn them on'
  if (by === 'workspace') return 'Uploads by AI agents are turned off in this workspace; a workspace owner or admin can turn them on in Workspace settings'
  return 'Uploads by AI agents are off by default on this server and this workspace has not turned them on; a workspace owner or admin can turn them on in Workspace settings'
}

/** 403 AGENT_UPLOADS_OFF unless connections may upload into this workspace. */
export async function assertAgentUploadsAllowed(workspaceId: string): Promise<void> {
  const mode = agentUploadEnv.mode
  let ws: WorkspaceAgentUploads = null
  if (mode !== 'never') {
    const [row] = await db.select({ v: workspaces.agentUploads }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    ws = row?.v ?? null
  }
  const d = decideAgentUploads(mode, ws)
  if (!d.allowed) throw new AppError(403, AGENT_UPLOADS_OFF, agentUploadsOffMessage(d.by))
}
