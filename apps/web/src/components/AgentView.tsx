import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAgentContext, useAgentOutline, useAgentSection } from '../agentViewApi'
import { INTRO_ANCHOR, contextSummary, outlineRows, sampleQuestion, shortAnchors, type OutlineRow } from '../lib/agentView'
import { useOnboarding } from '../onboarding/api'
import { fmtNumber, t, useLocale, useT, type Locale, type TKey, type TParams } from '../i18n'
import { Modal } from './Modal'
import { Spinner } from './Spinner'
import { ChevronRightIcon, SearchIcon } from './Icons'

// "What an agent reads" (docs/adr/2389-*): a read-only dialog over the page. It shows the page's
// sections with the server's token estimates (GET /pages/:id/outline), one section as the Markdown an
// agent gets (GET /pages/:id/section) and what find_context returns for a question (GET /context).
// The editor stays mounted under it; nothing here writes.

/** Rows drawn before "Show all": a page with hundreds of headings opens without drawing them all. */
const FIRST_ROWS = 150
const QUESTION_DELAY_MS = 400

/** A translated sentence with some of its numbers set in the text colour and weight. */
function withNumbers(key: TKey, params: TParams, strong: string[]): ReactNode[] {
  const marked: TParams = { ...params }
  for (const k of strong) marked[k] = `\u0001${k}\u0001`
  return t(key, marked)
    .split('\u0001')
    .map((part, i) => {
      if (i % 2 === 0) return part
      const v = params[part]
      return (
        <strong key={i} className="font-semibold tabular-nums text-ink">
          {typeof v === 'number' ? fmtNumber(v) : v}
        </strong>
      )
    })
}

/** The language of a sample page from its title (the sample is written in the language it was made in). */
function sampleLocale(title: string | undefined, fallback: Locale): Locale {
  if (!title) return fallback
  return /[가-힣]/.test(title) ? 'ko' : 'en'
}

export function AgentView({ pageId, wsId, open, onClose }: { pageId: string; wsId: string; open: boolean; onClose: () => void }) {
  const t = useT()
  // The question survives closing and reopening the dialog on the same page.
  const asked = useRef<string | null>(null)
  return (
    <Modal open={open} onClose={onClose} title={t('agentView.menu')} size="lg">
      {/* mounted only while the dialog is (Modal renders nothing closed), so no request runs before */}
      <AgentViewBody pageId={pageId} wsId={wsId} asked={asked} />
    </Modal>
  )
}

function AgentViewBody({ pageId, wsId, asked }: { pageId: string; wsId: string; asked: { current: string | null } }) {
  const t = useT()
  const locale = useLocale()
  const outline = useAgentOutline(pageId, true)
  const onboarding = useOnboarding()
  const isSample = !!onboarding && onboarding.samples[wsId] === pageId
  const [returned, setReturned] = useState<ReadonlySet<string>>(() => new Set())

  const rows = useMemo(() => (outline.data ? outlineRows(outline.data) : []), [outline.data])
  const total = outline.data?.tokens ?? 0
  const initial = asked.current ?? (isSample && outline.data ? sampleQuestion(sampleLocale(outline.data.page.title, locale)) : '')

  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm" data-testid="agent-view">
      {outline.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner size={18} />
        </div>
      ) : outline.isError ? (
        <p className="text-xs text-red-600">{t('agentView.loadError')}</p>
      ) : (
        <>
          <p className="text-sub" data-testid="agent-view-summary">
            {withNumbers('agentView.summary', { total }, ['total'])}
          </p>
          <Question
            // remounted when the sample check answers, so a sample page starts with its question filled in
            key={String(isSample)}
            pageId={pageId}
            wsId={wsId}
            initial={initial}
            onAsk={(q) => {
              asked.current = q
            }}
            onReturned={setReturned}
          />
          <SectionList pageId={pageId} rows={rows} returned={returned} />
        </>
      )}
      <p className="text-xs text-sub">{t('agentView.footnote')}</p>
    </div>
  )
}

function Question({
  pageId,
  wsId,
  initial,
  onAsk,
  onReturned,
}: {
  pageId: string
  wsId: string
  initial: string
  onAsk: (q: string) => void
  onReturned: (anchors: ReadonlySet<string>) => void
}) {
  const t = useT()
  const [text, setText] = useState(initial)
  const [q, setQ] = useState(initial.trim())
  useEffect(() => {
    const next = text.trim()
    if (next === q) return
    const id = window.setTimeout(() => setQ(next), QUESTION_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [text, q])

  const ctx = useAgentContext(wsId, q, true)
  const summary = useMemo(() => (ctx.data && q ? contextSummary(ctx.data, pageId) : null), [ctx.data, q, pageId])
  useEffect(() => {
    onReturned(new Set(summary ? summary.rows.filter((r) => r.onThisPage).flatMap((r) => r.anchors) : []))
  }, [summary, onReturned])

  return (
    <section className="flex flex-col gap-2">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          setQ(text.trim())
        }}
        className="relative"
      >
        <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sub" />
        <input
          type="search"
          value={text}
          maxLength={300}
          onChange={(e) => {
            setText(e.target.value)
            onAsk(e.target.value)
          }}
          placeholder={t('agentView.ask')}
          aria-label={t('agentView.ask')}
          data-testid="agent-view-question"
          className="w-full rounded-md border border-line bg-app py-1.5 pl-8 pr-2 text-base text-ink placeholder:text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:text-sm"
        />
      </form>
      {q && (
        <div data-testid="agent-view-result" aria-live="polite" className={ctx.isFetching && ctx.isPlaceholderData ? 'opacity-60' : ''}>
          {ctx.isError ? (
            <p className="text-xs text-red-600">{t('agentView.searchError')}</p>
          ) : !summary ? (
            <div className="flex justify-center py-3">
              <Spinner size={16} />
            </div>
          ) : summary.rows.length === 0 ? (
            <p className="text-sub">{t('agentView.none')}</p>
          ) : (
            <>
              <p className="text-sub">
                {withNumbers('agentView.result', { count: summary.sections, used: summary.used, budget: summary.budget }, ['used'])}
              </p>
              <ul className="mt-1.5 flex flex-col">
                {summary.rows.map((r, i) => (
                  <li
                    key={`${r.pageId}:${r.anchor}:${i}`}
                    className={`flex flex-wrap items-baseline gap-x-2 py-1 ${r.onThisPage ? 'text-ink' : 'text-sub'}`}
                    data-this-page={r.onThisPage || undefined}
                  >
                    <span className={`min-w-0 max-w-full truncate ${r.onThisPage ? 'font-semibold' : ''}`}>{r.title || t('common.untitled')}</span>
                    <span className="min-w-0 max-w-full truncate font-mono text-xs" title={r.anchors.join('\n')}>
                      §{r.short}
                      {r.anchors.length > 1 ? ` +${r.anchors.length - 1}` : ''}
                    </span>
                    <span className="text-xs tabular-nums">{t('agentView.tokens', { tokens: r.tokens })}</span>
                    {r.onThisPage && <span className="text-xs text-sub">· {t('agentView.thisPage')}</span>}
                  </li>
                ))}
              </ul>
              {!!ctx.data?.more.length && <p className="text-xs text-sub">{t('agentView.more', { count: ctx.data.more.length })}</p>}
            </>
          )}
        </div>
      )}
    </section>
  )
}

