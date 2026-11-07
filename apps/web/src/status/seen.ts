// "The same problem at most once a day" for the admin status banner (docs/adr/1233-*).
//
// A problem is identified by `<item key>:<level>` (so a warning that becomes an error is new).
// When the banner shows, every problem in it is stamped with the time; a problem stamped in the
// last 24 hours does not raise the banner again. Stored per admin in localStorage — a convenience,
// so a blocked or cleared storage only means the banner shows once more.

export const SEEN_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 100

export type SeenMap = Record<string, number>

export const problemId = (p: { key: string; level: string }) => `${p.key}:${p.level}`

const storageKey = (userId: string) => `inkling-admin-status-seen:${userId}`

export function readSeen(userId: string): SeenMap {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(userId)) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object') return {}
    const out: SeenMap = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'number') out[k] = v
    return out
  } catch {
    return {}
  }
}

export function writeSeen(userId: string, seen: SeenMap): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(seen))
  } catch {
    // storage unavailable: the banner may show again next time
  }
}

/** Problems not shown in the last 24 h. */
export function freshProblems<T extends { key: string; level: string }>(issues: T[], seen: SeenMap, now: number): T[] {
  return issues.filter((p) => {
    const at = seen[problemId(p)]
    return !(typeof at === 'number' && now - at < SEEN_TTL_MS && at <= now)
  })
}

/** The map after showing `issues` at `now`; expired entries are dropped and the size is bounded. */
export function markShown(issues: { key: string; level: string }[], seen: SeenMap, now: number): SeenMap {
  const out: SeenMap = {}
  for (const [k, at] of Object.entries(seen)) if (now - at < SEEN_TTL_MS) out[k] = at
  for (const p of issues) out[problemId(p)] = now
  const entries = Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES)
  return Object.fromEntries(entries)
}
