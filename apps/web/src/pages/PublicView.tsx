import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { PageKind, PublicFolderDTO, PublicPageDTO, PublicTreeNodeDTO } from '@inkling/shared'
import { usePublicPage } from '../api'
import { ThemeToggle } from '../components/ThemeToggle'
import { Spinner } from '../components/Spinner'
import { ChevronDownIcon, ChevronRightIcon, MenuIcon, XIcon } from '../components/Icons'
import { KindIcon } from '../components/PageIconGlyph'
import { findTreePath, usePublicChildPage } from '../lib/publicShare'
import { safeUrl, sanitizeHtml } from '../lib/sanitizeHtml'
import { renderMathIn } from '../lib/katex'
import { t } from '../i18n'

// Public (unauthenticated) read-only viewer — /s/:token (+ /s/:token/p/:ref for folder shares). Standalone page without sidebar/app shell.
// The server renders blocks→HTML and rewrites image URLs to public file paths.
// Second layer (docs/adr/0852-*): the HTML still goes through the client allowlist sanitizer
// before dangerouslySetInnerHTML, and cover/icon URLs through the media URL allowlist.
export function PublicView() {
  const { token, ref } = useParams()
  const { data, isLoading, isError } = usePublicPage(token)
  const root = data as PublicPageDTO | PublicFolderDTO | undefined
  const folder = root && 'kind' in root && root.kind === 'folder' ? root : null

  if (folder && token) return <PublicFolderView token={token} folder={folder} currentRef={ref} />

  // Single-page share (original behavior). A single-share token with /p/:ref appended is treated as a missing page.
  const page = !folder && !ref ? (root as PublicPageDTO | undefined) : undefined
  return (
    <PublicSingleView
      data={page}
      isLoading={isLoading}
      isError={isError || (!!root && !page)}
    />
  )
}

function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (title !== null) document.title = `${title || t('common.untitled')} · Inkling`
    return () => {
      document.title = 'Inkling'
    }
  }, [title])
}

function PublicSingleView({
  data,
  isLoading,
  isError,
}: {
  data: PublicPageDTO | undefined
  isLoading: boolean
  isError: boolean
}) {
  useDocumentTitle(data ? data.title : null)

  return (
    <div className="relative flex min-h-full flex-col bg-app">
      {/* Top right: theme toggle only */}
      <div className="pointer-events-none absolute right-3 top-3 z-10">
        <div className="pointer-events-auto">
          <ThemeToggle />
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center py-24">
          <Spinner size={24} />
        </div>
      ) : isError || !data ? (
        <PublicNotFound />
      ) : (
        <PublicArticle data={data} />
      )}
    </div>
  )
}

function PublicNotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <img src="/icon.svg" alt="Inkling" className="h-10 w-10 opacity-60" />
      <h1 className="text-lg font-semibold text-ink">{t('public.notFoundTitle')}</h1>
      <p className="max-w-xs text-sm text-sub">{t('public.notFoundBody')}</p>
    </div>
  )
}

/** Icon: <img> if it's an image the server rewrote to a public file path, otherwise emoji text.
 *  No icon set → a muted line icon for the page kind (same as the app's sidebar). */
function IconGlyph({ icon, kind = 'doc', className }: { icon: string | null; kind?: PageKind; className?: string }) {
  if (!icon) {
    return (
      <span className={`inline-flex items-center text-sub ${className ?? ''}`} aria-hidden="true">
        <KindIcon kind={kind} size={15} />
      </span>
    )
  }
  const src = icon.startsWith('/api/public/') ? safeUrl(icon, 'media') : null
  if (src) {
    return <img src={src} alt="" className={`inline-block h-[1em] w-[1em] object-cover ${className ?? ''}`} />
  }
  return <span className={className}>{icon}</span>
}

