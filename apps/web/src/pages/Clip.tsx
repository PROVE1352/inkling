import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ClipLookupDTO, ClipMode, ClipRequest, ClipResultDTO, PageMetaDTO } from '@inkling/shared'
import { api, ApiError, useMe, usePages, useWorkspaces } from '../api'
import { FullScreenSpinner, Spinner } from '../components/Spinner'
import { useT } from '../i18n'
import {
  CLIP_STASH,
  readClipMode,
  readDefaultClipLocation,
  readLastClipLocation,
  writeClipMode,
  writeDefaultClipLocation,
  writeLastClipLocation,
} from '../lib/clipPrefs'
import { normalizeClipQuery, parseClipTags, type ClipQuery } from '../lib/clipQuery'

// /clip?title&text&url — "Save to Inkling" (docs/adr/2260-*, 2263-*). Opened by the bookmarklet in a
// small window, by the installed app's share target, or by hand. Opening it never saves anything:
// the query only fills the form, and the page is created when the person presses Save (another site
// can link here, but cannot make it write). Signed-out visitors go to /login?next= and come back to
// the same query (kept in sessionStorage instead when it is too long for ?next=).

const HERE = '/clip'
/** Longest /clip?… kept in ?next= (OIDC returnTo takes 2,000 characters). */
const MAX_NEXT = 1800

function readQuery(search: string): ClipQuery {
  const params = new URLSearchParams(search)
  if (params.get('stash') === '1') {
    try {
      const saved = window.sessionStorage.getItem(CLIP_STASH)
      if (saved !== null) {
        window.sessionStorage.removeItem(CLIP_STASH)
        return normalizeClipQuery(new URLSearchParams(saved))
      }
    } catch {
      /* storage unavailable */
    }
  }
  return normalizeClipQuery(params)
}

/** /login?next=… that brings the visitor back to this query. */
function loginTarget(search: string): string {
  let next = `${HERE}${search}`
  if (next.length > MAX_NEXT) {
    try {
      window.sessionStorage.setItem(CLIP_STASH, search)
      next = `${HERE}?stash=1`
    } catch {
      next = HERE
    }
  }
  return `/login?next=${encodeURIComponent(next)}`
}

const inputCls =
  'w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink placeholder:text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
const labelCls = 'mb-1 block text-xs font-medium text-sub'
const primaryBtn =
  'flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition duration-150 hover:opacity-90 active:scale-[.98] disabled:opacity-60'
const secondaryBtn =
  'flex-1 rounded-md border border-line px-3 py-2 text-sm text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98] disabled:opacity-60'

