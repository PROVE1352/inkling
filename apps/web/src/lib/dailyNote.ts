import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useCreatePage, usePages } from '../api'
import { t } from '../i18n'
import { todayISODate } from './time'

// Daily-note folder in the private section (kind=folder, scope=private).
// New folders get the localized name (t('daily.folderName')). When looking for an existing folder,
// these names are accepted too, so an install created in another language (or before i18n, when the
// folder was always '데일리') keeps using its folder instead of getting a second one.
// Data, not UI: these match titles already stored in existing workspaces.
const KNOWN_DAILY_FOLDERS = ['데일리', 'Daily']

// Open/create a daily note — ensures the private daily folder exists, then finds or creates the page
// titled with the given date (YYYY-MM-DD, default today) and navigates to it. Shared by the sidebar
// "📅 Today" button and the [＋] on empty days of the global calendar (M18). Dates use the local
// 'YYYY-MM-DD' string convention (M3/M9/M17). `busy` blocks repeated clicks while loading.
//
// The note TITLE stays ISO 'YYYY-MM-DD' in every language: the server (md/dateItems.ts) detects daily
// notes by exactly that title, and the calendar matches on it.
export function useDailyNote(wsId: string) {
  const navigate = useNavigate()
  const pages = usePages(wsId)
  const createPage = useCreatePage(wsId)
  const [busy, setBusy] = useState(false)

  // Without a date, today. Past/future dates open or create the same way (clicking any day in the calendar).
  const openDaily = (date?: string) => {
    if (busy) return
    const list = pages.data ?? []
    const day = date ?? todayISODate()
    setBusy(true)

    const goToDay = (folderId: string) => {
      const existing = list.find(
        (p) => p.parentId === folderId && p.title === day && !p.deletedAt,
      )
      if (existing) {
        navigate(`/w/${wsId}/p/${existing.id}`)
        setBusy(false)
        return
      }
      createPage.mutate(
        { workspaceId: wsId, parentId: folderId, kind: 'doc', title: day },
        {
          onSuccess: (page) => navigate(`/w/${wsId}/p/${page.id}`),
          onSettled: () => setBusy(false),
        },
      )
    }

    const folderName = t('daily.folderName')
    const isDailyFolder = (title: string) => (p: (typeof list)[number]) =>
      p.kind === 'folder' && p.scope === 'private' && p.title === title && !p.deletedAt
    // Prefer the folder in the current language, then any known name from another language.
    const folder =
      list.find(isDailyFolder(folderName)) ??
      KNOWN_DAILY_FOLDERS.map((n) => list.find(isDailyFolder(n))).find((p) => p !== undefined)
    if (folder) {
      goToDay(folder.id)
    } else {
      createPage.mutate(
        { workspaceId: wsId, kind: 'folder', scope: 'private', title: folderName },
        {
          onSuccess: (f) => goToDay(f.id),
          onError: () => setBusy(false),
        },
      )
    }
  }

  return { openDaily, busy }
}