// Body (cover + icon/title + server HTML). onBodyClick intercepts public internal links for SPA navigation.
function PublicArticle({
  data,
  onBodyClick,
}: {
  data: PublicPageDTO
  onBodyClick?: (e: ReactMouseEvent<HTMLDivElement>) => void
}) {
  const html = useMemo(() => sanitizeHtml(data.html), [data.html])
  const coverUrl = data.coverUrl ? safeUrl(data.coverUrl, 'media') : null
  // Equations arrive as their LaTeX source (data-latex); KaTeX renders them after sanitizing and
  // loads only when the page has math (docs/adr/0997-*).
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    return body.current ? renderMathIn(body.current) : undefined // on failure the source text stays
  }, [html])
  return (
    <article className="nd-enter flex-1">
      {coverUrl && (
        <div className="h-[200px] w-full overflow-hidden sm:h-[240px]">
          <img src={coverUrl} alt="" className="h-full w-full object-cover" />
        </div>
      )}

      <div className="mx-auto w-full max-w-3xl px-6 pb-24 pt-10">
        {data.icon && (
          <div className="mb-1 text-5xl leading-none">
            <IconGlyph icon={data.icon} />
          </div>
        )}
        <h1 className="mb-6 text-4xl font-bold text-ink">{data.title || t('common.untitled')}</h1>

        {/* Server-rendered HTML. .bn-container keeps a look similar to the editor. */}
        <div
          ref={body}
          className="bn-container nd-public-body"
          onClick={onBodyClick}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </article>
  )
}

