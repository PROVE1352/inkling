/**
 * A version or hash argument as an agent pastes it from tool output (0.24.1): tools print versions as
 * `v=abc123…`, so `v=abc123…`, `V= abc123…` and `abc123…` are the same version. Like changes_since's
 * `cursorArg` (mcpTools/changeTools.ts), only the printed prefix and spaces are dropped: anything
 * else is compared as given, so a stale version still conflicts.
 */
export function versionArg(raw: string): string
export function versionArg(raw: string | undefined): string | undefined
export function versionArg(raw: string | undefined): string | undefined {
  if (raw === undefined) return raw
  const t = raw.trim().replace(/^v\s*=\s*/i, '')
  return t || raw.trim()
}
