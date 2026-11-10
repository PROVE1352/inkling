// "Keep offline copies on this device" (docs/adr/2203-*). Per device, in localStorage.
//
// Default: on in the installed app (display-mode standalone: someone installed Inkling on this
// device, which is a strong sign it is theirs), off in a browser tab, where a shared or public
// computer is likely. Whatever is chosen, logging out, an expired or revoked session, and another
// account signing in delete every copy.

const KEY = 'inkling:offlineCopies'

export type OfflineChoice = 'on' | 'off' | null

export function readChoice(): OfflineChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'on' || v === 'off' ? v : null
  } catch {
    return null
  }
}

export function writeChoice(v: 'on' | 'off'): void {
  try {
    localStorage.setItem(KEY, v)
  } catch {
    // storage blocked: the default applies again next time
  }
}

export function isInstalledApp(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    )
  } catch {
    return false
  }
}

/** The effective setting: the choice, or the default for how the app runs. */
export function defaultEnabled(choice: OfflineChoice, installed: boolean): boolean {
  if (choice === 'on') return true
  if (choice === 'off') return false
  return installed
}
