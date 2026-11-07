/**
 * Line-based three-way merge (diff3) — self-contained, no dependency.
 *
 * 1. Myers O((N+M)·D) diff between base↔local and base↔server (common prefix/suffix trimmed
 *    first, edit distance capped so pathological inputs fail fast instead of going quadratic).
 * 2. Classic diff3 walk: base lines matched in BOTH diffs are stable anchors; the regions
 *    between anchors are taken from whichever side changed, or reported as a conflict when both
 *    sides changed them differently.
 */

export interface MergeConflict {
  /** 1-based line range in the base text */
  baseStart: number
  baseEnd: number
  local: string[]
  server: string[]
  base: string[]
}

export interface MergeResult {
  /** merged lines; conflict regions contain git-style markers */
  lines: string[]
  conflicts: MergeConflict[]
  /** true when the inputs were too different to merge (treated as one big conflict) */
  gaveUp: boolean
}

const MAX_LINES = 200_000
const MAX_EDIT_DISTANCE = 20_000

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function joinLines(lines: string[]): string {
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/**
 * Returns match[i] = index in `b` matched to a[i], or -1. Monotone increasing over matched i.
 * Returns null when the edit distance exceeds the cap.
 */
export function matchLines(a: string[], b: string[]): Int32Array | null {
  const match = new Int32Array(a.length).fill(-1)
  // common prefix / suffix
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    match[pre] = pre
    pre++
  }
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    match[a.length - 1 - suf] = b.length - 1 - suf
    suf++
  }
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const n = A.length
  const m = B.length
  if (n === 0 || m === 0) return match

  // Myers forward pass, keeping each round's V for backtracking.
  const max = n + m
  const offset = max
  let v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null
    trace.push(v.slice(offset - d, offset + d + 2)) // only the band that can be read next
    const next = v
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && A[x] === B[y]) {
        x++
        y++
      }
      next[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
    v = next
    if (found) break
  }

  // Backtrack: trace[d] holds V before round d, restricted to k ∈ [-d-1, d+1] shifted by d.
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const band = trace[d]
    const get = (k: number) => band[k + d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && get(k - 1) < get(k + 1))) prevK = k + 1
    else prevK = k - 1
    const prevX = get(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      match[pre + x] = pre + y
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    match[pre + x] = pre + y
  }
  return match
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function merge3(baseText: string, localText: string, serverText: string): MergeResult {
  const o = splitLines(baseText)
  const a = splitLines(localText)
  const b = splitLines(serverText)
  const giveUp = (): MergeResult => ({
    lines: ['<<<<<<< local', ...a, '=======', ...b, '>>>>>>> server'],
    conflicts: [{ baseStart: 1, baseEnd: o.length, local: a, server: b, base: o }],
    gaveUp: true,
  })
  if (o.length + a.length + b.length > MAX_LINES) return giveUp()
  const ma = matchLines(o, a)
  const mb = matchLines(o, b)
  if (!ma || !mb) return giveUp()

  const out: string[] = []
  const conflicts: MergeConflict[] = []
  let i = 0
  let j = 0
  let k = 0
  while (i < o.length || j < a.length || k < b.length) {
    // stable line?
    if (i < o.length && ma[i] === j && mb[i] === k) {
      out.push(o[i])
      i++
      j++
      k++
      continue
    }
    // next anchor: first base line ≥ i matched on both sides
    let ni = i
    while (ni < o.length && !(ma[ni] >= j && mb[ni] >= k)) ni++
    const nj = ni < o.length ? ma[ni] : a.length
    const nk = ni < o.length ? mb[ni] : b.length
    const oc = o.slice(i, ni)
    const ac = a.slice(j, nj)
    const bc = b.slice(k, nk)
    if (sameLines(ac, oc)) out.push(...bc)
    else if (sameLines(bc, oc)) out.push(...ac)
    else if (sameLines(ac, bc)) out.push(...ac)
    else {
      conflicts.push({ baseStart: i + 1, baseEnd: ni, local: ac, server: bc, base: oc })
      out.push('<<<<<<< local', ...ac, '=======', ...bc, '>>>>>>> server')
    }
    i = ni
    j = nj
    k = nk
  }
  return { lines: out, conflicts, gaveUp: false }
}
