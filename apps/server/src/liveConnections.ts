import { OutgoingMessage } from '@hocuspocus/server'
import type { Hocuspocus } from '@hocuspocus/server'
import { and, eq, inArray } from 'drizzle-orm'
import * as Y from 'yjs'
import { db } from './db/index'
import { pages } from './db/schema'

/**
 * Revocation of live collaboration connections (docs/adr/0754-*).
 *
 * Authorisation of a Hocuspocus connection happens once, in onAuthenticate. Without this module a
 * socket opened before a permission change kept reading and writing the document: after the
 * member was removed, the page became private, the account was force-deleted or its sessions
 * were revoked. Callers invoke these after the change commits; a closed client that is still
 * allowed simply re-authenticates.
 *
 * Lives apart from collab.ts so that accounts/admin code can import it without an import cycle
 * (collab.ts registers the instance at load time).
 */

interface LiveContext {
  userId?: string
  sessionToken?: string
}

let instance: Hocuspocus | null = null

export function registerHocuspocus(h: Hocuspocus): void {
  instance = h
}

type Pred = (docName: string, ctx: LiveContext) => boolean

/** Closes every live connection matching `pred`. Returns how many were closed. Never throws. */
function closeWhere(pred: Pred): number {
  if (!instance) return 0
  let n = 0
  try {
    for (const [name, doc] of instance.documents) {
      for (const conn of doc.getConnections()) {
        const ctx = (conn.context ?? {}) as LiveContext
        if (!pred(name, ctx)) continue
        try {
          // Tell the provider why first, so the client shows "access changed" instead of
          // reconnecting in a loop (the web handles onAuthenticationFailed 'permission-changed').
          try {
            conn.send(new OutgoingMessage(name).writePermissionDenied('permission-changed').toUint8Array())
          } catch {
            // socket already closing — the close below still runs
          }
          conn.close({ code: 4403, reason: 'permission-changed' })
          n++
        } catch (err) {
          console.error('[inkling] closing collab connection failed', name, err)
        }
      }
    }
  } catch (err) {
    console.error('[inkling] closeWhere failed', err)
  }
  return n
}

/**
 * All connections of a user (page documents and, with includeInbox, the inbox channel).
 * `keepSessionToken` spares connections opened with that session (own password change).
 */
export function closeUserConnections(
  userId: string,
  opts: { includeInbox?: boolean; keepSessionToken?: string } = {},
): number {
  return closeWhere((name, ctx) => {
    if (ctx.userId !== userId) return false
    if (opts.keepSessionToken && ctx.sessionToken === opts.keepSessionToken) return false
    if (name.startsWith('inbox:')) return opts.includeInbox === true
    return true
  })
}

/** Connections of `userId` to documents of one workspace (member removed / left). */
export async function closeUserWorkspaceConnections(
  userId: string,
  workspaceId: string,
): Promise<number> {
  const open = openPageDocNames()
  if (!open.length) return 0
  try {
    const rows = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), inArray(pages.id, open)))
    const inWs = new Set(rows.map((r) => r.id))
    return closeWhere((name, ctx) => ctx.userId === userId && inWs.has(name))
  } catch (err) {
    // The permission change already committed; never fail the request over socket cleanup.
    console.error('[inkling] closeUserWorkspaceConnections failed', err)
    return 0
  }
}

/**
 * Every connection (all users) to documents of one workspace — the workspace was soft-deleted
 * (docs/adr/0910-*). Re-authentication then fails because the workspace is no longer live.
 */
export async function closeWorkspaceConnections(workspaceId: string): Promise<number> {
  const open = openPageDocNames()
  if (!open.length) return 0
  try {
    const rows = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), inArray(pages.id, open)))
    const inWs = new Set(rows.map((r) => r.id))
    return closeWhere((name) => inWs.has(name))
  } catch (err) {
    console.error('[inkling] closeWorkspaceConnections failed', err)
    return 0
  }
}

/**
 * After pages became private: closes connections of everyone who can no longer see them
 * (private pages are visible to their creator only, ownerless ones to nobody; see pageDto.visibleTo).
 */
export async function closeConnectionsLosingPrivateAccess(pageIds: string[]): Promise<number> {
  const open = new Set(openPageDocNames())
  const ids = pageIds.filter((id) => open.has(id))
  if (!ids.length) return 0
  let rows: { id: string; createdBy: string | null; scope: string }[]
  try {
    rows = await db
      .select({ id: pages.id, createdBy: pages.createdBy, scope: pages.scope })
      .from(pages)
      .where(inArray(pages.id, ids))
  } catch (err) {
    console.error('[inkling] closeConnectionsLosingPrivateAccess failed', err)
    return 0
  }
  const owner = new Map(rows.filter((r) => r.scope === 'private').map((r) => [r.id, r.createdBy]))
  return closeWhere((name, ctx) => {
    if (!owner.has(name)) return false
    // An ownerless private page is visible to nobody: every connection goes.
    const createdBy = owner.get(name)
    return !createdBy || ctx.userId !== createdBy
  })
}

/** Every connection to the given documents (pages trashed or purged). */
export function closePageConnections(pageIds: string[]): number {
  const set = new Set(pageIds)
  return closeWhere((name) => set.has(name))
}

/**
 * Current state of a document that is open in memory, or null. The live doc leads page_docs by
 * up to the store debounce (2–10 s), so "before restore/edit" snapshots must read it from here.
 */
export function liveDocState(name: string): Uint8Array | null {
  const doc = instance?.documents.get(name)
  return doc ? Y.encodeStateAsUpdate(doc) : null
}

function openPageDocNames(): string[] {
  if (!instance) return []
  return [...instance.documents.keys()].filter((n) => !n.startsWith('inbox:'))
}
