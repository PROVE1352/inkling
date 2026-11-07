import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import type {
  CalendarEventDTO,
  DateItemDTO,
  DateItemKind,
  DueItemDTO,
  DueResponseDTO,
  DueSection,
} from '@inkling/shared'
import { api, qk } from '../api'
import { fmtDate, parseYmd, t } from '../i18n'
import { toast } from './toast'
import { daysFromToday } from './time'

// Shared by the global calendar and the due view: display rules for date items + rescheduling and
// completion (optimistic update + undo).
// Values follow the local 'YYYY-MM-DD' string convention (M3/M9/M17) — no Date comparisons or UTC conversion.

/** Kind labels. Getters, so every read is translated in the current language (never at import time). */
export const KIND_LABEL: Record<DateItemKind, string> = {
  get row() {
    return t('dates.kindRow')
  },
  get page() {
    return t('dates.kindPage')
  },
  get daily() {
    return t('dates.kindDaily')
  },
  get task() {
    return t('dates.kindTask')
  },
}

/** Chip colour (background + text) and legend dot colour per kind */
export const KIND_CHIP: Record<DateItemKind, string> = {
  row: 'bg-accent-soft text-accent',
  page: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  daily: 'bg-green-500/15 text-green-600 dark:text-green-400',
  task: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
}
export const KIND_DOT: Record<DateItemKind, string> = {
  row: 'bg-accent',
  page: 'bg-violet-500',
  daily: 'bg-green-500',
  task: 'bg-amber-500',
}

/** Item identity key (tells apart other date fields of the same row and other tasks in the same document) */
export function itemKey(it: DateItemDTO): string {
  return `${it.kind}:${it.pageId}:${it.blockId ?? it.fieldId ?? ''}:${it.date}`
}

/** Can it be rescheduled (dragged)? — daily notes are not, since their title is the date. */
export function canReschedule(it: DateItemDTO): boolean {
  if (it.kind === 'daily') return false
  if (it.kind === 'task') return !!it.blockId
  return !!it.fieldId
}

/** Can it be checked off? — rows only when the collection has a checkbox field. */
export function canComplete(it: DateItemDTO): boolean {
  if (it.kind === 'task') return !!it.blockId
  if (it.kind === 'row') return !!it.doneFieldId
  return it.kind === 'page'
}

/** Path that opens the item — tasks scroll to and highlight their block (?block=). */
export function itemHref(wsId: string, it: DateItemDTO): string {
  const base = `/w/${wsId}/p/${it.pageId}`
  return it.kind === 'task' && it.blockId ? `${base}?block=${encodeURIComponent(it.blockId)}` : base
}

/** Source label — collection name / page path */
export function itemSource(it: DateItemDTO): string {
  if (it.kind === 'row') return it.collectionTitle || t('common.database')
  if (it.kind === 'task') return it.parentPath || it.pageTitle || t('common.document')
  if (it.kind === 'daily') return t('dates.dailyNote')
  return it.parentPath || t('dates.topLevel')
}

/** Relative date label — "3 days overdue" · "Today" · "Tomorrow" · "Thursday" (this week) · "Oct 5" */
export function relativeDateLabel(ymd: string): string {
  const d = daysFromToday(ymd)
  if (d === null) return ymd
  if (d < 0) return t('dates.overdueDays', { count: -d })
  if (d === 0) return t('common.today')
  if (d === 1) return t('common.tomorrow')
  const date = parseYmd(ymd)
  if (!date) return ymd
  if (d < 7) return fmtDate(date, { weekday: 'long' })
  return fmtDate(date, { month: 'short', day: 'numeric' })
}

/** Recompute the due section (for optimistic updates) — same rules as the server. */
function sectionOf(date: string, done: boolean, today: string): DueSection | null {
  const d = daysFromToday(date)
  if (d === null) return null
  if (done) return d >= -7 ? 'done' : null
  if (date < today) return 'overdue'
  if (d === 0) return 'today'
  if (d === 1) return 'tomorrow'
  if (d <= 6) return 'week'
  if (d <= 30) return 'next30'
  return null
}

function recount(items: DueItemDTO[]): DueResponseDTO['counts'] {
  const c = { overdue: 0, today: 0, tomorrow: 0, week: 0, next30: 0, done: 0 }
  for (const it of items) c[it.section]++
  return c
}

/**
 * Reschedule / toggle done. Patches the calendar and due caches right away (optimistic), then refetches
 * after the server applies it. On failure the caches are rolled back and a toast shown. Toggling done
 * shows an "Undo" toast.
 */
