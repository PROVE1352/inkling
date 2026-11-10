// How much the device keeps (docs/adr/2200-*). Pure.

/** Pages kept per device. */
export const MAX_DOCS = 200
/** Bytes of stored Yjs updates per device (copies with unsent edits are never evicted, so this can be exceeded by them). */
export const MAX_BYTES = 100 * 1024 * 1024

export type EvictionCandidate = { pageId: string; bytes: number; openedAt: number; pending: boolean }

/**
 * Pages to delete so the rest fits the limits: least recently opened first, never one with unsent
 * edits and never one open right now.
 */
export function pickEvictions(
  docs: EvictionCandidate[],
  open: ReadonlySet<string>,
  limits: { maxDocs: number; maxBytes: number } = { maxDocs: MAX_DOCS, maxBytes: MAX_BYTES },
): string[] {
  let count = docs.length
  let bytes = docs.reduce((n, d) => n + d.bytes, 0)
  if (count <= limits.maxDocs && bytes <= limits.maxBytes) return []
  const out: string[] = []
  const order = docs.filter((d) => !d.pending && !open.has(d.pageId)).sort((a, b) => a.openedAt - b.openedAt)
  for (const d of order) {
    if (count <= limits.maxDocs && bytes <= limits.maxBytes) break
    out.push(d.pageId)
    count--
    bytes -= d.bytes
  }
  return out
}
