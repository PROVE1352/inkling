import type { ReactNode } from 'react'
import type { SidebarMenuId } from '@inkling/shared'
import type { TKey } from '../i18n'
import {
  AlarmIcon,
  CalendarDayIcon,
  CalendarIcon,
  ClockIcon,
  GlobeIcon,
  GraphIcon,
  HistoryIcon,
  MessageIcon,
  SearchIcon,
  TagIcon,
} from './Icons'

// Label and icon of each customizable top-of-sidebar menu (docs/adr/1020-*), shared by the sidebar,
// its right-click menu and Settings → Sidebar. The default order lives in SIDEBAR_MENU_IDS (shared).
export const SIDEBAR_MENU_META: Record<SidebarMenuId, { label: TKey; icon: (size: number) => ReactNode }> = {
  search: { label: 'common.search', icon: (s) => <SearchIcon size={s} /> },
  later: { label: 'sidebar.later', icon: (s) => <ClockIcon size={s} /> },
  threads: { label: 'sidebar.threads', icon: (s) => <MessageIcon size={s} /> },
  graph: { label: 'sidebar.graph', icon: (s) => <GraphIcon size={s} /> },
  tags: { label: 'sidebar.tags', icon: (s) => <TagIcon size={s} /> },
  shared: { label: 'sidebar.webShares', icon: (s) => <GlobeIcon size={s} /> },
  due: { label: 'sidebar.due', icon: (s) => <AlarmIcon size={s} /> },
  calendar: { label: 'sidebar.calendar', icon: (s) => <CalendarIcon size={s} /> },
  activity: { label: 'activity.title', icon: (s) => <HistoryIcon size={s} /> },
  today: { label: 'common.today', icon: (s) => <CalendarDayIcon size={s} /> },
}

export const isSidebarMenuId = (id: string): id is SidebarMenuId => id in SIDEBAR_MENU_META
