import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import type { WorkspaceDTO } from '@inkling/shared'
import { db } from '../db/index'
import { workspaceMembers, workspaces } from '../db/schema'
import { call, jsonUntrusted, ToolError, wrapWrite } from './core'
import type { McpServer, ToolCtx } from './core'

/**
 * create_workspace (docs/adr/2596-*): a new workspace owned by the connection's person, through the
 * same route the web app's "New workspace" uses (name check, LIMIT_WORKSPACES, LIMIT_WORKSPACES_TOTAL,
 * restricted mode, trial accounts, rate limits). The route caps what agent connections create per
 * account and day and tells the person in the notification bell.
 *
 * Refused before the route for a connection limited to some workspaces or a subtree: a person narrowed
 * it on purpose, and a workspace the agent made itself would be a way out of that range. A connection
 * whose range is "all" works in the new workspace at once (agents_pending is only for workspaces
 * someone else added the person to, docs/adr/2580-*).
 */

export const RANGED_CREATE_MESSAGE =
  'This connection is limited to some workspaces (or one page tree), so it cannot create workspaces: that would widen ' +
  'what the person allowed. Ask the person to create the workspace in the web app and include it in this connection ' +
  '(Settings > Connections), or work in a workspace the connection already has'

export const GUEST_CREATE_MESSAGE =
  'This account is only a guest in other workspaces; it can create a workspace in the web app, not through a connection'

/** The account has no workspace of its own: a guest of pages elsewhere (docs/adr/1250-*). */
async function guestOnly(ctx: ToolCtx): Promise<boolean> {
  if (!ctx.user.hasGrants) return false
  const [row] = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, and(eq(workspaces.id, workspaceMembers.workspaceId), isNull(workspaces.deletedAt)))
    .where(eq(workspaceMembers.userId, ctx.user.id))
    .limit(1)
  return !row
}

export function registerWorkspaceTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'create_workspace',
    {
      title: 'Create workspace',
      description:
        'Create a workspace owned by your person (they get a notification). Not for connections limited to some workspaces; ' +
        'a few a day per account.',
      inputSchema: {
        name: z.string().trim().min(1).max(60).describe('Workspace name'),
      },
    },
    wrapWrite(ctx, async ({ name }) => {
      const range = ctx.user.range
      if (range && !range.implicit) throw new ToolError(RANGED_CREATE_MESSAGE)
      if (await guestOnly(ctx)) throw new ToolError(GUEST_CREATE_MESSAGE)
      const res = await call(ctx, 'POST', '/api/workspaces', { json: { name } })
      const { workspace } = res.json() as { workspace: WorkspaceDTO }
      return jsonUntrusted({
        id: workspace.id,
        name: workspace.name,
        role: workspace.role,
        url: `${ctx.origin}/w/${workspace.id}`,
        next: 'This connection can work in it now: create_page(workspaceId=<id>, …)',
      })
    }),
  )
}
