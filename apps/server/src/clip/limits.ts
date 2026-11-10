import { AppError } from '../errors'

/**
 * Limits on server-side fetches for `article` clips (docs/adr/2262-*). Each one makes the server
 * download up to 2 MiB from somewhere else and parse it, so on top of the route's request limit a
 * person gets at most CLIP_FETCHES_PER_MINUTE fetches in a sliding minute and CLIP_FETCHES_PER_USER
 * at the same time, and the server runs at most CLIP_FETCHES_GLOBAL at once. Over a limit the
 * request is answered 429 before anything is fetched or created. In memory, per process.
 */
export const CLIP_FETCHES_PER_MINUTE = 10
export const CLIP_FETCHES_PER_USER = 2
export const CLIP_FETCHES_GLOBAL = 8

const recent = new Map<string, number[]>()
const active = new Map<string, number>()
let activeTotal = 0

const limited = (message: string) => new AppError(429, 'CLIP_RATE_LIMITED', message)

/** Takes a fetch slot for `userId` or throws 429; call the returned function once when done. */
export function acquireClipFetch(userId: string, now = Date.now()): () => void {
  const times = (recent.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (times.length >= CLIP_FETCHES_PER_MINUTE) {
    recent.set(userId, times)
    throw limited('Too many pages fetched for clipping in the last minute; wait a moment or save as a link')
  }
  if ((active.get(userId) ?? 0) >= CLIP_FETCHES_PER_USER || activeTotal >= CLIP_FETCHES_GLOBAL) {
    throw limited('Other pages are being fetched for clipping right now; try again in a moment')
  }
  times.push(now)
  recent.set(userId, times)
  active.set(userId, (active.get(userId) ?? 0) + 1)
  activeTotal++
  let released = false
  return () => {
    if (released) return
    released = true
    activeTotal--
    const n = (active.get(userId) ?? 1) - 1
    if (n > 0) active.set(userId, n)
    else active.delete(userId)
  }
}

// Old entries go once a minute, so the map holds only people who clipped recently.
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of recent) {
    const keep = v.filter((t) => now - t < 60_000)
    if (keep.length) recent.set(k, keep)
    else recent.delete(k)
  }
}, 60_000).unref()

/** Test hook. */
export function _resetClipLimits(): void {
  recent.clear()
  active.clear()
  activeTotal = 0
}
