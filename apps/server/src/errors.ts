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
