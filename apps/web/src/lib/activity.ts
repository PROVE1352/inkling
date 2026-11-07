// Activity screen helpers (docs/adr/1003-*): group a newest-first list into local calendar days.

/** Local-time 'YYYY-MM-DD' of an ISO timestamp ('' when it does not parse). */
export function localDayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface DayGroup<T> {
  day: string
  items: T[]
}

/**
 * Consecutive items of the same local day form one group, in input order. The input is newest
 * first, so groups come out newest day first; a day never splits unless the input is unsorted.
 */
export function groupByDay<T extends { changedAt: string }>(items: readonly T[]): DayGroup<T>[] {
  const out: DayGroup<T>[] = []
  for (const it of items) {
    const day = localDayKey(it.changedAt)
    const last = out[out.length - 1]
    if (last && last.day === day) last.items.push(it)
    else out.push({ day, items: [it] })
  }
  return out
}

/** 'today' | 'yesterday' | null for a day key relative to `now` (local time). */
export function relativeDay(day: string, now = new Date()): 'today' | 'yesterday' | null {
  if (day === localDayKey(now.toISOString())) return 'today'
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)
  if (day === localDayKey(y.toISOString())) return 'yesterday'
  return null
}
