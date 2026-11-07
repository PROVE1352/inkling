import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { useGraph } from '../../api'
import { useT } from '../../i18n'
import { setLocalGraphPref, usePrefs } from '../../lib/prefs'
import { ExpandIcon, GraphIcon, XIcon } from '../Icons'
import { GraphCanvas } from './GraphCanvas'
import type { EngineSettings } from './graphEngine'
import { buildModel } from './graphModel'

// Depth 1–3 + incoming/outgoing link toggles (local graph options row)
function LocalOptions() {
  const t = useT()
  const { localGraph: lp } = usePrefs()
  const chip = (on: boolean) =>
    `rounded px-1.5 py-0.5 text-[11px] transition-colors duration-150 ${
      on ? 'bg-accent-soft text-accent' : 'text-sub hover:bg-hover hover:text-ink'
    }`
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-0.5" role="group" aria-label={t('localGraph.depth')}>
        <span className="mr-0.5 text-[11px] text-sub">{t('localGraph.depth')}</span>
        {([1, 2, 3] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setLocalGraphPref('depth', d)}
            aria-pressed={lp.depth === d}
            className={chip(lp.depth === d)}
          >
            {d}
          </button>
        ))}
      </span>
      <button
        type="button"
        aria-pressed={lp.incoming}
        onClick={() => setLocalGraphPref('incoming', !lp.incoming)}
        className={chip(lp.incoming)}
        title={t('localGraph.incomingTitle')}
      >
        {t('localGraph.incoming')}
      </button>
      <button
        type="button"
        aria-pressed={lp.outgoing}
        onClick={() => setLocalGraphPref('outgoing', !lp.outgoing)}
        className={chip(lp.outgoing)}
        title={t('localGraph.outgoingTitle')}
      >
        {t('localGraph.outgoing')}
      </button>
    </div>
  )
}

// Local graph embedded in RightPanel — the N-hop neighbourhood of the current page, using the same canvas renderer as the full graph.
// RightPanel unmounts it when the section collapses, so the simulation goes away with it.
export function LocalGraph({ wsId, focusId }: { wsId: string; focusId: string }) {
  const t = useT()
  const graph = useGraph(wsId)
  const navigate = useNavigate()
  const { graph: gp, localGraph: lp } = usePrefs()
  const [expanded, setExpanded] = useState(false)

  const model = useMemo(
    () =>
      graph.data
        ? buildModel(graph.data, {
            showOrphans: true,
            showTags: gp.showTags,
            local: { focusId, depth: lp.depth, incoming: lp.incoming, outgoing: lp.outgoing },
          })
        : null,
    [graph.data, gp.showTags, focusId, lp.depth, lp.incoming, lp.outgoing],
  )
  // Follow the full graph's settings, but shrink distance/repulsion to suit the narrow panel.
  const settings: EngineSettings = useMemo(
    () => ({
      centerForce: gp.centerForce,
      repelForce: gp.repelForce * 0.7,
      linkDistance: gp.linkDistance * 0.65,
      linkForce: gp.linkForce,
      nodeSize: gp.nodeSize,
      arrows: gp.arrows,
      colorGroups: gp.colorGroups,
    }),
    [gp],
  )
  const bigSettings: EngineSettings = useMemo(
    () => ({ ...settings, linkDistance: gp.linkDistance, repelForce: gp.repelForce }),
    [settings, gp.linkDistance, gp.repelForce],
  )
  const onOpen = useCallback((id: string) => navigate(`/w/${wsId}/p/${id}`), [navigate, wsId])
  const openGlobal = () => navigate(`/w/${wsId}/graph?focus=${focusId}`)

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // Close the modal when navigating to another page
  useEffect(() => setExpanded(false), [focusId])

  if (graph.isLoading) return <p className="text-xs text-sub">{t('common.loading')}</p>
  if (graph.isError || !graph.data || !model)
    return <p className="text-xs text-sub">{t('localGraph.loadFailed')}</p>
  if (!graph.data.nodes.some((n) => n.id === focusId))
    return <p className="text-xs text-sub">{t('localGraph.noLinks')}</p>

  const alone = model.nodes.length <= 1

  return (
    <div className="space-y-2">
      <LocalOptions />
      {alone ? (
        <p className="text-xs text-sub">{t('localGraph.noLinks')}</p>
      ) : (
        <div className="relative">
          <GraphCanvas
            className="h-[240px] w-full rounded-md border border-line"
            model={model}
            settings={settings}
            focusId={focusId}
            fontSize={11}
            active={!expanded}
            onOpen={onOpen}
          />
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label={t('localGraph.expand')}
            title={t('localGraph.expand')}
            className="absolute right-1.5 top-1.5 rounded-md bg-app/90 p-1 text-sub hover:bg-hover hover:text-ink"
          >
            <ExpandIcon size={14} />
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={openGlobal}
        className="flex items-center gap-1 text-[11px] text-sub hover:text-ink"
      >
        <GraphIcon size={12} /> {t('localGraph.openInGraph')}
      </button>

      {expanded &&
        createPortal(
          <div
            className="nd-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-6"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setExpanded(false)
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('localGraph.title')}
              className="nd-pop flex h-full max-h-[900px] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-line bg-app shadow-xl"
            >
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <GraphIcon size={15} className="text-sub" /> {t('localGraph.title')}
                </span>
                <span className="flex-1" />
                <LocalOptions />
                <button
                  type="button"
                  onClick={openGlobal}
                  className="rounded-md px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
                >
                  {t('localGraph.openInGraph')}
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  aria-label={t('common.close')}
                  className="rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
                >
                  <XIcon size={18} />
                </button>
              </div>
              <GraphCanvas
                className="min-h-0 flex-1"
                model={model}
                settings={bigSettings}
                focusId={focusId}
                onOpen={onOpen}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