export function useDateItemActions(wsId: string) {
  const qc = useQueryClient()

  // Optimistic patch of the calendar + due caches (docs/adr/0853-*): in-flight refetches are
  // cancelled first (one that started earlier would overwrite the patch), and the returned
  // rollback restores only this item in the *current* caches — not a whole-cache snapshot that
  // would also undo other items changed meanwhile.
  const patchCaches = async (target: DateItemDTO, patch: Partial<DateItemDTO>) => {
    const key = itemKey(target)
    const patchedKey = itemKey({ ...target, ...patch })
    await Promise.all([
      qc.cancelQueries({ queryKey: ['calendar', wsId] }),
      qc.cancelQueries({ queryKey: qk.due(wsId) }),
    ])
    const calPrev: { queryKey: QueryKey; item: CalendarEventDTO }[] = []
    for (const [k, list] of qc.getQueriesData<CalendarEventDTO[]>({ queryKey: ['calendar', wsId] })) {
      const prev = list?.find((e) => itemKey(e) === key)
      if (!list || !prev) continue
      calPrev.push({ queryKey: k, item: prev })
      qc.setQueryData<CalendarEventDTO[]>(
        k,
        list.map((e) => (itemKey(e) === key ? { ...e, ...patch } : e)),
      )
    }
    let duePrev: { item: DueItemDTO; index: number } | null = null
    const dueSnap = qc.getQueryData<DueResponseDTO>(qk.due(wsId))
    if (dueSnap) {
      const items: DueItemDTO[] = []
      dueSnap.items.forEach((it, index) => {
        if (itemKey(it) !== key) {
          items.push(it)
          return
        }
        duePrev = { item: it, index }
        const next = { ...it, ...patch }
        const section = sectionOf(next.date, next.done, dueSnap.today)
        if (section) items.push({ ...next, section })
      })
      if (duePrev) qc.setQueryData<DueResponseDTO>(qk.due(wsId), { ...dueSnap, items, counts: recount(items) })
    }
    return () => {
      for (const { queryKey, item } of calPrev) {
        qc.setQueryData<CalendarEventDTO[]>(queryKey, (cur) =>
          cur?.map((e) => (itemKey(e) === patchedKey ? item : e)),
        )
      }
      const prev = duePrev as { item: DueItemDTO; index: number } | null
      if (prev) {
        qc.setQueryData<DueResponseDTO>(qk.due(wsId), (cur) => {
          if (!cur) return cur
          const items = cur.items.filter((it) => itemKey(it) !== patchedKey)
          items.splice(Math.min(prev.index, items.length), 0, prev.item)
          return { ...cur, items, counts: recount(items) }
        })
      }
    }
  }

  const refresh = (it: DateItemDTO) => {
    qc.invalidateQueries({ queryKey: ['calendar', wsId] })
    qc.invalidateQueries({ queryKey: qk.due(wsId) })
    if (it.kind === 'row') {
      qc.invalidateQueries({ queryKey: ['collection'] })
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
    }
  }

  const reschedule = async (it: DateItemDTO, date: string): Promise<void> => {
    if (!canReschedule(it) || it.date === date) return
    const rollback = await patchCaches(it, { date })
    try {
      if (it.kind === 'row') {
        await api(`/api/pages/${it.pageId}/props`, {
          method: 'PATCH',
          body: JSON.stringify({ props: { [it.fieldId as string]: date } }),
        })
      } else if (it.kind === 'page') {
        await api(`/api/pages/${it.pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({ dateProperty: { id: it.fieldId, value: date } }),
        })
      } else {
        await api(`/api/pages/${it.pageId}/tasks/${encodeURIComponent(it.blockId as string)}`, {
          method: 'PATCH',
          body: JSON.stringify({ due: date }),
        })
      }
    } catch (err) {
      rollback()
      toast({ message: `${t('dates.rescheduleFailed')}${err instanceof Error ? ` — ${err.message}` : ''}` })
    } finally {
      refresh(it)
    }
  }

  const setDone = async (it: DateItemDTO, done: boolean, withUndo = true): Promise<void> => {
    if (!canComplete(it)) return
    const rollback = await patchCaches(it, { done })
    try {
      if (it.kind === 'row') {
        await api(`/api/pages/${it.pageId}/props`, {
          method: 'PATCH',
          body: JSON.stringify({ props: { [it.doneFieldId as string]: done } }),
        })
      } else if (it.kind === 'page') {
        await api(`/api/pages/${it.pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({ done }),
        })
      } else {
        await api(`/api/pages/${it.pageId}/tasks/${encodeURIComponent(it.blockId as string)}`, {
          method: 'PATCH',
          body: JSON.stringify({ checked: done }),
        })
      }
      if (withUndo) {
        toast({
          message: t(done ? 'dates.completed' : 'dates.uncompleted', {
            title: it.title || t('common.untitled'),
          }),
          actionLabel: t('dates.undo'),
          onAction: () => void setDone({ ...it, done }, !done, false),
        })
      }
    } catch (err) {
      rollback()
      toast({ message: `${t('dates.completeFailed')}${err instanceof Error ? ` — ${err.message}` : ''}` })
    } finally {
      refresh(it)
    }
  }

  return { reschedule, setDone }
}
