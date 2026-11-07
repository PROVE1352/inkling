import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { usePages, useSharedList, useUnshare } from '../api'
import type { SharedItemDTO } from '../api'
import { useLayout } from '../components/AppLayout'
import { ThemeToggle } from '../components/ThemeToggle'
import { NavButtons } from '../components/NavButtons'
import { Spinner } from '../components/Spinner'
import { CopyIcon, GlobeIcon, MenuIcon } from '../components/Icons'
import { pageIcon, kindLabel } from '../lib/pageIcon'
import { relativeTime } from '../lib/time'
import { toast } from '../lib/toast'
import { useT } from '../i18n'

// Workspace web-share list: /w/:wsId/shared.
// Gathers the pages/folders published via "Share to web" (page header or tree menu) in one place:
// copy link / open in a new tab / (owner) stop sharing.
export function SharedView() {
  const { wsId } = useParams()
  const ws = wsId ?? ''
  const t = useT()
  const { onToggleSidebar } = useLayout()
  const list = useSharedList(ws)
  const pages = usePages(ws)

  // Parent path (Folder › Folder) — so you can tell where the page lives.
  const pathOf = useMemo(() => {
    const byId = new Map((pages.data ?? []).map((p) => [p.id, p]))
    return (parentId: string | null) => {
      const names: string[] = []
      let cur = parentId ? byId.get(parentId) : undefined
      while (cur && names.length < 6) {
        names.unshift(cur.title || t('common.untitled'))
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
      return names.join(' › ')
    }
  }, [pages.data, t])

  const items = list.data?.items ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('shared.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-ink">
          <GlobeIcon size={16} className="text-sub" />
          <span className="font-medium">{t('shared.title')}</span>
          {items.length > 0 && <span className="text-sub">{items.length}</span>}
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto max-w-3xl px-4 py-8 sm:px-6">
          <p className="mb-5 text-sm text-sub">
            {t('shared.intro')}
          </p>
          {list.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size={20} />
            </div>
          ) : list.isError ? (
            <p className="py-8 text-center text-sm text-sub">{t('shared.loadFailed')}</p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-sub">
              {t('shared.empty')}
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {items.map((it) => (
                <SharedRow
                  key={it.id}
                  wsId={ws}
                  item={it}
                  path={pathOf(it.parentId)}
                  canManage={list.data!.canManage}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function SharedRow({
  wsId,
  item,
  path,
  canManage,
}: {
  wsId: string
  item: SharedItemDTO
  path: string
  canManage: boolean
}) {
  const navigate = useNavigate()
  const t = useT()
  const unshare = useUnshare(item.id)
  const [confirming, setConfirming] = useState(false)
  const url = `${window.location.origin}/s/${item.token}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast({ message: t('shared.linkCopied') })
    } catch {
      toast({ message: t('shared.copyFailed') })
    }
  }

  const btn =
    'rounded-md border border-line px-2.5 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60'

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <button
        type="button"
        onClick={() => navigate(`/w/${wsId}/p/${item.id}`)}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
      >
        <span className="mt-0.5 text-[17px] leading-none">{pageIcon(item)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink hover:underline">
            {item.title || t('common.untitled')}
          </span>
          <span className="block truncate text-xs text-sub">
            {kindLabel(item.kind)}
            {item.kind === 'folder' && item.exposedCount !== undefined
              ? ` · ${t('shared.exposedCount', { count: item.exposedCount })}`
              : ''}
            {path ? ` · ${path}` : ''} · {t('shared.edited', { time: relativeTime(item.updatedAt) })}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-sub/80">{url}</span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1.5 pl-7 sm:pl-0">
        <button type="button" onClick={copy} className={`${btn} inline-flex items-center gap-1`}>
          <CopyIcon size={12} /> {t('common.copy')}
        </button>
        <a href={url} target="_blank" rel="noopener noreferrer" className={btn}>
          {t('common.open')}
        </a>
        {canManage &&
          (confirming ? (
            <>
              <button
                type="button"
                disabled={unshare.isPending}
                onClick={() =>
                  unshare.mutate(undefined, {
                    onError: () => toast({ message: t('shared.stopFailed') }),
                  })
                }
                className="rounded-md bg-red-600 px-2.5 py-1 text-xs text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {t('shared.stop')}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={btn}>
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className={btn}>
              {t('shared.stopSharing')}
            </button>
          ))}
      </div>
    </li>
  )
}
