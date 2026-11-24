import { SIDEBAR_MENU_DEFAULT_HIDDEN, type SidebarMenuId } from '@inkling/shared'

// The sidebar's default menus for someone whose agent has connected (docs/adr/2390-*): the activity menu,
// whose screen leads to the team agents board, joins search, later, due and calendar. Only a default:
// it applies while the person never arranged the sidebar (nothing stored, docs/adr/1641-*); a stored
// arrangement keeps its meaning. Someone with no agent sees the default of 0.13 as before. One function
// for the three places that read the default (the sidebar, its right-click "hide", Settings › Sidebar),
// so hiding another menu never takes this one with it.

/** The menu that shows by default once an agent is connected. */
export const AGENT_DEFAULT_MENU: SidebarMenuId = 'activity'

const CONNECTED_DEFAULT_HIDDEN: readonly SidebarMenuId[] = SIDEBAR_MENU_DEFAULT_HIDDEN.filter((id) => id !== AGENT_DEFAULT_MENU)

/** Menus hidden while nothing is stored, for a person with or without a connected agent. */
export function sidebarDefaultHidden(agentConnected: boolean | null | undefined): readonly SidebarMenuId[] {
  return agentConnected ? CONNECTED_DEFAULT_HIDDEN : SIDEBAR_MENU_DEFAULT_HIDDEN
}
