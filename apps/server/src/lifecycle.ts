/**
 * Process lifecycle helpers shared by index.ts and collab.ts (docs/adr/0805-*).
 */
export const lifecycle = {
  /** Set first thing on SIGTERM/SIGINT/uncaughtException: new collab upgrades get 503. */
  shuttingDown: false,
}

/** Resolves `p`, or rejects after `ms` with a labelled timeout error. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

/**
 * Runs `fn` up to `attempts` times with exponential backoff (base, 2·base, …) and rethrows the
 * last error. Used for the collab store write so a short database blip does not lose edits.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3
  const base = opts.baseMs ?? 250
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (i === attempts - 1) break
      opts.onRetry?.(err, i + 1)
      await new Promise((r) => setTimeout(r, base * 2 ** i))
    }
  }
  throw last
}
