import { estimateTokens } from './tokens'

/**
 * Line diff for the change feed (docs/adr/0933-*). Pure, no external dependencies.
 *
 * - Units: lines; a line longer than `longLine` ASCII-equivalent characters (estimated tokens × 4, so
 *   ~160 Latin characters or ~40 Hangul) is split into sentences so that one edited sentence in a long
 *   paragraph shows as one -/+ pair instead of the whole paragraph twice.
 * - Algorithm: common prefix/suffix trimmed, then Myers' O((N+M)·D) greedy diff on the middle.
 * - Caps: maxUnits per side, maxD edit distance and maxWork steps (a deterministic work counter, not
 *   a clock, so the same input always gives the same output). Over any cap the result is `large`
 *   and the caller prints "large change, read section" instead of a diff.
 * - Output: hunks of '- ' / '+ ' lines, each preceded by at most one short context line ('  '),
 *   hunks separated by '…' when unchanged lines were skipped between them.
 */

export const DIFF_LIMITS = {
  /** Units (lines/sentences) per side after trimming the common prefix/suffix. */
  maxUnits: 3_000,
  /** Edit distance (inserted + deleted units). */
  maxD: 400,
  /** Work cap for one diff: frontier steps + snake comparisons (deterministic, ~a few ms). */
  maxWork: 4_000_000,
  /** Lines longer than this (ASCII-equivalent characters: estimated tokens × 4) are split into sentences. */
  longLine: 160,
  /** Context lines longer than this are cut (with '…'). */
  contextChars: 80,
}

export type DiffOp = { t: '=' | '-' | '+'; s: string }

const SENTENCE_END = /(?<=[.!?。！？])\s+/u

/** Text → diff units (lines, long lines split into sentences). Empty text → no units. */
export function splitUnits(text: string, longLine = DIFF_LIMITS.longLine): string[] {
  if (text === '') return []
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.length <= longLine / 4 || estimateTokens(line) * 4 <= longLine) {
      out.push(line)
      continue
    }
    const indent = /^\s*/.exec(line)?.[0] ?? ''
    const parts = line.slice(indent.length).split(SENTENCE_END).filter((p) => p !== '')
    if (parts.length <= 1) {
      out.push(line)
      continue
    }
    out.push(indent + parts[0])
    for (let i = 1; i < parts.length; i++) out.push(parts[i])
  }
  return out
}

/** Shared work counter: callers can give several diffs one budget (e.g. one feed call). */
export interface WorkBudget {
  left: number
}

/**
 * Myers' greedy shortest edit script between a and b. Returns null when the edit distance exceeds
 * maxD or the work budget runs out. Memory O(D²) (one copy of the frontier per step), time
 * O((N+M)·D).
 */
export function myers(a: string[], b: string[], maxD: number, work: WorkBudget = { left: Infinity }): DiffOp[] | null {
  const n = a.length
  const m = b.length
  const lim = Math.min(n + m, maxD)
  const off = lim + 1
  const v = new Int32Array(2 * lim + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= lim; d++) {
    // Only the slice [off-d-1, off+d+1] is read by step d's backtrack; copying it keeps memory O(D²).
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      const x0 = x
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      work.left -= 1 + (x - x0)
      if (work.left < 0) return null
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(a, b, trace, d)
    }
  }
  return null
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dEnd: number): DiffOp[] {
  const ops: DiffOp[] = []
  let x = a.length
  let y = b.length
  for (let d = dEnd; d >= 0; d--) {
    const snap = trace[d]
    // snap[i] holds v[k] for k = i - d - 1
    const at = (k: number) => snap[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ t: '=', s: a[x - 1] })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', s: b[y - 1] })
      else ops.push({ t: '-', s: a[x - 1] })
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

export interface DiffResult {
  /** True when a cap was hit: print "large change, read section" instead. */
  large: boolean
  /** Formatted hunk lines ('- x', '+ y', '  context', '…'). */
  lines: string[]
  added: number
  removed: number
}

/**
 * Edit script between two texts (units), or null when over the caps. `shared` (optional) is a
 * work budget across several diffs; this diff uses at most min(limits.maxWork, shared.left).
 */
export function diffOps(before: string, after: string, limits = DIFF_LIMITS, shared?: WorkBudget): DiffOp[] | null {
  const a = splitUnits(before, limits.longLine)
  const b = splitUnits(after, limits.longLine)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  if (am.length > limits.maxUnits || bm.length > limits.maxUnits) return null
  const start = Math.min(limits.maxWork, shared?.left ?? Infinity)
  const work = { left: start }
  const mid = myers(am, bm, limits.maxD, work)
  if (shared) shared.left -= start - Math.max(0, work.left)
  if (!mid) return null
  return [
    ...a.slice(0, pre).map((s): DiffOp => ({ t: '=', s })),
    ...mid,
    ...a.slice(a.length - suf).map((s): DiffOp => ({ t: '=', s })),
  ]
}

function contextLine(s: string, max: number): string {
  const t = s.length > max ? `${s.slice(0, max)}…` : s
  return `  ${t}`
}

/** Hunks with at most one context line (the unchanged unit right before the hunk, if non-blank). */
export function formatHunks(ops: DiffOp[], contextChars = DIFF_LIMITS.contextChars): string[] {
  const lines: string[] = []
  let i = 0
  let lastEnd = -1 // index after the previous hunk; -1 before the first one
  while (i < ops.length) {
    if (ops[i].t === '=') {
      i++
      continue
    }
    const ctxIdx = i - 1
    const hasCtx = ctxIdx >= 0 && ctxIdx >= lastEnd && ops[ctxIdx].s.trim() !== ''
    if (lastEnd >= 0) {
      const skipped = (hasCtx ? ctxIdx : i) - lastEnd
      if (skipped > 0) lines.push('…')
    }
    if (hasCtx) lines.push(contextLine(ops[ctxIdx].s, contextChars))
    // Removed units first, then added, within one run of changes (reads like a replacement).
    const plus: string[] = []
    while (i < ops.length && ops[i].t !== '=') {
      if (ops[i].t === '-') lines.push(`- ${ops[i].s}`)
      else plus.push(`+ ${ops[i].s}`)
      i++
    }
    lines.push(...plus)
    lastEnd = i
  }
  return lines
}

/** Diff two section bodies into compact hunk lines (see the module comment). */
export function diffText(before: string, after: string, limits = DIFF_LIMITS, shared?: WorkBudget): DiffResult {
  if (before === after) return { large: false, lines: [], added: 0, removed: 0 }
  const ops = diffOps(before, after, limits, shared)
  if (!ops) return { large: true, lines: [], added: 0, removed: 0 }
  let added = 0
  let removed = 0
  for (const o of ops) {
    if (o.t === '+') added++
    else if (o.t === '-') removed++
  }
  return { large: false, lines: formatHunks(ops, limits.contextChars), added, removed }
}