const SectionList = memo(function SectionList({
  pageId,
  rows,
  returned,
}: {
  pageId: string
  rows: OutlineRow[]
  returned: ReadonlySet<string>
}) {
  const t = useT()
  const [all, setAll] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  // the labels find_context prints (shortest unique anchor suffix), not the anchor cut to width
  const shorts = useMemo(() => shortAnchors(rows.map((r) => r.anchor)), [rows])
  if (rows.length === 0) return <p className="text-sub">{t('agentView.empty')}</p>
  const shown = all ? rows : rows.slice(0, FIRST_ROWS)
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="text-xs font-medium text-sub">{t('agentView.sections', { count: rows.length })}</h3>
      <ul className="flex max-h-[45vh] min-w-0 flex-col overflow-y-auto border-y border-line" data-testid="agent-view-sections">
        {shown.map((r) => (
          <SectionRow
            key={r.anchor}
            pageId={pageId}
            row={r}
            short={shorts.get(r.anchor) ?? r.anchor}
            open={expanded === r.anchor}
            returned={returned.has(r.anchor)}
            onToggle={setExpanded}
          />
        ))}
      </ul>
      {!all && rows.length > FIRST_ROWS && (
        <button type="button" onClick={() => setAll(true)} className="self-start rounded px-1.5 py-0.5 text-xs text-accent hover:bg-hover">
          {t('agentView.showAll', { count: rows.length })}
        </button>
      )}
    </section>
  )
})

const SectionRow = memo(function SectionRow({
  pageId,
  row,
  short,
  open,
  returned,
  onToggle,
}: {
  pageId: string
  row: OutlineRow
  short: string
  open: boolean
  returned: boolean
  onToggle: (anchor: string | null) => void
}) {
  const t = useT()
  const intro = row.anchor === INTRO_ANCHOR || row.anchor === ''
  const indent = Math.min(Math.max(row.level - 1, 0), 4) * 12
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(open ? null : row.anchor)}
        title={[row.anchor, row.headingPath].filter(Boolean).join('\n') || undefined}
        data-anchor={row.anchor}
        className="flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 pr-2 text-left transition-colors duration-150 hover:bg-hover"
        style={{ paddingLeft: 4 + indent }}
      >
        <span className="flex min-w-[10rem] flex-1 items-baseline gap-1.5 overflow-hidden">
          <ChevronRightIcon size={12} className={`shrink-0 self-center text-sub transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          <span className={`truncate font-mono text-xs ${returned ? 'font-semibold text-ink' : 'text-ink'}`}>§{short || INTRO_ANCHOR}</span>
          {intro && <span className="truncate text-xs text-sub">{t('agentView.intro')}</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-3 text-xs tabular-nums text-sub">
          <span className={returned ? 'font-semibold text-ink' : 'text-ink'}>{t('agentView.tokens', { tokens: row.tokens })}</span>
          <span className="w-9 text-right">{row.pct === 0 && row.tokens > 0 ? t('agentView.pctUnder') : t('agentView.pct', { pct: row.pct })}</span>
          <span className="max-w-[7rem] truncate">{t('agentView.version', { version: row.version })}</span>
        </span>
      </button>
      {open && <SectionBody pageId={pageId} anchor={row.anchor} version={row.version} />}
    </li>
  )
})

function SectionBody({ pageId, anchor, version }: { pageId: string; anchor: string; version: string }) {
  const t = useT()
  const q = useAgentSection(pageId, anchor, version)
  if (q.isPending)
    return (
      <div className="flex justify-center py-3">
        <Spinner size={14} />
      </div>
    )
  if (q.isError) return <p className="px-3 py-2 text-xs text-red-600">{t('agentView.loadError')}</p>
  return (
    <div className="px-1 pb-2">
      <pre
        className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-side p-3 font-mono text-xs text-ink [overflow-wrap:anywhere]"
        data-testid="agent-view-section-text"
      >
        {q.data.markdown}
      </pre>
      {q.data.truncated && (
        <p className="mt-1 text-xs text-sub">{t('agentView.truncated', { shown: q.data.markdown.length, total: q.data.totalChars })}</p>
      )}
    </div>
  )
}
