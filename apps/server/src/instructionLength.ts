import { estimateTokens } from './context/tokens'

/**
 * How long agent instructions are (docs/adr/2004-*).
 *
 * get_instructions returns every `always` instruction page (and, with forPageId, every matching one)
 * in full at the start of an agent's work in a workspace, so their length is paid by every session.
 * The limit follows a reference another agent tool uses for a file read at the start of every
 * session: its auto-memory index is read only up to the first 200 lines or 25 KB. Past either,
 * the rules at the end are the ones a client of that kind would not see, and the text is long for
 * something every session pays for. Lines are newline-separated lines of the Markdown an agent
 * receives (blank ones included, as a file's lines are); bytes are its UTF-8 size; tokens use the
 * server's estimator (context/tokens.ts) for display only.
 */

export const INSTRUCTION_WARN_LINES = 200
export const INSTRUCTION_WARN_BYTES = 25_000

export interface InstructionLength {
  lines: number
  bytes: number
  tokens: number
  /** lines > INSTRUCTION_WARN_LINES or bytes > INSTRUCTION_WARN_BYTES */
  long: boolean
}

export function measureInstructions(texts: string[]): InstructionLength {
  let lines = 0
  let bytes = 0
  let tokens = 0
  for (const t of texts) {
    if (!t) continue
    lines += t.split('\n').length
    bytes += Buffer.byteLength(t, 'utf8')
    tokens += estimateTokens(t)
  }
  return { lines, bytes, tokens, long: lines > INSTRUCTION_WARN_LINES || bytes > INSTRUCTION_WARN_BYTES }
}

const kb = (bytes: number) => `${Math.round(bytes / 100) / 10} KB`

/**
 * The one line get_instructions ends with when the instructions it returned in full are long, else
 * null. Deterministic: the same bodies give the same line.
 */
export function instructionLengthNote(texts: string[]): string | null {
  const m = measureInstructions(texts)
  if (!m.long) return null
  return (
    `note: the instructions above are ${m.lines} lines, ${kb(m.bytes)} (~${m.tokens} tok), past the ${INSTRUCTION_WARN_LINES} lines or ` +
    `${INSTRUCTION_WARN_BYTES / 1000} KB that some agent tools read of such files; follow all of them, and tell the person a workspace ` +
    'owner or admin could shorten them or move details to on-request instructions.'
  )
}
