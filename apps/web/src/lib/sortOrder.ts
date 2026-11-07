// Computes a value between two neighbouring sort values (same convention as the M2 tree dnd midpoint logic).
// prev = sortOrder of the sibling above (undefined if none), next = sortOrder of the sibling below (undefined if none).
export function midOrder(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return 1000
  if (prev === undefined) return (next as number) - 1000
  if (next === undefined) return (prev as number) + 1000
  return (prev + next) / 2
}
