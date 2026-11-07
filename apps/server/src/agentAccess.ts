import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from './db/index'
import { AppError } from './errors'
import { BoundedLru } from './lru'
import { clientNameClashesInWorkspace } from './clientName'

/**
 * Per-workspace agent blocks (docs/adr/0947-*).
 *
 * An OAuth access token is not bound to a workspace: it reaches every workspace its user belongs
 * to. A workspace owner/admin can therefore not revoke someone's connection, only refuse it in their
 * workspace. The refusal is enforced per request, at the same choke points every workspace read and
 * write already passes through:
 *
 *   - `requireUser` runs the rest of a bearer request inside `runAsAgent(scope)` (an
 *     AsyncLocalStorage store entered from the preHandler's `done` callback, so the handler and
 *     everything it awaits see it; a store entered with `run()` around `app.inject` does not
 *     survive into the injected request).
 *   - `requireMembership` and `findVisiblePage` call `assertAgentAllowed(workspaceId)`.
 *   - Cross-workspace lists (GET /workspaces, find_context without workspaceId, the change feed)
 *     add `agentAllowedSql(workspaceIdColumn)`.
 *
 * Cookie (browser) requests have no store, so all of this is a no-op for them.
 */

export interface AgentScope {
  userId: string
  grantId: string
  clientId: string
  clientName: string | null
}

const store = new AsyncLocalStorage<AgentScope>()

/** Run `fn` (and everything it awaits) as an agent request. */
export function runAsAgent<T>(scope: AgentScope, fn: () => T): T {
  return store.run(scope, fn)
}

/** The agent connection of the current request, or null for browser sessions and background jobs. */
export function currentAgent(): AgentScope | null {
  return store.getStore() ?? null
}

export const AGENT_BLOCKED_MESSAGE =
  'An owner or admin of this workspace has blocked this agent connection here. Other workspaces are not affected'

export function agentBlocked(): AppError {
  return new AppError(403, 'AGENT_BLOCKED', AGENT_BLOCKED_MESSAGE)
}

function blockMatch(scope: AgentScope, workspaceId: SQL | AnyPgColumn | string): SQL {
  return sql`exists (select 1 from workspace_agent_blocks ab
                      where ab.workspace_id = ${workspaceId}
                        and ab.user_id = ${scope.userId}
                        and (ab.client_id is null or ab.client_id = ${scope.clientId}))`
}

/**
 * "The current agent (if any) is not blocked in the workspace in `workspaceIdCol`", for WHERE
 * clauses of cross-workspace queries. `true` outside an agent request.
 */
export function agentAllowedSql(workspaceIdCol: AnyPgColumn | SQL): SQL {
  const scope = currentAgent()
  if (!scope) return sql`true`
  return sql`not ${blockMatch(scope, workspaceIdCol)}`
}

// Access records are written at most once a minute per (workspace, grant), like oauth_grants.last_used_at.
const TOUCH_INTERVAL_MS = 60_000
const touched = new BoundedLru<true>(20_000, TOUCH_INTERVAL_MS)
// Member-name clash per (workspace, client, user), re-checked at most once a minute (renames apply then).
const nameClashes = new BoundedLru<boolean>(20_000, TOUCH_INTERVAL_MS)
// Agent blocks of a workspace, valid only for the access version they were read under (block
// changes bump it in their transaction, docs/adr/1071-*). The TTL is a memory bound only.
const blockLists = new BoundedLru<{ v: number; blocks: { u: string; c: string | null }[] }>(20_000, 60 * 60_000)

function blockedIn(blocks: { u: string; c: string | null }[], scope: AgentScope): boolean {
  return blocks.some((b) => b.u === scope.userId && (b.c === null || b.c === scope.clientId))
}

/** Is the current agent blocked in `workspaceId`? Cached per access version when one is given. */
async function isBlocked(scope: AgentScope, workspaceId: string, version?: number, exec: Pick<typeof db, 'execute'> = db): Promise<boolean> {
  if (version === undefined) {
    const rows = (await db.execute(sql`select ${blockMatch(scope, sql`${workspaceId}::uuid`)} as blocked`)) as unknown as {
      blocked: boolean
    }[]
    return !!rows[0]?.blocked
  }
  const hit = blockLists.get(workspaceId)
  if (hit && hit.v === version) return blockedIn(hit.blocks, scope)
  // Read after the version (the caller read it first): the list is never older than its label.
  const rows = (await exec.execute(sql`
    select user_id as u, client_id as c from workspace_agent_blocks where workspace_id = ${workspaceId}
  `)) as unknown as { u: string; c: string | null }[]
  const blocks = rows.map((r) => ({ u: r.u, c: r.c ?? null }))
  blockLists.set(workspaceId, { v: version, blocks })
  return blockedIn(blocks, scope)
}

/**
 * Throws 403 AGENT_BLOCKED when the current agent connection is blocked in `workspaceId`;
 * otherwise records the access for the "Connected agents" list. No-op outside an agent request.
 * `aclVersion`: the workspace access version the caller read in the same statement as the
 * membership (or under the write gate) — the block list is then served from memory while unchanged.
 */
export async function assertAgentAllowed(
  workspaceId: string,
  aclVersion?: number,
  exec?: Pick<typeof db, 'execute'>,
): Promise<void> {
  const scope = currentAgent()
  if (!scope) return
  if (await isBlocked(scope, workspaceId, aclVersion, exec)) throw agentBlocked()
  // A client named exactly like another member of this workspace is refused here only (docs/adr/1007-*).
  const clashKey = `${workspaceId}:${scope.clientId}:${scope.userId}`
  let clash = nameClashes.get(clashKey)
  if (clash === undefined) {
    clash = await clientNameClashesInWorkspace(scope.clientName, scope.userId, workspaceId)
    nameClashes.set(clashKey, clash)
  }
  if (clash) {
    throw new AppError(
      403,
      'CLIENT_NAME_CLASH',
      `This connection is named "${scope.clientName}", the same as a member of this workspace, so it is refused here to keep authorship clear. Other workspaces are not affected; connect an app with a different name to work here`,
    )
  }
  const key = `${workspaceId}:${scope.grantId}`
  if (touched.get(key)) return
  touched.set(key, true)
  await db.execute(sql`
    insert into workspace_agent_access (workspace_id, grant_id, user_id, client_id)
    select ${workspaceId}::uuid, g.id, g.user_id, g.client_id from oauth_grants g where g.id = ${scope.grantId}::uuid
    on conflict (workspace_id, grant_id) do update set last_used_at = now()
  `)
}

/** Test hook: forget the once-a-minute throttle. */
export function _resetAgentTouches(): void {
  touched.clear()
  nameClashes.clear()
  blockLists.clear()
}
