import {
  DEV_BUILD,
  forceDecision,
  inCooldown,
  isBuildMismatch,
  normalizeMode,
  type UpdateMode,
} from './updatePolicy'

// Client/server version check and update handling (docs/adr/0990-0993).
//
// Two independent signals put the tab into "update available":
//   1. build: an /api response carries X-Inkling-Build different from the id compiled into this
//      bundle (noteServerBuild, called from api.ts). Works with or without a service worker.
//   2. sw: a new service worker is waiting / another tab activated one (lib/pwa.ts).
// Both feed this one store, rendered by components/UpdateBanner.tsx at the app root — so the
// notice exists on every route (login, settings, public pages) and is shown once.
//
// UPDATE_MODE (server env, read from GET /api/version):
//   prompt (default) — banner "A new version is available · Reload".
//   force — reload by itself once nothing local is unsaved (collab docs acknowledged, no API
//           mutation in flight, user idle); a tab opened on an old bundle reloads at once. Falls
//           back to the banner after FORCE_MAX_WAIT_MS or when an automatic reload just happened
//           (loop guard, sessionStorage).

declare const __INKLING_BUILD__: string
declare const __INKLING_VERSION__: string

/** Build id compiled into this bundle (vite.config.ts); 'dev' in the dev server and tests. */
export const CLIENT_BUILD: string =
  typeof __INKLING_BUILD__ === 'string' && !import.meta.env?.DEV ? __INKLING_BUILD__ : DEV_BUILD
/** Release version of this bundle (apps/web/package.json); 'dev' under the Vite dev server. */
export const CLIENT_VERSION: string = typeof __INKLING_VERSION__ === 'string' ? __INKLING_VERSION__ : 'dev'

export type UpdateSnapshot = {
  /** A newer build exists (server header or service worker). */
  available: boolean
  /** The banner should be shown now. */
  bannerVisible: boolean
  /** A reload is being prepared (service worker swap in progress). */
  applying: boolean
  mode: UpdateMode
}

let mode: UpdateMode = 'prompt'
let modeKnown = false
let available = false
let applying = false
let autoApplying = false
let dismissed = false
let forceGaveUp = false
let lastServerBuild: string | null = null

let snapshot: UpdateSnapshot = { available: false, bannerVisible: false, applying: false, mode }
const listeners = new Set<() => void>()

