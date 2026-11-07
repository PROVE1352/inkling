import { eq } from 'drizzle-orm'
import type {
  AuditAction,
  RolePolicy,
  WorkspaceCapabilities,
  WorkspaceDTO,
  WorkspaceRole,
  WorkspaceSettingsDTO,
} from '@inkling/shared'
import { db } from './db/index'
import { workspaceAuditEvents, workspaces } from './db/schema'
import { forbidden, notFound } from './errors'

/**
 * Workspace roles, settings and the audit log (docs/adr/0945-*, 0946-*).
 *
 *   owner  - everything, including name/icon, policy settings, webhooks, delete/restore/transfer
 *   admin  - members (add, remove plain members), invite link, public links, connected agents,
 *            audit log, moderation (others' comments/templates)
 *   member - content; adding members / exporting only when the workspace policy allows it
 *
 * Every rule is enforced here on the server; the SPA only hides what `WorkspaceDTO.can` says.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** db or a transaction. */
export type Exec = Pick<Tx, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

export function isManagerRole(role: WorkspaceRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/** Whether `role` satisfies "lowest role allowed" `policy`. */
export function roleMeets(role: WorkspaceRole | null | undefined, policy: RolePolicy): boolean {
  if (!role) return false
  if (policy === 'members') return true
  if (policy === 'admins') return role === 'owner' || role === 'admin'
  return role === 'owner'
}

export const policyColumns = {
  inviteLinkEnabled: workspaces.inviteLinkEnabled,
  memberAddPolicy: workspaces.memberAddPolicy,
  exportPolicy: workspaces.exportPolicy,
  publicSharingDisabled: workspaces.publicSharingDisabled,
  trashRetentionDays: workspaces.trashRetentionDays,
  auditRetentionDays: workspaces.auditRetentionDays,
  reviewIntervalDays: workspaces.reviewIntervalDays,
} as const

export type WorkspacePolicy = WorkspaceSettingsDTO

/** The workspace's settings (404 when it does not exist). */
export async function loadPolicy(exec: Pick<Exec, 'select'>, workspaceId: string): Promise<WorkspacePolicy> {
  const [row] = await exec.select(policyColumns).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  if (!row) throw notFound()
  return row
}

export function capabilitiesFor(role: WorkspaceRole, p: WorkspacePolicy): WorkspaceCapabilities {
  const manage = isManagerRole(role)
  return {
    manage,
    editSettings: role === 'owner',
    addMembers: roleMeets(role, p.memberAddPolicy),
    inviteLink: manage && p.inviteLinkEnabled,
    export: roleMeets(role, p.exportPolicy),
    publish: manage && !p.publicSharingDisabled,
  }
}

/**
 * WorkspaceDTO for `role`. The invite code is a manager credential (C-M3): members get ''. When the
 * link is turned off, only owners still see the (unusable) code so they can turn it back on.
 */
export function toWorkspaceDTO(
  ws: { id: string; name: string; icon: string | null; inviteCode: string },
  role: WorkspaceRole,
  p: WorkspacePolicy,
): WorkspaceDTO {
  const can = capabilitiesFor(role, p)
  return {
    id: ws.id,
    name: ws.name,
    icon: ws.icon,
    inviteCode: can.inviteLink || role === 'owner' ? ws.inviteCode : '',
    role,
    can,
  }
}

export function requireManager(role: WorkspaceRole): void {
  if (!isManagerRole(role)) throw forbidden('Only workspace owners and admins can do this')
}

export function requireOwner(role: WorkspaceRole, what = 'change workspace settings'): void {
  if (role !== 'owner') throw forbidden(`Only workspace owners can ${what}`)
}

// ---------------------------------------------------------------------------
// Audit log (docs/adr/0946-*)
// ---------------------------------------------------------------------------

export interface AuditActor {
  id: string
  name: string
  /** OAuth client name for agent (MCP) requests. */
  via?: string | null
}

export interface AuditInput {
  workspaceId: string
  actor: AuditActor | null
  action: AuditAction
  target?: { type: string; id?: string | null; label?: string | null } | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

const MAX_LABEL = 200

function cap(s: string | null | undefined): string | null {
  if (s == null) return null
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s
}

/**
 * Append one audit event. Call it with the transaction that performs the action, so the event
 * exists exactly when the action committed. Only ever inserts.
 */
export async function recordAudit(exec: Pick<Exec, 'insert'>, e: AuditInput): Promise<void> {
  await exec.insert(workspaceAuditEvents).values({
    workspaceId: e.workspaceId,
    actorId: e.actor?.id ?? null,
    actorName: cap(e.actor?.name) ?? '',
    viaClient: e.actor?.via ?? null,
    action: e.action,
    targetType: e.target?.type ?? null,
    targetId: e.target?.id ?? null,
    targetLabel: cap(e.target?.label ?? null),
    before: e.before ?? null,
    after: e.after ?? null,
  })
}

/** Only the keys whose values differ, as {before, after} summaries. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(after)) {
    if (v === undefined) continue
    if (before[k] !== v) {
      b[k] = before[k] ?? null
      a[k] = v
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null
}
