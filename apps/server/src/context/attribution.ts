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

/**
 * People typing in the browser editor, per page (docs/adr/1002-*). Live typing reaches the index
 * 8–30 s after the keystrokes with no request in flight, so the collab `onChange` hook notes who
 * changed the document; notification producers use it to attribute body mentions to a person and
 * to leave the editors themselves out of "page you follow changed". Bounded and short-lived.
 */
const LIVE_TTL_MS = 2 * 60_000
const MAX_LIVE_PAGES = 5_000
const live = new Map<string, Map<string, number>>()

export function noteLiveEdit(pageId: string, userId: string, now = Date.now()): void {
  let m = live.get(pageId)
  if (!m) {
    if (live.size >= MAX_LIVE_PAGES) {
      const oldest = live.keys().next().value
      if (oldest !== undefined) live.delete(oldest)
    }
    m = new Map()
    live.set(pageId, m)
  }
  m.delete(userId)
  m.set(userId, now)
}

/** Users who typed in the page within the last two minutes, most recent last. */
export function liveEditors(pageId: string, now = Date.now()): string[] {
  const m = live.get(pageId)
  if (!m) return []
  for (const [u, at] of m) if (now - at > LIVE_TTL_MS) m.delete(u)
  if (m.size === 0) {
    live.delete(pageId)
    return []
  }
  return [...m.keys()]
}

/** Who made the edit being indexed now: the in-flight REST/MCP actor, else the latest live typist. */
export function indexActor(pageId: string): EditActor | null {
  const a = currentEditActor(pageId)
  if (a) return a
  const l = liveEditors(pageId)
  return l.length ? { userId: l[l.length - 1], via: null } : null
}
