/**
 * Experimental feature flags.
 *
 * Features marked "experimental" are only registered (server routes) and exposed (UI) when
 * their name is listed in the comma-separated env `EXPERIMENTAL_FEATURES`, e.g.
 *   EXPERIMENTAL_FEATURES=vault-sync,plugins,sheets-sync
 * Names are case-insensitive and whitespace is ignored. The list is read once at boot.
 */
// Importing env first guarantees dotenv has loaded .env before we read process.env.
import './env'

const enabled: ReadonlySet<string> = new Set(
  (process.env.EXPERIMENTAL_FEATURES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

/** True when `name` is listed in EXPERIMENTAL_FEATURES. */
export function isExperimentalEnabled(name: string): boolean {
  return enabled.has(name.toLowerCase())
}

/** All enabled experimental feature names (sorted) — exposed to the web via /api/auth/mode. */
export function enabledExperimentalFeatures(): string[] {
  return [...enabled].sort()
}