function Shell({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <div className="flex min-h-full justify-center bg-app px-4 py-6 sm:py-10">
      <div className="w-full max-w-lg">
        <div className="mb-4 flex items-center gap-2">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <h1 className="text-lg font-semibold text-ink">{t('clip.title')}</h1>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Pages a clip can go under, in tree order with their depth (documents and folders). */
function parentOptions(pages: PageMetaDTO[]): { page: PageMetaDTO; depth: number }[] {
  const byParent = new Map<string | null, PageMetaDTO[]>()
  const ids = new Set(pages.map((p) => p.id))
  for (const p of pages) {
    if (p.kind !== 'doc' && p.kind !== 'folder') continue
    // a guest's shared pages arrive without their (invisible) parents: treat them as tops
    const key = p.parentId && ids.has(p.parentId) ? p.parentId : null
    const list = byParent.get(key) ?? []
    list.push(p)
    byParent.set(key, list)
  }
  const out: { page: PageMetaDTO; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    const list = (byParent.get(parent) ?? []).sort((a, b) => a.sortOrder - b.sortOrder)
    for (const p of list) {
      out.push({ page: p, depth })
      if (depth < 12) walk(p.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export function Clip() {
  const location = useLocation()
  const me = useMe()
  const [query] = useState(() => readQuery(location.search))

  // The page that opened this window (a bookmarklet's tab) gets no handle on it.
  useEffect(() => {
    try {
      if (window.opener) window.opener = null
    } catch {
      /* ignore */
    }
  }, [])

  if (me.isLoading) return <FullScreenSpinner />
  if (me.isError || !me.data) return <Navigate to={loginTarget(location.search)} replace />
  return (
    <Shell>
      <ClipForm initial={query} />
    </Shell>
  )
}

function ClipForm({ initial }: { initial: ClipQuery }) {
  const t = useT()
  const navigate = useNavigate()
  const workspaces = useWorkspaces()
  const [start] = useState(() => readDefaultClipLocation() ?? readLastClipLocation())
  const [wsId, setWsId] = useState<string>('')
  const [parentId, setParentId] = useState<string>('')
  const [filter, setFilter] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [title, setTitle] = useState(initial.title)
  const [url, setUrl] = useState(initial.url)
  const [text, setText] = useState(initial.text)
  const [mode, setMode] = useState<ClipMode>(() => (initial.url ? readClipMode() : 'link'))
  const [tagInput, setTagInput] = useState('')
  const [result, setResult] = useState<ClipResultDTO | null>(null)
  const [closeFailed, setCloseFailed] = useState(false)

  // First workspace list: the remembered one when it still exists, else the first.
  useEffect(() => {
    const list = workspaces.data
    if (!list?.length || wsId) return
    const remembered = start && list.find((w) => w.id === start.workspaceId)
    setWsId(remembered ? remembered.id : list[0].id)
    if (remembered && start?.parentId) setParentId(start.parentId)
  }, [workspaces.data, wsId, start])

  const ws = workspaces.data?.find((w) => w.id === wsId)
  const pages = usePages(wsId)
  const options = useMemo(() => parentOptions(pages.data ?? []), [pages.data])
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? options.filter((o) => o.page.id === parentId || o.page.title.toLowerCase().includes(f)) : options
  }, [options, filter, parentId])
  // A remembered parent that is gone (trashed, moved out of reach): back to the top level.
  useEffect(() => {
    if (parentId && pages.data && !options.some((o) => o.page.id === parentId)) setParentId('')
  }, [options, pages.data, parentId])
  // Guests cannot save at the top level: start them under their first shared page.
  useEffect(() => {
    if (ws?.role === 'guest' && !parentId && options.length) setParentId(options[0].page.id)
  }, [ws?.role, parentId, options])

  const { tags, invalid } = parseClipTags(tagInput)
  const trimmedUrl = url.trim()

  const lookup = useQuery({
    queryKey: ['clip-lookup', wsId, trimmedUrl],
    queryFn: () => api<ClipLookupDTO>(`/api/clip/lookup?workspaceId=${wsId}&url=${encodeURIComponent(trimmedUrl)}`),
    enabled: !!wsId && /^https?:\/\//i.test(trimmedUrl),
    staleTime: 30_000,
  })
  const previous = lookup.data?.pages ?? []

  const save = useMutation({
    mutationFn: (body: ClipRequest) => api<ClipResultDTO>('/api/clip', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (r) => {
      const loc = { workspaceId: wsId, parentId: parentId || null }
      writeLastClipLocation(loc)
      if (makeDefault) writeDefaultClipLocation(loc)
      writeClipMode(mode)
      setResult(r)
    },
  })

  const errorText = (e: unknown): string => {
    if (!(e instanceof ApiError)) return String(e)
    if (e.code === 'CLIP_RATE_LIMITED' || e.status === 429) return t('clip.errRateLimited')
    if (e.code === 'CLIP_INVALID_URL') return t('clip.errInvalidUrl')
    return e.message
  }

  const canSave = !!wsId && (!!trimmedUrl || !!text.trim()) && invalid.length === 0 && !save.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    save.mutate({
      workspaceId: wsId,
      ...(parentId ? { parentId } : {}),
      ...(trimmedUrl ? { url: trimmedUrl } : {}),
      ...(title.trim() ? { title: title.trim().slice(0, 300) } : {}),
      ...(text.trim() ? { text } : {}),
      mode: trimmedUrl ? mode : 'link',
      ...(tags.length ? { tags } : {}),
    })
  }

  if (workspaces.isLoading) return <Spinner size={20} />
  if (!workspaces.data?.length) return <p className="text-sm text-sub">{t('clip.noWorkspace')}</p>

  if (result) {
    const href = `/w/${result.page.workspaceId}/p/${result.page.id}`
    return (
      <div className="flex flex-col gap-4 rounded-lg border border-line p-5" data-clip-result={result.mode}>
        <div>
          <div className="text-base font-semibold text-ink">{t('clip.saved')}</div>
          <div className="mt-1 truncate text-sm text-ink">{result.page.title}</div>
          <p className="mt-2 text-sm text-sub">
            {result.fallback ? t(`clip.fallback.${result.fallback}`) : result.mode === 'article' ? t('clip.savedArticle') : t('clip.savedLink')}
            {result.truncated ? ` ${t('clip.truncated')}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={primaryBtn} onClick={() => navigate(href)}>
            {t('clip.openPage')}
          </button>
          <button
            type="button"
            className={secondaryBtn}
            onClick={() => {
              window.close()
              // Only windows a script opened can close themselves; say so when this one stays.
              window.setTimeout(() => setCloseFailed(true), 300)
            }}
          >
            {t('clip.closeWindow')}
          </button>
        </div>
        {closeFailed && <p className="text-xs text-sub">{t('clip.closeHint')}</p>}
        <button type="button" className="self-start text-xs text-sub underline" onClick={() => setResult(null)}>
          {t('clip.another')}
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-line p-5" aria-label={t('clip.title')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelCls}>{t('clip.workspace')}</span>
          <select
            className={inputCls}
            value={wsId}
            onChange={(e) => {
              setWsId(e.target.value)
              setParentId('')
              setFilter('')
            }}
            name="workspace"
          >
            {workspaces.data.map((w) => (
              <option key={w.id} value={w.id}>
                {w.icon ? `${w.icon} ` : ''}
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>{t('clip.parent')}</span>
          <select className={inputCls} value={parentId} onChange={(e) => setParentId(e.target.value)} name="parent">
            {ws?.role !== 'guest' && <option value="">{t('clip.parentTop')}</option>}
            {shown.map(({ page, depth }) => (
              <option key={page.id} value={page.id}>
                {'  '.repeat(depth)}
                {page.icon ? `${page.icon} ` : ''}
                {page.title || '—'}
              </option>
            ))}
          </select>
        </label>
      </div>
      {options.length > 15 && (
        <input className={inputCls} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('clip.parentFilter')} aria-label={t('clip.parentFilter')} />
      )}
      <label className="flex items-center gap-2 text-xs text-sub">
        <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
        {t('clip.makeDefault')}
      </label>

      <label className="block">
        <span className={labelCls}>{t('clip.pageTitle')}</span>
        <input className={inputCls} name="title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="block">
        <span className={labelCls}>{t('clip.url')}</span>
        <input className={inputCls} name="url" type="url" inputMode="url" value={url} maxLength={2048} onChange={(e) => setUrl(e.target.value)} />
      </label>
      {previous.length > 0 && (
        <p className="rounded-md bg-side px-3 py-2 text-xs text-sub" data-clip-previous>
          {t('clip.already', { count: previous.length, title: previous[0].title || '—' })}{' '}
          <button type="button" className="underline" onClick={() => navigate(`/w/${previous[0].workspaceId}/p/${previous[0].id}`)}>
            {t('clip.alreadyOpen')}
          </button>
        </p>
      )}
      <label className="block">
        <span className={labelCls}>{t('clip.text')}</span>
        <textarea className={`${inputCls} min-h-24`} name="text" value={text} maxLength={20_000} onChange={(e) => setText(e.target.value)} rows={4} />
      </label>

      <fieldset className="flex flex-col gap-2" disabled={!trimmedUrl}>
        <legend className={labelCls}>{t('clip.mode')}</legend>
        {(['link', 'article'] as const).map((m) => (
          <label key={m} className="flex cursor-pointer items-start gap-2 rounded-md border border-line px-3 py-2">
            <input type="radio" name="mode" value={m} checked={(trimmedUrl ? mode : 'link') === m} onChange={() => setMode(m)} className="mt-1" />
            <span>
              <span className="block text-sm text-ink">{m === 'link' ? t('clip.modeLink') : t('clip.modeArticle')}</span>
              <span className="block text-xs text-sub">{m === 'link' ? t('clip.modeLinkDesc') : t('clip.modeArticleDesc')}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="block">
        <span className={labelCls}>{t('clip.tags')}</span>
        <input className={inputCls} name="tags" value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder={t('clip.tagsPlaceholder')} />
        {invalid.length > 0 && <span className="mt-1 block text-xs text-red-600">{t('clip.tagsInvalid', { tags: invalid.join(' ') })}</span>}
      </label>

      {save.isError && (
        <p role="alert" className="text-sm text-red-600">
          {errorText(save.error)}
        </p>
      )}
      {!trimmedUrl && !text.trim() && <p className="text-xs text-sub">{t('clip.errEmpty')}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primaryBtn} disabled={!canSave}>
          {save.isPending && <Spinner size={14} />}
          {save.isPending ? t('clip.saving') : t('clip.save')}
        </button>
      </div>
    </form>
  )
}
