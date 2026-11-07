import type { ReactNode } from 'react'
import {
  DEFAULT_GRAPH_PREFS,
  setGraphPref,
  setPref,
  type GraphPrefs,
} from '../../lib/prefs'
import { useT } from '../../i18n'
import { SearchIcon, XIcon } from '../Icons'
import { colorOf, G_NEUTRAL, G_ORPHAN, G_TAG, type GraphColors, type ModelGroup } from './graphModel'

// Mimics Obsidian's graph settings panel: filters / groups / display / forces. Values are stored in per-device prefs.

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-xs text-ink">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150 ${
          checked ? 'bg-accent' : 'bg-line'
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left] duration-150 ${
            checked ? 'left-3.5' : 'left-0.5'
          }`}
        />
      </button>
    </label>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="block py-1 text-xs text-ink">
      <span className="flex items-center justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-sub">{Number.isInteger(step) ? value : value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--color-accent)]"
      />
    </label>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-line px-3 py-2 first:border-t-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{title}</div>
      {children}
    </div>
  )
}

export function GraphControls({
  prefs,
  search,
  onSearch,
  matchCount,
  hasTags,
  groups,
  colors,
  onClose,
}: {
  prefs: GraphPrefs
  search: string
  onSearch: (q: string) => void
  matchCount: number | null
  hasTags: boolean
  groups: ModelGroup[]
  colors: GraphColors | null
  onClose?: () => void
}) {
  const t = useT()
  const shown = groups.slice(0, 8)
  const rest = groups.length - shown.length
  const swatch = (gi: number) =>
    colors ? colorOf(gi, colors, prefs.colorGroups) : 'var(--color-sub)'

  return (
    <div className="text-ink">
      {onClose && (
        <div className="flex items-center justify-between px-3 pt-2">
          <span className="text-sm font-medium">{t('graph.settingsTitle')}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('graph.closeSettings')}
            className="rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
          >
            <XIcon size={16} />
          </button>
        </div>
      )}

      <Group title={t('graph.filters')}>
        <div className="relative">
          <SearchIcon size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sub" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t('graph.searchTitles')}
            aria-label={t('graph.searchAria')}
            className="w-full rounded-md border border-line bg-app py-1 pl-7 pr-2 text-base text-ink outline-none placeholder:text-sub focus:border-accent sm:text-xs"
          />
        </div>
        {matchCount !== null && (
          <p className="mt-1 text-[11px] text-sub">{t('graph.matchCount', { count: matchCount })}</p>
        )}
        <Toggle label={t('graph.showOrphans')} checked={prefs.showOrphans} onChange={(v) => setGraphPref('showOrphans', v)} />
        {hasTags && (
          <Toggle label={t('graph.showTags')} checked={prefs.showTags} onChange={(v) => setGraphPref('showTags', v)} />
        )}
      </Group>

      <Group title={t('graph.groups')}>
        <Toggle label={t('graph.colorByFolder')} checked={prefs.colorGroups} onChange={(v) => setGraphPref('colorGroups', v)} />
        <ul className="mt-1 space-y-0.5 text-xs">
          {prefs.colorGroups &&
            shown.map((g, i) => (
              <li key={g.key} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: swatch(i) }} />
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                <span className="text-[11px] text-sub">{g.count}</span>
              </li>
            ))}
          {prefs.colorGroups && rest > 0 && <li className="pl-4.5 text-[11px] text-sub">{t('graph.moreGroups', { count: rest })}</li>}
          <li className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: swatch(G_NEUTRAL) }} />
            <span className="flex-1">{prefs.colorGroups ? t('graph.rootPages') : t('common.pages')}</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: swatch(G_ORPHAN) }} />
            <span className="flex-1">{t('graph.orphans')}</span>
          </li>
          {hasTags && prefs.showTags && (
            <li className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: swatch(G_TAG) }} />
              <span className="flex-1">{t('graph.tags')}</span>
            </li>
          )}
        </ul>
      </Group>

      <Group title={t('graph.display')}>
        <Toggle label={t('graph.arrows')} checked={prefs.arrows} onChange={(v) => setGraphPref('arrows', v)} />
        <Slider label={t('graph.nodeSize')} value={prefs.nodeSize} min={0.5} max={2.5} step={0.05} onChange={(v) => setGraphPref('nodeSize', v)} />
      </Group>

      <Group title={t('graph.forces')}>
        <Slider label={t('graph.centerForce')} value={prefs.centerForce} min={0} max={1} step={0.01} onChange={(v) => setGraphPref('centerForce', v)} />
        <Slider label={t('graph.repelForce')} value={prefs.repelForce} min={0} max={20} step={0.5} onChange={(v) => setGraphPref('repelForce', v)} />
        <Slider label={t('graph.linkForce')} value={prefs.linkForce} min={0} max={1} step={0.01} onChange={(v) => setGraphPref('linkForce', v)} />
        <Slider label={t('graph.linkDistance')} value={prefs.linkDistance} min={20} max={300} step={1} onChange={(v) => setGraphPref('linkDistance', v)} />
        <button
          type="button"
          onClick={() => setPref('graph', { ...DEFAULT_GRAPH_PREFS, panelOpen: prefs.panelOpen })}
          className="mt-1 text-[11px] text-sub underline-offset-2 hover:text-ink hover:underline"
        >
          {t('graph.resetDefaults')}
        </button>
      </Group>
    </div>
  )
}
