// Edits the server has not received yet (docs/adr/1926-*).
//
// Nothing in the browser persists a collaborative document: an edit lives in the tab's Y.Doc until
// the server acknowledges it. While the socket is down that can be a long time, and a reload, a tab
// close or leaving the page in the app used to drop it without a word. This module answers one
// question for the leave guards and the "not saved yet" indicator: does any open document hold a
// local edit the server has not acknowledged?
//
// The provider's own `unsyncedChanges` is not that question: it is reset to 1 on every (re)sync until
// the server answers, and a read-only connection never gets its count back to 0. So a document is
// "unsaved" only when a LOCAL update happened (an update whose origin is not the provider) and the
// count has not been back to 0 since; read-only and denied documents never are.
//
// Pure state (no DOM, no Yjs): lib/collabSocket.ts feeds it, unsavedEdits.test.ts drives it.

export type TrackedDoc = {
  /** a local update happened that the server has not acknowledged yet */
  localPending: boolean
  /** the provider's unsyncedChanges as last reported */
  unsynced: number
  /** read-only connection or denied document: its edits can never be saved by waiting */
  inert: boolean
}

export type UnsavedTracker = {
  track: (key: object) => void
  untrack: (key: object) => void
  /** A document update with an origin other than the provider (typing, paste, undo, seeding). */
  localEdit: (key: object) => void
  /** The provider reported its unsynced count. 0 = everything sent so far is acknowledged. */
  unsynced: (key: object, n: number) => void
  /** Read-only scope or permission denied. */
  inert: (key: object, inert: boolean) => void
  isUnsaved: (key: object) => boolean
  anyUnsaved: () => boolean
  /** Time (ms) since when anyUnsaved() has been true without a break, or null. */
  unsavedSince: () => number | null
  subscribe: (fn: () => void) => () => void
}

export function createUnsavedTracker(now: () => number = () => Date.now()): UnsavedTracker {
  const docs = new Map<object, TrackedDoc>()
  const listeners = new Set<() => void>()
  let since: number | null = null
  const unsavedOf = (d: TrackedDoc | undefined) => !!d && d.localPending && !d.inert
  const any = () => {
    for (const d of docs.values()) if (unsavedOf(d)) return true
    return false
  }
  const changed = () => {
    const a = any()
    if (a && since === null) since = now()
    if (!a) since = null
    for (const l of listeners) l()
  }
  return {
    track: (key) => {
      if (!docs.has(key)) docs.set(key, { localPending: false, unsynced: 0, inert: false })
    },
    untrack: (key) => {
      if (docs.delete(key)) changed()
    },
    localEdit: (key) => {
      const d = docs.get(key)
      if (!d || d.localPending) return
      d.localPending = true
      changed()
    },
    unsynced: (key, n) => {
      const d = docs.get(key)
      if (!d) return
      d.unsynced = n
      if (n <= 0 && d.localPending) {
        d.localPending = false
        changed()
      }
    },
    inert: (key, inert) => {
      const d = docs.get(key)
      if (!d || d.inert === inert) return
      d.inert = inert
      changed()
    },
    isUnsaved: (key) => unsavedOf(docs.get(key)),
    anyUnsaved: any,
    unsavedSince: () => since,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** How long unsaved edits must last before the indicator shows (normal typing is acknowledged in ms). */
export const UNSAVED_SHOW_AFTER_MS = 1_500

/** Whether the "not saved yet" indicator shows at `t`. */
export function showUnsaved(since: number | null, t: number): boolean {
  return since !== null && t - since >= UNSAVED_SHOW_AFTER_MS
}
