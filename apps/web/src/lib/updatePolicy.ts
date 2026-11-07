// Pure decisions behind lib/update.ts (docs/adr/0991-*, 0992-*), kept free of DOM/timers so they
// can be unit-tested.

export type UpdateMode = 'prompt' | 'force'

/** Build id compiled into a dev bundle / sent by a server that does not know its build. */
export const DEV_BUILD = 'dev'

export function normalizeMode(v: unknown): UpdateMode {
  return v === 'force' ? 'force' : 'prompt'
}

/**
 * Whether a server build id means "this tab runs another build". Missing / dev ids on either side
 * never count: a dev server, a server without build.json, or a dev bundle must not nag.
 */
export function isBuildMismatch(clientBuild: string, serverBuild: string | null | undefined): boolean {
  if (!serverBuild || serverBuild === DEV_BUILD) return false
  if (!clientBuild || clientBuild === DEV_BUILD) return false
  return serverBuild !== clientBuild
}

/** Automatic reloads closer together than this are treated as a loop: show the banner instead. */
export const AUTO_RELOAD_COOLDOWN_MS = 5 * 60 * 1000

export function inCooldown(lastReloadAt: number, now: number): boolean {
  return lastReloadAt > 0 && now - lastReloadAt >= 0 && now - lastReloadAt < AUTO_RELOAD_COOLDOWN_MS
}

/** Force mode: within this long after page start, with no user input yet, reload at once. */
export const BOOT_WINDOW_MS = 15_000
/** Force mode: the user must have been idle this long (no keys / pointer) before a reload. */
export const IDLE_MS = 3_000
/** Force mode: give up waiting for a safe moment after this long and show the banner. */
export const FORCE_MAX_WAIT_MS = 2 * 60 * 1000

export type ForceInput = {
  now: number
  bootAt: number
  /** Any key / pointer / input event since page start. */
  userActed: boolean
  lastActivityAt: number
  /** Some collaborative document has updates the server has not acknowledged (or is mid-sync). */
  collabPending: boolean
  /** API mutations in flight (React Query). */
  mutating: boolean
  waitingSince: number
}

export type ForceDecision = 'reload' | 'wait' | 'give-up'

/**
 * Force-mode step: reload now, keep waiting, or give up (banner). A freshly opened tab that has
 * not been touched reloads immediately (it is the old bundle served from cache); otherwise only
 * when nothing local is unsaved and the user is idle.
 */
export function forceDecision(i: ForceInput): ForceDecision {
  if (!i.userActed && i.now - i.bootAt <= BOOT_WINDOW_MS && !i.mutating) return 'reload'
  const safe = !i.collabPending && !i.mutating && i.now - i.lastActivityAt >= IDLE_MS
  if (safe) return 'reload'
  if (i.now - i.waitingSince >= FORCE_MAX_WAIT_MS) return 'give-up'
  return 'wait'
}