function emit() {
  const bannerVisible =
    // Hidden until the mode is known (main.tsx sets 'prompt' if /api/version fails), so a
    // force-mode tab that reloads right away never flashes the banner.
    // A force-mode automatic reload stays silent (no flash of the banner during the SW swap).
    available && !dismissed && modeKnown && (mode === 'prompt' || forceGaveUp || (applying && !autoApplying))
  const next: UpdateSnapshot = { available, bannerVisible, applying, mode }
  if (
    next.available === snapshot.available &&
    next.bannerVisible === snapshot.bannerVisible &&
    next.applying === snapshot.applying &&
    next.mode === snapshot.mode
  ) {
    return
  }
  snapshot = next
  for (const l of listeners) l()
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getUpdateSnapshot(): UpdateSnapshot {
  return snapshot
}

// ---------------------------------------------------------------------------
// Hooks into the rest of the app (set from main.tsx / pwa.ts, no imports back into them)
// ---------------------------------------------------------------------------

type Reloader = () => Promise<void>
let reloader: Reloader = async () => {
  window.location.reload()
}
let prefetcher: () => void = () => {}
const safetyChecks: Array<() => boolean> = []

/** pwa.ts: how to reload into the new build (service worker swap) and how to start fetching it. */
export function setUpdateTransport(reload: Reloader, prefetch: () => void): void {
  reloader = reload
  prefetcher = prefetch
}

/** Extra "safe to reload" conditions (e.g. no React Query mutation in flight). */
export function addUpdateSafetyCheck(check: () => boolean): void {
  safetyChecks.push(check)
}

let collabPendingCheck: () => boolean = () => false
/** collabSocket.ts: whether some collaborative document has unacknowledged updates. */
export function setCollabPendingCheck(check: () => boolean): void {
  collabPendingCheck = check
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Mark "update available". A new signal re-arms a dismissed banner. */
function markAvailable(prefetch: boolean): void {
  available = true
  dismissed = false
  // Start fetching the new service worker so "Reload" is quick (lib/pwa.ts).
  if (prefetch) prefetcher()
  emit()
  if (mode === 'force' && modeKnown) startForce()
}

/** api.ts: every /api response. Cheap: one header read + string compare. */
export function noteServerBuild(headers: Headers): void {
  const server = headers.get('x-inkling-build')
  if (!isBuildMismatch(CLIENT_BUILD, server)) return
  if (available && server === lastServerBuild) return
  lastServerBuild = server
  markAvailable(true)
}

/** pwa.ts: a new service worker is installed and waiting, or another tab activated one. */
export function noteServiceWorkerUpdate(): void {
  markAvailable(false)
}

/** main.tsx: GET /api/version answered. */
export function setUpdateMode(value: unknown): void {
  mode = normalizeMode(value)
  modeKnown = true
  emit()
  if (available && mode === 'force') startForce()
}

/** Banner "Later": hide until the next signal (new deploy / new service worker) or 30 minutes. */
export function dismissUpdate(): void {
  dismissed = true
  emit()
  window.setTimeout(() => {
    if (!dismissed) return
    dismissed = false
    emit()
  }, 30 * 60 * 1000)
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

const AUTO_RELOAD_KEY = 'inkling:update-reload'

function lastAutoReload(): number {
  try {
    return Number(sessionStorage.getItem(AUTO_RELOAD_KEY) ?? 0) || 0
  } catch {
    return 0
  }
}

function rememberAutoReload(): void {
  try {
    sessionStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()))
  } catch {
    // storage unavailable — the loop guard is best effort
  }
}

/** Reload into the new build (banner button, or force mode at a safe moment). */
export async function applyUpdate(auto = false): Promise<void> {
  if (applying) return
  applying = true
  autoApplying = auto
  emit()
  if (auto) rememberAutoReload()
  try {
    await reloader()
  } catch {
    window.location.reload()
  }
}

// ---------------------------------------------------------------------------
// Force mode
// ---------------------------------------------------------------------------

const bootAt = Date.now()
let userActed = false
let lastActivityAt = 0
let forceTimer = 0
let waitingSince = 0

if (typeof window !== 'undefined') {
  const onActivity = () => {
    userActed = true
    lastActivityAt = Date.now()
  }
  for (const type of ['keydown', 'pointerdown', 'input', 'compositionupdate', 'wheel'] as const) {
    window.addEventListener(type, onActivity, { capture: true, passive: true })
  }
}

function giveUp(): void {
  window.clearInterval(forceTimer)
  forceTimer = 0
  forceGaveUp = true
  emit()
}

function stepForce(): void {
  const decision = forceDecision({
    now: Date.now(),
    bootAt,
    userActed,
    lastActivityAt,
    collabPending: collabPendingCheck(),
    mutating: !safetyChecks.every((c) => c()),
    waitingSince,
  })
  if (decision === 'wait') return
  if (decision === 'give-up') {
    giveUp()
    return
  }
  window.clearInterval(forceTimer)
  forceTimer = 0
  void applyUpdate(true)
}

function startForce(): void {
  if (forceTimer || applying || forceGaveUp) return
  // Loop guard: an automatic reload a moment ago did not bring the new build (stale cache/CDN,
  // a server mid-rollout) — stop reloading and let the user decide.
  if (inCooldown(lastAutoReload(), Date.now())) {
    giveUp()
    return
  }
  waitingSince = Date.now()
  forceTimer = window.setInterval(stepForce, 1000)
  stepForce()
}
