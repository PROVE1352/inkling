import { useNavigate, useParams } from 'react-router'
import { useTagPages, useTags } from '../api'
import { useLayout } from '../components/AppLayout'
import { ThemeToggle } from '../components/ThemeToggle'
import { NavButtons } from '../components/NavButtons'
import { Spinner } from '../components/Spinner'
import { MenuIcon, TagIcon } from '../components/Icons'
import { pageIcon } from '../lib/pageIcon'
import { relativeTime } from '../lib/time'
import { useT } from '../i18n'

// Global tag index: /w/:wsId/tags (+ /:tag selected). Tag chips (with count badges) → pages of the selected tag.
export function TagsView() {
  const { wsId, tag } = useParams()
  const navigate = useNavigate()
  const tr = useT()
  const { onToggleSidebar } = useLayout()
  const ws = wsId ?? ''
  const selected = tag ? decodeURIComponent(tag) : undefined

  const tags = useTags(ws)
  const tagPages = useTagPages(ws, selected)

  const selectTag = (t: string) => {
    if (t === selected) navigate(`/w/${ws}/tags`)
    else navigate(`/w/${ws}/tags/${encodeURIComponent(t)}`)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={tr('tags.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-ink">
          <TagIcon size={16} className="text-sub" />
          <span className="font-medium">{tr('tags.title')}</span>
          {selected && (
            <>
              <span className="px-0.5 text-sub/50">›</span>
              <span className="truncate text-accent">#{selected}</span>
            </>
          )}
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto max-w-3xl px-6 py-8">
          {/* Tag chips */}
          {tags.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size={20} />
            </div>
          ) : (tags.data?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-sub">
              {tr('tags.emptyBefore')}
              <code className="text-accent">{tr('tags.emptyExample')}</code>
              {tr('tags.emptyAfter')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.data!.map((t) => {
                const active = t.tag === selected
                return (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => selectTag(t.tag)}
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors duration-150 ${
                      active
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line text-ink hover:bg-hover'
                    }`}
                  >
                    <span>#{t.tag}</span>
                    <span
                      className={`rounded-full px-1.5 text-xs ${
                        active ? 'bg-accent/20 text-accent' : 'bg-hover text-sub'
                      }`}
                    >
                      {t.count}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Pages of the selected tag */}
          {selected && (
            <div className="mt-6 border-t border-line pt-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">
                #{selected}
              </div>
              {tagPages.isLoading ? (
                <div className="flex justify-center py-8">
                  <Spinner size={20} />
                </div>
              ) : (tagPages.data?.length ?? 0) === 0 ? (
                <p className="py-6 text-center text-sm text-sub">{tr('tags.noPages')}</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {tagPages.data!.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => navigate(`/w/${ws}/p/${p.id}`)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors duration-150 hover:bg-hover"
                      >
                        <span className="shrink-0 text-[15px] leading-none">
                          {pageIcon(p)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {p.title || tr('common.untitled')}
                        </span>
                        <span className="shrink-0 text-xs text-sub">
                          {relativeTime(p.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
