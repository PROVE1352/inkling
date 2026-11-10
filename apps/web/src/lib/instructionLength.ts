// Length warning for agent instruction pages (docs/adr/2021-*, 2004-*).
//
// get_instructions returns every `always` instruction page in full at the start of an agent's work in a
// workspace, so a long page costs every session. The server measures each page on the Markdown agents get
// (GET /api/workspaces/:id/agent-instructions/length) and says when it is long (`long`: more than 200
// lines or 25 KB); this module only picks a page's entry and decides what the UI shows.

/** One instruction page's size as the server measured it. */
export interface InstructionLength {
  lines: number
  bytes: number
  /** The server's token estimate, for display only. */
  tokens: number
  /** The server's rule: lines > limits.lines or bytes > limits.bytes. */
  long: boolean
}

/** GET /workspaces/:id/agent-instructions/length (apps/server/src/routes/instructionLength.ts). */
export interface InstructionLengthsDTO {
  limits: { lines: number; bytes: number }
  always: InstructionLength & { pages: number }
  pages: (InstructionLength & { pageId: string; mode: 'always' | 'match' | 'manual'; truncated: boolean })[]
}

/** The server's length report on one instruction page, or null when it has none. */
export function instructionLengthOf(lengths: InstructionLengthsDTO | null | undefined, pageId: string | null | undefined): InstructionLength | null {
  if (!lengths || !pageId) return null
  const p = lengths.pages.find((x) => x.pageId === pageId)
  return p ? { lines: p.lines, bytes: p.bytes, tokens: p.tokens, long: p.long } : null
}

/** True when the page should show the "make it a short index" warning (the server's `long`). */
export function isInstructionLong(len: InstructionLength | null | undefined): len is InstructionLength {
  return !!len && len.long === true && Number.isFinite(len.tokens)
}

/** Rounded token count for display ("~4,200"), never more precise than the server's estimate deserves. */
export function roundTokens(n: number): number {
  if (n < 1000) return Math.round(n / 10) * 10
  return Math.round(n / 100) * 100
}
