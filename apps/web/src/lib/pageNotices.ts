// Stateless notices a collab document receives, for code that does not own its provider
// (docs/adr/2557-*). openCollab (collabSocket.ts) hands every provider's stateless payloads here,
// keyed by document name, after the provider's own `onStateless`; anyone may listen by name
// without touching the editor that opened the provider. No DOM: tested in plain node.

type Listener = (payload: string) => void

const listeners = new Map<string, Set<Listener>>()

/** Listen to the stateless payloads of document `name`. Returns the unsubscribe. */
export function onPageNotice(name: string, fn: Listener): () => void {
  let set = listeners.get(name)
  if (!set) listeners.set(name, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
    if (!set.size && listeners.get(name) === set) listeners.delete(name)
  }
}

/** Called by openCollab for each stateless payload of `name`. A listener that throws is skipped. */
export function emitPageNotice(name: string, payload: string): void {
  const set = listeners.get(name)
  if (!set) return
  for (const fn of [...set]) {
    try {
      fn(payload)
    } catch {
      // a broken listener must not stop the others (or the provider)
    }
  }
}

/** The notice's kind (`t`), or null for anything else (malformed or not an object). */
export function noticeKind(payload: string): string | null {
  try {
    const msg: unknown = JSON.parse(payload)
    return msg && typeof msg === 'object' && typeof (msg as { t?: unknown }).t === 'string' ? (msg as { t: string }).t : null
  } catch {
    return null
  }
}

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

/**
 * Runs `refresh(name)` once, `delayMs` after the last notice of kind `kind` on that document
 * (trailing), however many arrive and however many callers watch the same name: one shared watch
 * per name, reference counted. Returns the unwatch.
 */
export function createNoticeRefresher(kind: string, refresh: (name: string) => void, delayMs: number, timers: Timers = realTimers) {
  const watches = new Map<string, { refs: number; off: () => void; timer: unknown }>()
  return function watch(name: string): () => void {
    let w = watches.get(name)
    if (!w) {
      const entry = { refs: 0, timer: null as unknown, off: () => {} }
      entry.off = onPageNotice(name, (payload) => {
        if (noticeKind(payload) !== kind) return
        if (entry.timer !== null) timers.clear(entry.timer)
        entry.timer = timers.set(() => {
          entry.timer = null
          refresh(name)
        }, delayMs)
      })
      watches.set(name, (w = entry))
    }
    w.refs++
    let done = false
    const mine = w
    return () => {
      if (done) return
      done = true
      if (--mine.refs > 0) return
      mine.off()
      if (mine.timer !== null) timers.clear(mine.timer)
      if (watches.get(name) === mine) watches.delete(name)
    }
  }
}
