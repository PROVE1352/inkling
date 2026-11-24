// Trial accounts (TRIAL_ACCOUNTS, docs/adr/2555-*): the pure parts of the "Try without an account"
// button and the trial badge, kept apart so they can be tested without a browser.

/** The server refuses a trial (and a sign-up with bot checks) sent within this long of the screen appearing. */
export const TRIAL_MIN_FORM_MS = 2_000
/** A little over the minimum, so a clock that ticks coarsely still lands past it. */
const MARGIN_MS = 50

/**
 * How long the button waits before sending, given when the screen appeared (`shownAt`) and the click
 * (`now`): 0 once the screen has been up long enough, otherwise the rest. A person who clicks at once
 * sees the spinner a moment longer instead of a 400 SIGNUP_CHECK_FAILED.
 */
export function trialDelayMs(shownAt: number, now: number): number {
  const left = TRIAL_MIN_FORM_MS + MARGIN_MS - (now - shownAt)
  return left > 0 ? left : 0
}

/** `formMs` as sent: the time the screen has been up when the request leaves. */
export function trialFormMs(shownAt: number, sentAt: number): number {
  return Math.max(0, Math.round(sentAt - shownAt))
}

/**
 * Whole hours until the account is deleted, rounded up ("deleted in 24 h" right after it is made, "1 h"
 * in its last hour), 0 once the time has passed, null for a date that does not parse.
 */
export function hoursLeft(expiresAt: string, now: number): number | null {
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return null
  const ms = at - now
  return ms <= 0 ? 0 : Math.ceil(ms / 3_600_000)
}

/** The translation key of a trial error the button or a refused action shows, or null for any other code. */
export function trialErrorKey(code: string): string | null {
  switch (code) {
    case 'TRIAL_RESTRICTED':
    case 'TRIAL_FULL':
    case 'TRIAL_NEEDS_CONSENT':
    case 'TRIAL_OFF':
    case 'ALREADY_SIGNED_IN':
      return `errors.${code}`
    default:
      return null
  }
}

/** Where the button goes after the account is made: the sample page, else the workspace. */
export function trialLandingPath(r: { workspaceId: string; samplePageId: string | null }): string {
  return r.samplePageId ? `/w/${r.workspaceId}/p/${r.samplePageId}` : `/w/${r.workspaceId}`
}
