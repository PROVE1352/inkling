import type { DiffOpDTO } from '@inkling/shared'

// Unified-diff rows for DiffView (docs/adr/1004-*). The server sends the whole edit script
// (unit = line or sentence, unchanged units included), so long unchanged runs are folded here,
// keeping `context` units next to each change.

export type DiffRow = { t: '=' | '-' | '+'; s: string } | { t: 'skip'; count: number }

export function diffRows(ops: readonly DiffOpDTO[], context = 3): DiffRow[] {
  // Defensive: a unit that carries newlines becomes one row per line.
  const units: DiffOpDTO[] = []
  for (const op of ops) {
    const lines = op.s.split('\n')
    for (const s of lines) units.push({ t: op.t, s })
  }

  const out: DiffRow[] = []
  let i = 0
  while (i < units.length) {
    if (units[i].t !== '=') {
      out.push(units[i])
      i++
      continue
    }
    let j = i
    while (j < units.length && units[j].t === '=') j++
    const run = units.slice(i, j)
    const isFirst = i === 0
    const isLast = j === units.length
    const head = isFirst ? 0 : context
    const tail = isLast ? 0 : context
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head))
      out.push({ t: 'skip', count: run.length - head - tail })
      out.push(...run.slice(run.length - tail))
    } else {
      out.push(...run)
    }
    i = j
  }
  return out
}

/** True when the edit script has no insertions or deletions. */
export function diffIsEmpty(ops: readonly DiffOpDTO[]): boolean {
  return ops.every((o) => o.t === '=')
}
