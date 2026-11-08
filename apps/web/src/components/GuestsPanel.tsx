import { useState } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api'
import { useRemoveGuests, useWorkspaceGuests } from '../pageAccessApi'
import { levelLabel } from '../lib/pageAccess'
import { useT } from '../i18n'
import { ConfirmPopover } from './ConfirmPopover'
import { UserMinusIcon } from './Icons'
import { Spinner } from './Spinner'

// Guests of a workspace (docs/adr/1252-*): people outside it who were given some pages.
// Owners and admins see them with their pages and remove several at once.

const PAGES_SHOWN = 3

export function GuestsPanel({ wsId }: { wsId: string }) {
  const t = useT()
  const guests = useWorkspaceGuests(wsId)
  const remove = useRemoveGuests(wsId)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const list = guests.data ?? []
  // Drop selections of guests that are gone (removed elsewhere, or their last page was taken away).
  const picked = list.filter((g) => selected.has(g.userId)).map((g) => g.userId)
  const all = list.length > 0 && picked.length === list.length

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const doRemove = () => {
    setConfirm(false)
    setError(null)
    remove.mutate(picked, {
      onSuccess: () => setSelected(new Set()),
      onError: (e) => setError(e instanceof ApiError ? e.message : t('guests.removeFailed')),
    })
  }

  return (
    <section className="mb-8 mt-8">
      <div className="mb-1 flex items-center gap-2 px-1">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{t('guests.title')}</h2>
        {picked.length > 0 && (
          <ConfirmPopover
            open={confirm}
            onCancel={() => setConfirm(false)}
            onConfirm={doRemove}
            message={t('guests.removeConfirm', { count: picked.length })}
            confirmLabel={t('guests.removeSelected', { count: picked.length })}
          >
            <button
              type="button"
              onClick={() => setConfirm(true)}
              disabled={remove.isPending}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-50"
            >
              {remove.isPending ? <Spinner size={12} /> : <UserMinusIcon size={13} />}
              {t('guests.removeSelected', { count: picked.length })}
            </button>
          </ConfirmPopover>
        )}
      </div>
      <p className="mb-2 px-1 text-xs text-sub">{t('guests.desc')}</p>
      <div className="divide-y divide-line rounded-lg border border-line">
        {guests.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size={18} />
          </div>
        ) : guests.isError ? (
          <p className="px-4 py-6 text-center text-sm text-red-600">
            {guests.error instanceof ApiError ? guests.error.message : t('common.unknownError')}
          </p>
        ) : list.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-sub">{t('guests.empty')}</p>
        ) : (
          <>
            <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-sub">
              <input
                type="checkbox"
                checked={all}
                onChange={() => setSelected(all ? new Set() : new Set(list.map((g) => g.userId)))}
                aria-label={t('guests.selectAll')}
               
              />
              {t('guests.selectAll')}
            </label>
            {list.map((g) => {
              const shown = g.pages.slice(0, PAGES_SHOWN)
              const more = g.pages.length - shown.length
              return (
                <label key={g.userId} className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-hover">
                  <input
                    type="checkbox"
                    checked={selected.has(g.userId)}
                    onChange={() => toggle(g.userId)}
                    aria-label={t('guests.select', { name: g.name || g.email })}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink">{g.name || g.email}</div>
                    <div className="truncate text-xs text-sub">{g.email}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {shown.map((p) => (
                        <Link
                          key={p.pageId}
                          to={`/w/${wsId}/p/${p.pageId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex max-w-full items-center gap-1 rounded border border-line px-1.5 py-px text-xs text-ink hover:bg-app"
                        >
                          <span className="truncate">{p.title || t('common.untitled')}</span>
                          <span className="shrink-0 text-sub">· {levelLabel(p.level)}</span>
                        </Link>
                      ))}
                      {more > 0 && <span className="px-1 text-xs text-sub">{t('guests.morePages', { count: more })}</span>}
                    </div>
                  </div>
                </label>
              )
            })}
          </>
        )}
      </div>
      {error && <p className="mt-2 px-1 text-xs text-red-600">{error}</p>}
    </section>
  )
}
