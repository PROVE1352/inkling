/**
 * Hand-rolled argv parser (no external dependencies).
 *
 * Supported forms:
 *   - `--key value`   (consumes the next token as the value only when key is in valueFlags)
 *   - `--key=value`   (always a value)
 *   - `--flag`        (boolean true)
 *   - positional arguments
 */
export interface ParsedArgs {
  command: string | undefined
  flags: Record<string, string | boolean>
  positionals: string[]
}

export function parseArgs(argv: string[], valueFlags: Set<string>): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  let command: string | undefined

  let i = 0
  for (; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (valueFlags.has(body)) {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`Option --${body} requires a value`)
        }
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }
    if (command === undefined) {
      command = token
    } else {
      positionals.push(token)
    }
  }

  return { command, flags, positionals }
}

/** Safely read a string flag value (undefined if it is a boolean). */
export function strFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

/** Whether a boolean flag is set. */
export function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}