// ── Folder share ────────────────────────────────────────────────────
// Left tree (desktop) / top drawer (phone) + reading pane. Child pages live at /s/:token/p/:ref.
function PublicFolderView({
  token,
  folder,
  currentRef,
}: {
  token: string
  folder: PublicFolderDTO
  currentRef: string | undefined
}) {
  const navigate = useNavigate()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const paneRef = useRef<HTMLDivElement>(null)

  const path = useMemo(
    () => (currentRef ? findTreePath(folder.tree, currentRef) : null),
    [folder.tree, currentRef],
  )
  const node = path ? path[path.length - 1] : null

  // Auto-expand the ancestor folders of the current page.
  useEffect(() => {
    if (!path || path.length < 2) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const n of path.slice(0, -1)) next.add(n.ref)
      return next
    })
  }, [path])

  // On navigation, close the drawer and scroll the reading pane to the top.
  useEffect(() => {
    setDrawerOpen(false)
    window.scrollTo({ top: 0 })
    paneRef.current?.scrollTo({ top: 0 })
  }, [currentRef])

  // Refs not in the tree (e.g. wikilinks to database rows) are still served if the server finds them inside the subtree.
  const readable = !!currentRef && (!node || node.kind === 'doc' || node.kind === 'collection')
  const child = usePublicChildPage(token, readable ? currentRef : undefined)

  const title = !currentRef
    ? folder.title
    : node
      ? node.title
      : child.data
        ? child.data.title
        : null
  useDocumentTitle(title)

  const toggle = (ref: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      return next
    })

  // Public internal links (/s/<token>/...) inside the server HTML navigate in the SPA without a reload.
  const onBodyClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (!href) return
    if (href === `/s/${token}` || href.startsWith(`/s/${token}/`)) {
      e.preventDefault()
      navigate(href)
    }
  }

  const tree = (
    <nav aria-label={t('public.folderToc')} className="py-2">
      <Link
        to={`/s/${token}`}
        className={`mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold transition-colors duration-150 hover:bg-hover ${
          !currentRef ? 'bg-active text-ink' : 'text-ink'
        }`}
      >
        <IconGlyph icon={folder.icon} kind="folder" className="shrink-0" />
        <span className="truncate">{folder.title || t('common.untitled')}</span>
      </Link>
      <div className="mt-1">
        {folder.tree.length === 0 ? (
          <p className="px-4 py-2 text-xs text-sub">{t('public.noPages')}</p>
        ) : (
          folder.tree.map((n) => (
            <TreeRow
              key={n.ref}
              node={n}
              depth={0}
              token={token}
              currentRef={currentRef}
              expanded={expanded}
              toggle={toggle}
            />
          ))
        )}
      </div>
    </nav>
  )

  let pane: ReactNode
  if (!currentRef) {
    pane = <FolderOverview token={token} title={folder.title} icon={folder.icon} nodes={folder.tree} />
  } else if (node && node.kind === 'folder') {
    pane = <FolderOverview token={token} title={node.title} icon={node.icon} nodes={node.children} />
  } else if (node && node.kind === 'canvas') {
    pane = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
        <KindIcon kind="canvas" size={36} className="text-sub" />
        <h1 className="text-lg font-semibold text-ink">{node.title || t('common.untitled')}</h1>
        <p className="text-sm text-sub">{t('public.canvasUnsupported')}</p>
      </div>
    )
  } else if (child.isLoading) {
    pane = (
      <div className="flex flex-1 items-center justify-center py-24">
        <Spinner size={24} />
      </div>
    )
  } else if (child.isError || !child.data) {
    pane = <PublicNotFound />
  } else {
    pane = <PublicArticle key={currentRef} data={child.data} onBodyClick={onBodyClick} />
  }

  return (
    <div className="flex min-h-full flex-col bg-app md:flex-row">
      {/* Desktop: fixed tree on the left */}
      <aside className="hidden w-64 shrink-0 border-r border-line md:block">
        <div className="sticky top-0 flex h-screen flex-col">
          <div className="flex items-center justify-between px-3 pt-3">
            <span className="text-xs font-medium text-sub">{t('public.sharedFolder')}</span>
            <ThemeToggle />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{tree}</div>
        </div>
      </aside>

      {/* Phone: top bar + drawer sliding down from the top */}
      <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-app/95 px-3 py-2 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-expanded={drawerOpen}
          aria-label={drawerOpen ? t('public.closeToc') : t('public.openToc')}
          className="rounded-md p-1.5 text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98]"
        >
          {drawerOpen ? <XIcon size={18} /> : <MenuIcon size={18} />}
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {title ?? folder.title ?? ''}
        </span>
        <ThemeToggle />
      </div>
      {drawerOpen && (
        <>
          <div
            className="fixed inset-0 z-10 bg-black/30 md:hidden"
            aria-hidden
            onClick={() => setDrawerOpen(false)}
          />
          <div className="fixed inset-x-0 top-[49px] z-20 max-h-[70vh] overflow-y-auto border-b border-line bg-app shadow-lg md:hidden">
            {tree}
          </div>
        </>
      )}

      <main ref={paneRef} className="flex min-w-0 flex-1 flex-col">
        {pane}
      </main>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  token,
  currentRef,
  expanded,
  toggle,
}: {
  node: PublicTreeNodeDTO
  depth: number
  token: string
  currentRef: string | undefined
  expanded: Set<string>
  toggle: (ref: string) => void
}) {
  const hasChildren = node.children.length > 0
  const open = expanded.has(node.ref)
  const active = currentRef === node.ref
  return (
    <div>
      <div
        className={`mx-2 flex items-center rounded-md transition-colors duration-150 hover:bg-hover ${
          active ? 'bg-active' : ''
        }`}
        style={{ paddingLeft: depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => toggle(node.ref)}
            aria-label={open ? t('public.collapse') : t('public.expand')}
            aria-expanded={open}
            className="shrink-0 rounded p-1 text-sub hover:text-ink"
          >
            {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
        ) : (
          <span className="w-[22px] shrink-0" />
        )}
        <Link
          to={`/s/${token}/p/${node.ref}`}
          onClick={() => {
            if (node.kind === 'folder' && hasChildren && !open) toggle(node.ref)
          }}
          className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-sm ${
            active ? 'font-medium text-ink' : 'text-ink'
          } ${node.kind === 'canvas' ? 'opacity-60' : ''}`}
        >
          <IconGlyph icon={node.icon} kind={node.kind} className="shrink-0" />
          <span className="truncate">{node.title || t('common.untitled')}</span>
        </Link>
      </div>
      {hasChildren && open && (
        <div>
          {node.children.map((c) => (
            <TreeRow
              key={c.ref}
              node={c}
              depth={depth + 1}
              token={token}
              currentRef={currentRef}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Reading pane when a folder (root or subfolder) is selected: title + direct children.
function FolderOverview({
  token,
  title,
  icon,
  nodes,
}: {
  token: string
  title: string
  icon: string | null
  nodes: PublicTreeNodeDTO[]
}) {
  return (
    <div className="nd-enter mx-auto w-full max-w-3xl flex-1 px-6 pb-24 pt-10">
      {icon && (
        <div className="mb-1 text-5xl leading-none">
          <IconGlyph icon={icon} />
        </div>
      )}
      <h1 className="mb-6 text-4xl font-bold text-ink">{title || t('common.untitled')}</h1>
      {nodes.length === 0 ? (
        <p className="text-sm text-sub">{t('public.noPages')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {nodes.map((n) => (
            <li key={n.ref}>
              <Link
                to={`/s/${token}/p/${n.ref}`}
                className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm text-ink transition-colors duration-150 hover:bg-hover"
              >
                <IconGlyph icon={n.icon} kind={n.kind} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{n.title || t('common.untitled')}</span>
                {n.kind === 'folder' && (
                  <span className="shrink-0 text-xs text-sub">{t('public.itemCount', { count: n.children.length })}</span>
                )}
                {n.kind === 'canvas' && (
                  <span className="shrink-0 text-xs text-sub">{t('public.canvasUnsupportedShort')}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
