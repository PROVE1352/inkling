import { Fragment, useMemo } from 'react'
import { useNavigate } from 'react-router'
import type { PageMetaDTO } from '@inkling/shared'
import { useT } from '../i18n'

type Crumb = { key: string; label: string; onClick?: () => void }

// Breadcrumb of the current page's ancestor chain, computed from the pages cache. At the root, only the section label (Shared/Private).
// Desktop: "Shared › Folder › Current". Mobile: current title only (separators and ancestors hidden). Long chains collapse the middle (…).
export function Breadcrumb({
  wsId,
  page,
  pages,
}: {
  wsId: string
  page: PageMetaDTO
  pages: PageMetaDTO[]
}) {
  const navigate = useNavigate()
  const t = useT()

  const crumbs = useMemo<Crumb[]>(() => {
    const byId = new Map(pages.map((p) => [p.id, p]))
    const chain: PageMetaDTO[] = []
    const seen = new Set<string>()
    let cur: PageMetaDTO | undefined = page
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      chain.unshift(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }

    const out: Crumb[] = [
      {
        key: 'section',
        label: page.scope === 'private' ? t('breadcrumb.private') : t('breadcrumb.shared'),
        onClick: () => navigate(`/w/${wsId}`),
      },
    ]
    chain.forEach((c, i) => {
      const isLast = i === chain.length - 1
      out.push({
        key: c.id,
        label: c.title || t('common.untitled'),
        onClick: isLast ? undefined : () => navigate(`/w/${wsId}/p/${c.id}`),
      })
    })

    // 5 or more: collapse the middle → [section, …, parent, current]
    if (out.length > 4) {
      return [out[0], { key: 'ellipsis', label: '…' }, out[out.length - 2], out[out.length - 1]]
    }
    return out
  }, [page, pages, wsId, navigate, t])

  return (
    <nav
      aria-label={t('breadcrumb.label')}
      className="flex min-w-0 flex-1 items-center gap-0.5 text-sm text-sub"
    >
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1
        const vis = isLast ? 'flex min-w-0 flex-1' : 'hidden md:inline-flex max-w-[10rem]'
        return (
          <Fragment key={c.key}>
            {i > 0 && <span className="hidden shrink-0 px-0.5 text-sub/50 md:inline">›</span>}
            {c.onClick ? (
              <button
                type="button"
                onClick={c.onClick}
                title={c.label}
                className={`${vis} shrink-0 items-center truncate rounded px-1 transition-colors duration-150 hover:bg-hover hover:text-ink`}
              >
                {c.label}
              </button>
            ) : (
              <span
                title={c.label}
                className={`${vis} items-center truncate px-1 ${isLast ? 'text-ink/90' : ''}`}
              >
                {c.label}
              </span>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
