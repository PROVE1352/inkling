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
  // Typing not indexed yet is logged first, as the typist's (CF-2, docs/adr/1625-*), so this write's
  // change rows hold only this write — a revert of an agent edit never takes a person's typing along.
  if (typingFlush) {
    for (const id of pageIds) {
      if (active.has(id) || !windowTypists.has(id)) continue
      await typingFlush(id).catch((err) => console.error('[inkling] typing flush before a server edit failed', id, err))
    }
  }
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
  let w = windowTypists.get(pageId)
  if (!w) {
    if (windowTypists.size >= MAX_LIVE_PAGES) {
      const oldest = windowTypists.keys().next().value
      if (oldest !== undefined) windowTypists.delete(oldest)
    }
    w = new Set()
    windowTypists.set(pageId, w)
  }
  w.add(userId)
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

// ---------------------------------------------------------------------------
// Typing per index window (CF-2, docs/adr/1625-*)
// ---------------------------------------------------------------------------

/**
 * People who typed in the page since its last index pass began. An index pass takes the set when
 * it starts (`beginIndexWindow`); the change rows it logs without an in-flight actor are the
 * typist's when exactly one person typed in that window, else nobody's (as before).
 */
const windowTypists = new Map<string, Set<string>>()
const indexing = new Map<string, string[]>()
let typingFlush: ((pageId: string) => Promise<void>) | null = null

/** Index pass start: the typists of this window (the next window starts empty). */
export function beginIndexWindow(pageId: string): void {
  const w = windowTypists.get(pageId)
  windowTypists.delete(pageId)
  indexing.set(pageId, w ? [...w] : [])
}

export function endIndexWindow(pageId: string): void {
  indexing.delete(pageId)
}

/** The one person who typed in the window being indexed, or null (nobody, or several). */
export function windowTypist(pageId: string): string | null {
  const list = indexing.get(pageId) ?? []
  return list.length === 1 ? list[0] : null
}

/** Set by the collab server: indexes a page's live document now (typing not indexed yet). */
export function registerTypingFlush(fn: ((pageId: string) => Promise<void>) | null): void {
  typingFlush = fn
}

/** Test hook. */
export function hasPendingTyping(pageId: string): boolean {
  return windowTypists.has(pageId)
}
