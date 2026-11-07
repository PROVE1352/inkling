import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useGraph } from '../api'
import { useT } from '../i18n'
import { useLayout } from '../components/AppLayout'
import { GraphCanvas, type GraphCanvasHandle } from '../components/graph/GraphCanvas'
import { GraphControls } from '../components/graph/GraphControls'
import { buildModel, readGraphColors } from '../components/graph/graphModel'
import type { EngineSettings } from '../components/graph/graphEngine'
import { Spinner } from '../components/Spinner'
import { ThemeToggle } from '../components/ThemeToggle'
import { NavButtons } from '../components/NavButtons'
import { FitIcon, GraphIcon, MenuIcon, SlidersIcon } from '../components/Icons'
import { setGraphPref, usePrefs } from '../lib/prefs'
import { useTheme } from '../lib/theme'
import { useIsPhone } from '../lib/useMediaQuery'

// Workspace knowledge graph view — /w/:wsId/graph (?focus=<pageId> centers on and highlights that page)
export function GraphView() {
  const t = useT()
  const { wsId } = useParams()
  const [params] = useSearchParams()
  const focusId = params.get('focus')
  const navigate = useNavigate()
  const { onToggleSidebar } = useLayout()
  const graph = useGraph(wsId ?? '')
  const { graph: gp } = usePrefs()
  const { resolved } = useTheme()
  const isPhone = useIsPhone()
  const canvasRef = useRef<GraphCanvasHandle>(null)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  // Phone: settings live in a bottom sheet (closed by default). Desktop/tablet: saved open/closed state.
  const [sheetOpen, setSheetOpen] = useState(false)
  // "Only this island": hub page id of the island being shown (not saved; cleared on reload)
  const [island, setIsland] = useState<string | null>(null)
  const panelOpen = isPhone ? sheetOpen : gp.panelOpen
  const togglePanel = () => (isPhone ? setSheetOpen((v) => !v) : setGraphPref('panelOpen', !gp.panelOpen))

  const model = useMemo(
    () =>
      graph.data
        ? buildModel(graph.data, {
            showOrphans: gp.showOrphans,
            showTags: gp.showTags,
            colorBy: gp.colorIslands ? 'island' : 'folder',
            island,
          })
        : null,
    [graph.data, gp.showOrphans, gp.showTags, gp.colorIslands, island],
  )
  const settings: EngineSettings = useMemo(
    () => ({
      centerForce: gp.centerForce,
      repelForce: gp.repelForce,
      linkDistance: gp.linkDistance,
      linkForce: gp.linkForce,
      nodeSize: gp.nodeSize,
      arrows: gp.arrows,
      colorGroups: gp.colorGroups || gp.colorIslands,
    }),
    [gp.centerForce, gp.repelForce, gp.linkDistance, gp.linkForce, gp.nodeSize, gp.arrows, gp.colorGroups, gp.colorIslands],
  )
  const colors = useMemo(() => readGraphColors(resolved === 'dark'), [resolved])
  const matchCount = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    if (!q || !model) return null
    return model.nodes.filter((n) => n.label.toLowerCase().includes(q)).length
  }, [deferredSearch, model])

  const onOpen = useCallback((id: string) => navigate(`/w/${wsId}/p/${id}`), [navigate, wsId])

  const empty = !graph.data || graph.data.nodes.length === 0
  // The hint wraps an inline <code> sample; split the translated sentence around its {code} slot.
  const [emptyHintBefore, emptyHintAfter = ''] = t('graph.emptyHint', { code: '\u0000' }).split('\u0000')

  const controls = model ? (
    <GraphControls
      prefs={gp}
      search={search}
      onSearch={setSearch}
      matchCount={matchCount}
      hasTags={model.hasTags}
      groups={model.groups}
      islandCount={model.islandCount}
      island={island}
      onIsland={setIsland}
      wsId={wsId ?? ''}
      onOpen={onOpen}
      colors={colors}
      onClose={togglePanel}
    />
  ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('graph.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <GraphIcon size={16} className="text-sub" /> {t('graph.title')}
        </span>
        <span className="flex-1" />
        <ThemeToggle />
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {graph.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={22} />
          </div>
        ) : graph.isError ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-sub">
            {t('localGraph.loadFailed')}
          </div>
        ) : empty || !model ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sub">
            <GraphIcon size={32} className="text-sub" />
            <p className="text-sm text-ink">{t('graph.emptyTitle')}</p>
            <p className="text-xs">
              {emptyHintBefore}
              <code>[[{t('graph.emptyHintTitle')}]]</code>
              {emptyHintAfter}
            </p>
          </div>
        ) : (
          <>
            <GraphCanvas
              ref={canvasRef}
              className="nd-enter h-full w-full"
              model={model}
              settings={settings}
              focusId={focusId}
              search={deferredSearch}
              onOpen={onOpen}
            />

            {/* Top right: settings panel (desktop/tablet) */}
            {!isPhone &&
              (panelOpen ? (
                <div className="nd-pop absolute right-3 top-3 max-h-[calc(100%-1.5rem)] w-64 overflow-y-auto rounded-lg border border-line bg-app/95 shadow-lg backdrop-blur">
                  {controls}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={togglePanel}
                  aria-label={t('graph.openSettings')}
                  title={t('graph.settingsTitle')}
                  className="absolute right-3 top-3 rounded-md border border-line bg-app/95 p-2 text-sub shadow-sm hover:text-ink"
                >
                  <SlidersIcon size={16} />
                </button>
              ))}

            {/* Bottom right (plus the settings button on phones): fit to screen */}
            <div className="absolute bottom-3 right-3 flex flex-col gap-2">
              {isPhone && (
                <button
                  type="button"
                  onClick={togglePanel}
                  aria-label={t('graph.openSettings')}
                  className="rounded-full border border-line bg-app p-2.5 text-sub shadow-md active:scale-95"
                >
                  <SlidersIcon size={18} />
                </button>
              )}
              <button
                type="button"
                onClick={() => canvasRef.current?.fit()}
                aria-label={t('graph.fit')}
                title={t('graph.fit')}
                className={`border border-line bg-app text-sub shadow-md hover:text-ink active:scale-95 ${
                  isPhone ? 'rounded-full p-2.5' : 'rounded-md p-2'
                }`}
              >
                <FitIcon size={isPhone ? 18 : 16} />
              </button>
            </div>

            {/* Phone: bottom sheet */}
            {isPhone && sheetOpen && (
              <>
                <div className="absolute inset-0 bg-black/20" onClick={() => setSheetOpen(false)} />
                <div className="nd-pop absolute inset-x-0 bottom-0 max-h-[65%] overflow-y-auto rounded-t-xl border-t border-line bg-app pb-[env(safe-area-inset-bottom)] shadow-2xl">
                  <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" />
                  {controls}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
