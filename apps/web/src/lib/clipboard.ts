// Clipboard copy — insecure origins (e.g. http://<mac-ip>:3000 opened from a phone) have no
// navigator.clipboard, so an execCommand fallback is included.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Invite code → join link on the current origin.
export function inviteLink(code: string): string {
  return `${location.origin}/join/${code}`
}
