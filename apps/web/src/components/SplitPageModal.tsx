import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PageMetaDTO, RotationMode } from '@inkling/shared'
import { ROTATION_DEFAULT_BYTES } from '@inkling/shared'
import { fmtSize } from '../largePagesApi'
import { usePageRotation, useSetRotation, useSplitPage, useSplitPreview } from '../splitApi'
import { toast } from '../lib/toast'
import { useT } from '../i18n'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

// "Split into subpages" (docs/adr/1140-*) and "New entries" (automatic splitting, docs/adr/1141-*).
// The preview comes from the same route that splits (preview: true), so the list is what will run.
// The server re-checks everything (edit lock, placement) and refuses a split whose sections changed.

const LEVELS = [1, 2, 3] as const
const SIZE_OPTIONS = [256 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024]

const selectClass =
  'rounded-md border border-line bg-app px-1.5 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60'

export function SplitPageModal({
  open,
  onClose,
  wsId,
  page,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  page: PageMetaDTO
}) {
  const t = useT()
  const [level, setLevel] = useState(2)
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const preview = useSplitPreview(page.id, level, open)
  const split = useSplitPage(wsId, page.id)
  const sections = useMemo(() => preview.data?.sections ?? [], [preview.data])

  // A fresh preview selects every section; picking a level with no heading of the default level
  // moves to the first level that has some.
  useEffect(() => {
    setPicked(null)
    setError(null)
  }, [level, preview.data])
  useEffect(() => {
    const lv = preview.data?.levels
    if (!lv || lv[level - 1] > 0) return
    const first = LEVELS.find((l) => lv[l - 1] > 0)
    if (first && first !== level) setLevel(first)
    // only on the first answer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.data?.pageId])

  const selected = picked ?? new Set(sections.map((s) => s.blockId))
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }
  const allOn = selected.size === sections.length

  const submit = () => {
    setError(null)
    const ids = sections.filter((s) => selected.has(s.blockId)).map((s) => s.blockId)
    split.mutate(
      { level, sections: ids },
      {
        onSuccess: (r) => {
          onClose()
          toast({ message: t('split.done', { count: r.sections.length }) })
        },
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    )
  }

  const levels = preview.data?.levels
  return (
    <Modal open={open} onClose={onClose} title={t('split.title')} size="md">
      <div className="flex flex-col gap-3 text-sm" data-testid="split-page-modal">
        <p className="text-xs text-sub">{t('split.intro')}</p>

        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-sub">{t('split.level')}</span>
          <div role="radiogroup" aria-label={t('split.level')} className="flex rounded-md border border-line p-0.5">
            {LEVELS.map((l) => {
              const n = levels?.[l - 1] ?? 0
              const on = l === level
              return (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setLevel(l)}
                  className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs transition-colors duration-150 ${
                    on ? 'bg-hover text-ink' : 'text-sub hover:text-ink'
                  }`}
                >
                  <span className="font-medium">{t('split.levelOption', { level: l })}</span>
                  {levels && <span className="tabular-nums text-sub">{t('split.levelCount', { count: n })}</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="min-h-[7rem] overflow-hidden rounded-md border border-line">
          {preview.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner size={18} />
            </div>
          ) : preview.isError ? (
            <p className="px-3 py-4 text-xs text-red-600">{t('split.loadError')}</p>
          ) : sections.length === 0 ? (
            <p className="px-3 py-4 text-xs text-sub">{t('split.none')}</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1" data-testid="split-preview">
              {sections.map((s) => {
                const facts = [t('split.blocks', { count: s.blocks }), fmtSize(s.bytes)]
                if (s.comments) facts.push(t('split.comments', { count: s.comments }))
                return (
                  <li key={s.blockId}>
                    <label className="flex min-h-9 cursor-pointer items-center gap-2.5 px-3 py-1 hover:bg-hover">
                      <input
                        type="checkbox"
                        checked={selected.has(s.blockId)}
                        onChange={() => toggle(s.blockId)}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-ink">{s.title || t('common.untitled')}</span>
                      <span className="shrink-0 text-xs tabular-nums text-sub">{facts.join(' · ')}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {sections.length > 0 && (
          <div className="flex items-center justify-between text-xs text-sub">
            <span>{t('split.selected', { selected: selected.size, total: sections.length })}</span>
            <button
              type="button"
              onClick={() => setPicked(allOn ? new Set() : null)}
              className="rounded px-1.5 py-0.5 text-accent hover:bg-hover"
            >
              {t(allOn ? 'split.selectNone' : 'split.selectAll')}
            </button>
          </div>
        )}

        {!!preview.data?.openBy && (
          <p className="text-xs text-amber-600">{t('split.openBy', { count: preview.data.openBy })}</p>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-xs text-ink transition-colors duration-150 hover:bg-hover"
          >
            {t('split.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={split.isPending || selected.size === 0}
            data-testid="split-submit"
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {split.isPending && <Spinner size={12} className="border-white/40 border-t-white" />}
            {t('split.submit', { count: selected.size })}
          </button>
        </div>

        <RotationSettings pageId={page.id} enabled={open} />
      </div>
    </Modal>
  )
}

function RotationSettings({ pageId, enabled }: { pageId: string; enabled: boolean }) {
  const t = useT()
  const q = usePageRotation(pageId, enabled)
  const set = useSetRotation(pageId)
  const mode: RotationMode = q.data?.mode ?? 'off'
  const maxBytes = q.data?.maxBytes ?? ROTATION_DEFAULT_BYTES
  const busy = !q.data || set.isPending
  const choose = (m: RotationMode, bytes = maxBytes) => set.mutate({ mode: m, maxBytes: bytes })
  const radio = (m: RotationMode, label: string, extra?: ReactNode) => (
    <label className="flex min-h-8 items-center gap-2">
      <input type="radio" name={`rotation-${pageId}`} checked={mode === m} disabled={busy} onChange={() => choose(m)} />
      <span className="text-sm text-ink">{label}</span>
      {extra}
    </label>
  )
  return (
    <section className="flex flex-col gap-1 border-t border-line pt-3" data-testid="split-rotation">
      <h3 className="text-xs font-medium text-ink">{t('split.auto')}</h3>
      <p className="text-xs text-sub">{t('split.autoHint')}</p>
      <div className="mt-1 flex flex-col">
        {radio('off', t('split.autoOff'))}
        {radio('month', t('split.autoMonth'))}
        {radio(
          'size',
          t('split.autoSize'),
          <select
            value={maxBytes}
            disabled={busy}
            onChange={(e) => choose('size', Number(e.target.value))}
            className={selectClass}
            aria-label={t('split.autoSize')}
          >
            {[...new Set([...SIZE_OPTIONS, maxBytes])].sort((a, b) => a - b).map((b) => (
              <option key={b} value={b}>
                {fmtSize(b)}
              </option>
            ))}
          </select>,
        )}
      </div>
      {mode !== 'off' && q.data?.current && (
        <p className="text-xs text-sub">{t('split.autoCurrent', { title: q.data.current.title })}</p>
      )}
    </section>
  )
}
