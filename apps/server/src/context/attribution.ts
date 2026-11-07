import type { AuthUser } from '../auth'

/**
 * Who is editing a page right now, for derived-index consumers that run after the edit (the
 * change feed). REST write paths that edit a document through a DirectConnection wrap the write
 * in `withEditActor`; the store hook indexes server edits immediately (docs/adr/0750-*), so the
 * change logger sees the actor while the request is still in flight. Live typing has no entry
 * (actor unknown, `via` null). Single-process, in-memory, like the rest of the collab state.
 */

export interface EditActor {
  userId: string
  /** OAuth client name for MCP writes, null for a browser session. */
  via: string | null
}

const active = new Map<string, { actor: EditActor; depth: number }>()

export function actorOf(user: AuthUser): EditActor {
  return { userId: user.id, via: user.via ?? null }
}

export async function withEditActor<T>(pageIds: string[], actor: EditActor, fn: () => Promise<T>): Promise<T> {
  for (const id of pageIds) {
    const cur = active.get(id)
    if (cur) {
      cur.actor = actor
      cur.depth++
    } else active.set(id, { actor, depth: 1 })
  }
  try {
    return await fn()
  } finally {
    for (const id of pageIds) {
      const cur = active.get(id)
      if (!cur) continue
      if (--cur.depth <= 0) active.delete(id)
    }
  }
}

export function currentEditActor(pageId: string): EditActor | undefined {
  return active.get(pageId)?.actor
}
