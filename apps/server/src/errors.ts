/** Application error carrying the error code/status of the API contract (docs/API.md). */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    /** Retry-After (seconds) for 429 responses */
    public readonly retryAfter?: number,
    /** Extra fields merged into the `error` object of the response (e.g. a list to act on). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code)
    this.name = 'AppError'
  }
}

export const unauthorized = (message = 'Sign-in required') =>
  new AppError(401, 'UNAUTHORIZED', message)

export const forbidden = (message = 'Permission denied') =>
  new AppError(403, 'FORBIDDEN', message)

export const notFound = (code = 'NOT_FOUND', message = 'Not found') =>
  new AppError(404, code, message)

export const badRequest = (message = 'Invalid request') =>
  new AppError(400, 'VALIDATION', message)

export const conflict = (code: string, message?: string) =>
  new AppError(409, code, message)

/** A drizzle DrizzleQueryError (0.45): the failed SQL text, its bound values and the driver's error. */
type QueryError = Error & { query: string; params: unknown[]; cause?: unknown }

function isQueryError(err: unknown): err is QueryError {
  return (
    err instanceof Error &&
    typeof (err as Partial<QueryError>).query === 'string' &&
    Array.isArray((err as Partial<QueryError>).params)
  )
}

function paramText(p: unknown): string {
  try {
    if (typeof p === 'string') return p
    if (p instanceof Date) return p.toISOString()
    if (p === null || p === undefined || typeof p === 'number' || typeof p === 'boolean' || typeof p === 'bigint') return String(p)
    if (Buffer.isBuffer(p)) return ''
    return JSON.stringify(p) ?? ''
  } catch {
    return ''
  }
}

/**
 * The form of an error to log (0.25.4 security fix F-4). drizzle wraps every failed query in a
 * DrizzleQueryError whose message, stack and `params` field carry the query's bound values: emails,
 * page text, webhook URLs stored unsealed without APP_SECRET_KEY, tokens. For such an error this
 * returns a new Error with the SQL text (placeholders only), the Postgres error code and its message
 * with any bound value cut out (an input-syntax error quotes the value), and the original stack
 * frames. `detail` and `where` of the Postgres error (a unique violation's key value) are left out.
 * Any other value is returned as it is.
 */
export function logSafeError(err: unknown): unknown {
  if (!isQueryError(err)) return err
  const values = err.params.map(paramText).filter((v) => v.length >= 4)
  const scrub = (s: string) => values.reduce((acc, v) => acc.split(v).join('***'), s)
  const cause = (err.cause ?? null) as { code?: unknown; message?: unknown; constraint_name?: unknown; table_name?: unknown; column_name?: unknown } | null
  const code = typeof cause?.code === 'string' ? cause.code : undefined
  const causeText = cause ? `${code ?? ''} ${scrub(String(cause.message ?? ''))}`.trim() : ''
  const safe = new Error(`Failed query: ${err.query}${causeText ? `\ncause: ${causeText}` : ''}`) as Error & Record<string, unknown>
  safe.name = 'DrizzleQueryError'
  const frames = (err.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l))
  safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join('\n')
  if (code) safe.code = code
  for (const k of ['constraint_name', 'table_name', 'column_name'] as const) {
    if (typeof cause?.[k] === 'string') safe[k] = cause[k]
  }
  return safe
}
