import { useSyncExternalStore } from 'react'

// "Your agent is connected" (docs/adr/2390-*): the server reports `agentConnected` in the onboarding
// answer once an agent of the person's has made its first authenticated /mcp request. The app says so
// once, at the moment it changes while the app is open: an answer of this page load said false and a
// later one says true. Someone connected before (true in the first answer) is never told, and neither
// is a page load that only ever saw true. The app shell shows it as a toast (onboarding/Host.tsx); the
// connections screen, which is outside the shell, shows the same line under its setup steps.

/** The notice is due: this load saw "not connected" and now sees "connected". undefined = not known yet. */
export function agentJustConnected(prev: boolean | undefined, next: boolean | undefined): boolean {
  return prev === false && next === true
}

type NoticeState = { due: boolean; shown: boolean }
let state: NoticeState = { due: false, shown: false }
/** Whose notice `state` is: another account signed in in the same tab starts from nothing. */
let stateUser: string | null = null
const lastSeen = new Map<string, boolean>()
const listeners = new Set<() => void>()

function set(next: NoticeState) {
  state = next
  for (const l of listeners) l()
}

/** Every onboarding answer for this person passes through here (onboarding/api.ts). */
export function observeAgentConnected(userId: string, connected: boolean | undefined): void {
  if (!userId || connected === undefined) return
  if (stateUser !== userId) {
    stateUser = userId
    if (state.due) set({ due: false, shown: false })
  }
  const prev = lastSeen.get(userId)
  lastSeen.set(userId, connected)
  if (agentJustConnected(prev, connected) && !state.due) set({ due: true, shown: false })
}

/** Whether the notice became due in this load, and whether a place already showed it. */
export function agentNoticeState(): NoticeState {
  return state
}

/** The same, for a component (re-renders when it changes). */
export function useAgentNotice(): NoticeState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
    () => state,
  )
}

/** A place showed it (the toast, or the line on the connections screen): the other does not repeat it. */
export function markAgentNoticeShown(): void {
  if (state.due && !state.shown) set({ due: true, shown: true })
}

/** Tests: a fresh page load. */
export function resetAgentNoticeForTests(): void {
  lastSeen.clear()
  stateUser = null
  state = { due: false, shown: false }
}
