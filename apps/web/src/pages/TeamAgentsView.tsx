import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { TeamAgentActivityDTO, TeamPersonDTO } from '@inkling/shared'
import { useLayout } from '../components/AppLayout'
import { ThemeToggle } from '../components/ThemeToggle'
import { NavButtons } from '../components/NavButtons'
import { Spinner } from '../components/Spinner'
import { EyeOffIcon, FileTextIcon, LockIcon, MenuIcon, PlugIcon } from '../components/Icons'
import { startOfToday, useTeamAgents } from '../teamAgentsApi'
import { relativeTime } from '../lib/time'
import { useT } from '../i18n'

// Team agents board (docs/adr/1862-*): per person, the sections their agents claimed (with the time
// left), their suggestions waiting for a person, and what each agent connection did today. Pages
// the viewer cannot open are shown without title or section.

function PageRef({ wsId, pageId, title, hidden }: { wsId: string; pageId: string; title: string | null; hidden: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  if (hidden) {
    return (
      <span className="inline-flex items-center gap-1 text-sub" title={t('teamAgents.hiddenPage')}>
        <EyeOffIcon size={13} />
        {t('teamAgents.hiddenPage')}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => navigate(`/w/${wsId}/p/${pageId}`)}
      className="inline-flex min-w-0 items-center gap-1 truncate text-accent hover:underline"
    >
      <FileTextIcon size={13} />
      <span className="truncate">{title || t('common.untitled')}</span>
    </button>
  )
}

function AgentRow({ wsId, a }: { wsId: string; a: TeamAgentActivityDTO }) {
  const t = useT()
  const counts = [
    a.edits ? t('teamAgents.edits', { count: a.edits }) : null,
    a.created ? t('teamAgents.created', { count: a.created }) : null,
    a.suggestions ? t('teamAgents.suggested', { count: a.suggestions }) : null,
    a.reverted ? t('teamAgents.reverted', { count: a.reverted }) : null,
  ].filter(Boolean)
  return (
    <li className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-hover/50" data-testid="team-agent">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <PlugIcon size={14} className="text-sub" />
        <span className="font-medium text-ink">{a.client}</span>
        {a.connections.length === 0 && <span className="text-[11px] text-sub">({t('teamAgents.gone')})</span>}
        <span className="text-xs text-sub">{counts.length ? counts.join(' · ') : t('teamAgents.idle')}</span>
        {a.lastAt && <span className="ml-auto text-[11px] text-sub">{relativeTime(a.lastAt)}</span>}
      </div>
      {a.recentPages.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-6 text-xs">
          {a.recentPages.map((p) => (
            <PageRef key={p.pageId} wsId={wsId} pageId={p.pageId} title={p.title} hidden={p.hidden} />
          ))}
        </div>
      )}
    </li>
  )
}

function PersonCard({ wsId, p }: { wsId: string; p: TeamPersonDTO }) {
  const t = useT()
  return (
    <section className="rounded-lg border border-line p-3" data-testid="team-person">
      <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-[11px] font-medium text-accent">
          {(p.name || '?').slice(0, 1).toUpperCase()}
        </span>
        {p.name}
      </h2>

      {p.claims.length > 0 && (
        <div className="mt-3">
          <h3 className="px-2 text-[11px] font-medium uppercase tracking-wide text-sub">{t('teamAgents.claims')}</h3>
          <ul className="mt-1 flex flex-col">
            {p.claims.map((c) => (
              <li key={`${c.pageId}:${c.anchor ?? ''}:${c.connection}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 text-xs">
                <LockIcon size={12} className="text-sub" />
                <PageRef wsId={wsId} pageId={c.pageId} title={c.pageTitle} hidden={c.hidden} />
                {!c.hidden && c.anchor && <span className="text-sub">§{c.anchor}</span>}
                <span className="text-sub">· {c.client}</span>
                <span className="ml-auto rounded-full bg-hover px-1.5 text-[10px] font-medium text-sub">
                  {t('teamAgents.claimLeft', { min: Math.max(1, Math.round(c.ttlSeconds / 60)) })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.suggestions.length > 0 && (
        <div className="mt-3">
          <h3 className="px-2 text-[11px] font-medium uppercase tracking-wide text-sub">
            {t('teamAgents.waiting')} ({p.suggestions.length})
          </h3>
          <ul className="mt-1 flex flex-col">
            {p.suggestions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 text-xs">
                <PageRef wsId={wsId} pageId={s.pageId} title={s.pageTitle} hidden={s.hidden} />
                {!s.hidden && s.anchor && <span className="text-sub">§{s.anchor}</span>}
                <span className="text-sub">· {s.client}</span>
                <span className="ml-auto text-[11px] text-sub">{relativeTime(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.agents.length > 0 && (
        <div className="mt-3">
          <h3 className="px-2 text-[11px] font-medium uppercase tracking-wide text-sub">{t('teamAgents.today')}</h3>
          <ul className="mt-1 flex flex-col">
            {p.agents.map((a) => (
              <AgentRow key={a.client} wsId={wsId} a={a} />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export function TeamAgentsView() {
  const { wsId } = useParams()
  const { onToggleSidebar } = useLayout()
  const t = useT()
  const ws = wsId ?? ''
  // "today" in the viewer's time zone; recomputed when the page is opened again
  const since = useMemo(() => startOfToday(), [])
  const board = useTeamAgents(ws, since)
  const d = board.data

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('teamAgents.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-ink">
          <PlugIcon size={16} className="text-sub" />
          <span className="font-medium">{t('teamAgents.title')}</span>
          {board.isFetching && <Spinner size={12} />}
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto max-w-3xl px-3 py-5 sm:px-6 sm:py-8">
          <p className="px-2 text-xs text-sub">{t('teamAgents.subtitle')}</p>
          {d && (
            <p className="mt-2 px-2 text-xs text-ink" data-testid="team-totals">
              {t('teamAgents.totals', { claims: d.totals.claims, open: d.totals.openSuggestions, edits: d.totals.edits })}
            </p>
          )}
          <div className="mt-4 flex flex-col gap-3">
            {board.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : !d || d.people.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-sub">{t('teamAgents.empty')}</p>
            ) : (
              d.people.map((p) => <PersonCard key={p.userId} wsId={ws} p={p} />)
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
