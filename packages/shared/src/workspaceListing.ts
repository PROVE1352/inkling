import { z } from 'zod'

// A person's own arrangement of their workspace list (docs/adr/2300-*): named groups ("Contests",
// "Classes") and archived workspaces. Per person, never shared, never a permission (docs/adr/2302-*).
// Browser sessions change it (PATCH/PUT/POST/DELETE /api/me/…); agents only read its effect.

/** Groups per person; far above what a switcher can show, small enough to keep every list cheap. */
export const WORKSPACE_GROUPS_MAX = 50
/** Longest group name (characters after trimming). */
export const WORKSPACE_GROUP_NAME_MAX = 40
/** Longest id list one reorder call accepts. */
export const WORKSPACE_ORDER_MAX_IDS = 500

export const workspaceGroupNameSchema = z.string().trim().min(1).max(WORKSPACE_GROUP_NAME_MAX)

/** POST /me/workspace-groups */
export const createWorkspaceGroupSchema = z.object({ name: workspaceGroupNameSchema })

/** PATCH /me/workspace-groups/:id — rename and/or fold. */
export const updateWorkspaceGroupSchema = z
  .object({ name: workspaceGroupNameSchema.optional(), collapsed: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.collapsed !== undefined, 'Nothing to change')

/** PUT /me/workspace-groups/order — every group id of the person, in the new order. */
export const workspaceGroupOrderSchema = z.object({
  ids: z.array(z.uuid()).max(WORKSPACE_GROUPS_MAX).transform((ids) => [...new Set(ids)]),
})

/** POST /me/workspace-groups/:id/archive — archive (or bring back) every workspace in the group. */
export const workspaceGroupArchiveSchema = z.object({ archived: z.boolean() })

/** PATCH /me/workspaces/:id/listing — archive/unarchive, move to a group (null = no group, at its end). */
export const workspaceListingPatchSchema = z
  .object({ archived: z.boolean().optional(), groupId: z.uuid().nullable().optional() })
  .refine((v) => v.archived !== undefined || v.groupId !== undefined, 'Nothing to change')

/**
 * PUT /me/workspace-order — the workspaces of one group (or the ungrouped ones, groupId null) in
 * order. Listed workspaces join that group at those positions (a drag across groups is one call).
 */
export const workspaceOrderSchema = z.object({
  groupId: z.uuid().nullable(),
  ids: z.array(z.uuid()).max(WORKSPACE_ORDER_MAX_IDS).transform((ids) => [...new Set(ids)]),
})

export type CreateWorkspaceGroupInput = z.input<typeof createWorkspaceGroupSchema>
export type UpdateWorkspaceGroupInput = z.input<typeof updateWorkspaceGroupSchema>
export type WorkspaceListingPatchInput = z.input<typeof workspaceListingPatchSchema>
export type WorkspaceOrderInput = z.input<typeof workspaceOrderSchema>

/** One group of the person's list (GET /me/workspace-groups, in the person's order). */
export interface WorkspaceGroupDTO {
  id: string
  name: string
  collapsed: boolean
}

/**
 * The caller's own arrangement of one workspace, on WorkspaceDTO.listing (GET /workspaces). Absent
 * when the person never touched it; each field only when set.
 */
export interface WorkspaceListingDTO {
  archived?: true
  groupId?: string
  /** The group's name (list_workspaces prints it). */
  group?: string
  /** Order inside its group, or among the ungrouped ones. */
  position?: number
}
