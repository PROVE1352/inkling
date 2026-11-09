import { useEffect, useId, useRef, useState } from 'react'
import { t, useT } from '../i18n'
import { PLATFORM, SHORTCUTS, getOverrides, saveOverrides, useShortcutKeys } from '../lib/shortcuts'
import { formatKey, specFromEvent, toKeyEvent } from '../lib/shortcuts/keys'
import { shortcutById, type Conflict } from '../lib/shortcuts/registry'
import {
  checkBinding,
  defaultConflicts,
  exportOverrides,
  importOverrides,
  overrideConflicts,
  withBinding,
  withDefault,
  withNoKey,
  type BindingCheck,
  type BindingProblem,
} from '../lib/shortcuts/remap'
import { ConfirmPopover } from './ConfirmPopover'
import { DownloadIcon, RestoreIcon, SearchIcon, UploadIcon } from './Icons'
import { DeviceBadge } from './SettingsRows'
import { Kbd, filterGroups, shortcutGroups, type Row } from './ShortcutsModal'

// Settings › Shortcuts with changing keys (docs/adr/1404-*, 1405-*). Click a command's keys, press the
// new combination: it is checked (bare characters, keys the OS or the browser keeps, other commands on
// the same key) and saved on this device. A clash asks before the key moves; a reserved browser key asks
// before it is used. Default / Reset all / Export / Import work on the same overrides.

type Pending =
  | { kind: 'bind'; id: string; spec: string; check: BindingCheck }
  | { kind: 'reset'; id: string; conflicts: string[] }

const btn =
  'inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40'
const primaryBtn =
  'inline-flex items-center rounded-md bg-accent px-2 py-1 text-xs font-medium text-white transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1'

function commandName(id: string): string {
  if (id === 'editor.builtin') return t('keys.editorOwn')
  const d = shortcutById(id)
  return d ? t(d.label) : id
}

const mods = () => (PLATFORM === 'mac' ? t('keys.modsMac') : t('keys.modsOther'))

function problemText(p: BindingProblem, spec: string): string {
  const key = formatKey(spec, PLATFORM)
  switch (p.kind) {
    case 'notRemappable':
      return t('keys.fixedTitle')
    case 'bareChar':
      return t('keys.errBareChar', { mods: mods() })
    case 'bareKey':
      return t('keys.errBareKey', { mods: mods() })
    case 'blocked':
      return p.why === 'os' ? t('keys.errOs', { key }) : t('keys.errTextEditing', { key })
    case 'fixedConflict':
      return p.with === 'editor.builtin' ? t('keys.errBuiltin', { key }) : t('keys.errFixed', { key, name: commandName(p.with) })
  }
}

const conflictList = (cs: Conflict[]) =>
  cs.map((c) => `${commandName(c.a)} / ${commandName(c.b)} (${formatKey(c.key, PLATFORM)})`).join(', ')

const focusLater = (selector: string) =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())

export function ShortcutSettings() {
  useT()
  useShortcutKeys()
  const [query, setQuery] = useState('')
  const [capturing, setCapturing] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const [announce, setAnnounce] = useState('')
  const [resetAllOpen, setResetAllOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const descId = useId()

  const groups = filterGroups(shortcutGroups(SHORTCUTS, { all: true }), query)
  const clashes = overrideConflicts(getOverrides(), PLATFORM)

  const backToRow = (id: string) => focusLater(`[data-change="${CSS.escape(id)}"]`)
  const stop = (id: string) => {
    setCapturing(null)
    setError(null)
    setPending(null)
    backToRow(id)
  }
  const said = (id: string) => {
    const keys = getOverrides()[PLATFORM]?.[id] ?? shortcutById(id)?.keys?.[PLATFORM] ?? []
    setAnnounce(
      keys.length
        ? t('keys.saved', { name: commandName(id), key: keys.map((k) => formatKey(k, PLATFORM)).join(' ') })
        : t('keys.savedNone', { name: commandName(id) }),
    )
  }
  const commit = (id: string, spec: string) => {
    saveOverrides(withBinding(getOverrides(), id, spec, PLATFORM))
    said(id)
    stop(id)
  }
  const removeKey = (id: string) => {
    saveOverrides(withNoKey(getOverrides(), id, PLATFORM))
    said(id)
    stop(id)
  }
  const reset = (id: string, confirmed = false) => {
    const conflicts = defaultConflicts(getOverrides(), id, PLATFORM)
    if (conflicts.length && !confirmed) {
      setPending({ kind: 'reset', id, conflicts })
      focusLater('[data-confirm-key]')
      return
    }
    saveOverrides(withDefault(getOverrides(), id, PLATFORM))
    said(id)
    stop(id)
  }

  const startCapture = (id: string) => {
    setPending(null)
    setError(null)
    setCapturing(id)
  }

  const onCaptureKey = (id: string) => (e: React.KeyboardEvent) => {
    // the capture box takes every key: nothing reaches the app's shortcuts, the browser keeps only what it never gives a page
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    const r = specFromEvent(toKeyEvent(e.nativeEvent), PLATFORM)
    if (r.kind === 'ignore') return
    if (r.kind === 'cancel') return stop(id)
    if (r.kind === 'invalid') {
      setError({ id, text: r.reason === 'winKey' ? t('keys.errWinKey') : t('keys.errAltGr') })
      return
    }
    const check = checkBinding(id, r.spec, PLATFORM, getOverrides())
    if (check.problem) {
      setError({ id, text: problemText(check.problem, r.spec) })
      return
    }
    if (check.conflicts.length || check.warning) {
      setCapturing(null)
      setError(null)
      setPending({ kind: 'bind', id, spec: r.spec, check })
      focusLater('[data-confirm-key]')
      return
    }
    commit(id, r.spec)
  }

  const onExport = () => {
    const blob = new Blob([exportOverrides(getOverrides())], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'inkling-shortcuts.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const onImport = async (file: File | undefined) => {
    if (!file) return
    const r = importOverrides(await file.text())
    if (fileRef.current) fileRef.current.value = ''
    if (!r.ok) {
      const text =
        r.error === 'conflict'
          ? t('keys.importConflict', { list: conflictList(r.conflicts) })
          : r.error === 'json'
            ? t('keys.importJson')
            : t('keys.importFormat')
      setNotice({ text, tone: 'error' })
      return
    }
    saveOverrides(r.overrides)
    setNotice({
      text: r.dropped.length ? t('keys.importedSkipped', { count: r.dropped.length }) : t('keys.imported'),
      tone: 'ok',
    })
  }

  // a capture box left by clicking elsewhere stops capturing
  useEffect(() => {
    if (!capturing) return
    const onDown = (e: MouseEvent) => {
      const row = document.querySelector(`[data-shortcut-row="${CSS.escape(capturing)}"]`)
      if (row && !row.contains(e.target as Node)) {
        setCapturing(null)
        setError(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [capturing])

  const rowView = (r: Row) => {
    const isCapturing = capturing === r.id
    const rowPending = pending?.id === r.id ? pending : null
    const rowError = error?.id === r.id ? error.text : null
    return (
      <div key={r.id} data-shortcut-row={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
        <div className="min-w-0 flex-1 basis-52 text-sm text-ink">
          {r.label}
          {r.hint && <span className="ml-1 text-xs text-sub">({r.hint})</span>}
          {r.changed && (
            <span className="ml-2 inline-flex items-center rounded bg-accent-soft px-1 py-px align-[1px] text-[10px] font-medium leading-none text-accent">
              {t('keys.changed')}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {isCapturing ? (
            <>
              <div
                data-capture
                // focused as soon as it mounts, so the very next key press lands here
                ref={(el) => el?.focus()}
                tabIndex={0}
                role="button"
                aria-label={t('keys.changeFor', { name: r.label })}
                aria-describedby={`${descId}-${r.id}`}
                aria-invalid={rowError ? true : undefined}
                onKeyDown={onCaptureKey(r.id)}
                className="min-w-[10rem] animate-pulse rounded-md border border-accent bg-accent-soft/50 px-2 py-1 text-xs text-ink outline-none ring-2 ring-accent/40 motion-reduce:animate-none"
              >
                {t('keys.press')} <span id={`${descId}-${r.id}`} className="text-sub">({t('keys.pressHint')})</span>
              </div>
              <button type="button" className={btn} onMouseDown={(e) => e.preventDefault()} onClick={() => removeKey(r.id)}>
                {t('keys.remove')}
              </button>
              <button type="button" className={btn} onMouseDown={(e) => e.preventDefault()} onClick={() => stop(r.id)}>
                {t('common.cancel')}
              </button>
            </>
          ) : r.fixed ? (
            <>
              {r.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
              <span title={t('keys.fixedTitle')} className="rounded border border-line px-1 py-px text-[10px] leading-none text-sub">
                {t('keys.fixed')}
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                data-change={r.id}
                onClick={() => startCapture(r.id)}
                aria-label={`${t('keys.changeFor', { name: r.label })}: ${r.keys.join(' ') || t('keys.noKey')}`}
                className="flex min-h-7 items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {r.keys.length ? (
                  r.keys.map((k) => <Kbd key={k}>{k}</Kbd>)
                ) : (
                  <span className="px-1 text-xs text-sub">{t('keys.noKey')}</span>
                )}
              </button>
              {r.changed && (
                <button
                  type="button"
                  className={btn}
                  onClick={() => reset(r.id)}
                  aria-label={t('keys.resetFor', { name: r.label })}
                  title={t('keys.resetFor', { name: r.label })}
                >
                  <RestoreIcon size={12} />
                  {t('keys.reset')}
                </button>
              )}
            </>
          )}
        </div>
        {rowError && (
          <p role="alert" className="basis-full text-right text-xs text-red-600 dark:text-red-400">
            {rowError}
          </p>
        )}
        {rowPending && (
          <div
            role="alertdialog"
            aria-label={r.label}
            data-pending={rowPending.kind}
            className="flex basis-full flex-wrap items-center justify-end gap-2 rounded-md border border-amber-400/60 bg-amber-50 px-2.5 py-2 text-xs text-ink dark:border-amber-300/30 dark:bg-amber-400/10"
          >
            <span className="min-w-0 flex-1 basis-60 leading-relaxed">
              {rowPending.kind === 'bind' ? (
                <>
                  {rowPending.check.conflicts.length > 0 && (
                    <span className="block">
                      {rowPending.check.conflicts.length === 1
                        ? t('keys.conflict', { key: formatKey(rowPending.spec, PLATFORM), name: commandName(rowPending.check.conflicts[0]) })
                        : t('keys.conflictMany', {
                            key: formatKey(rowPending.spec, PLATFORM),
                            names: rowPending.check.conflicts.map((c) => `‘${commandName(c)}’`).join(', '),
                          })}{' '}
                      <span className="text-sub">{t('keys.replaceHint')}</span>
                    </span>
                  )}
                  {rowPending.check.warning && (
                    <span className="block">
                      {t(rowPending.check.warning === 'tabReserved' ? 'keys.warnTab' : 'keys.warnBrowser', {
                        key: formatKey(rowPending.spec, PLATFORM),
                      })}
                    </span>
                  )}
                </>
              ) : (
                <>
                  {t('keys.conflictMany', {
                    key: (shortcutById(r.id)?.keys?.[PLATFORM] ?? []).map((k) => formatKey(k, PLATFORM)).join(' '),
                    names: rowPending.conflicts.map((c) => `‘${commandName(c)}’`).join(', '),
                  })}{' '}
                  <span className="text-sub">{t('keys.replaceHint')}</span>
                </>
              )}
            </span>
            <button
              type="button"
              data-confirm-key
              className={primaryBtn}
              onClick={() => (rowPending.kind === 'bind' ? commit(r.id, rowPending.spec) : reset(r.id, true))}
            >
              {rowPending.kind === 'bind' && rowPending.check.conflicts.length === 0 ? t('keys.useAnyway') : t('keys.replace')}
            </button>
            <button type="button" className={btn} onClick={() => stop(r.id)}>
              {t('common.cancel')}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-testid="shortcut-settings">
      <p className="mb-4 text-xs leading-relaxed text-sub">
        {t('keys.desc')}
        <DeviceBadge />
      </p>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <label className="relative block min-w-0 flex-1 basis-48 sm:max-w-xs">
          <span className="sr-only">{t('shortcuts.search')}</span>
          <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sub" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('shortcuts.search')}
            className="w-full rounded-md border border-line bg-app py-1.5 pl-8 pr-2 text-sm text-ink placeholder:text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" className={btn} onClick={() => fileRef.current?.click()}>
            <UploadIcon size={12} />
            {t('keys.import')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="shortcut-import"
            onChange={(e) => void onImport(e.target.files?.[0])}
          />
          <button type="button" className={btn} onClick={onExport}>
            <DownloadIcon size={12} />
            {t('keys.export')}
          </button>
          <ConfirmPopover
            open={resetAllOpen}
            onCancel={() => setResetAllOpen(false)}
            onConfirm={() => {
              setResetAllOpen(false)
              saveOverrides({})
              setNotice(null)
            }}
            message={t('keys.resetAllConfirm')}
            confirmLabel={t('keys.resetAll')}
          >
            <button
              type="button"
              className={btn}
              disabled={Object.keys(getOverrides()).length === 0}
              onClick={() => setResetAllOpen(true)}
            >
              <RestoreIcon size={12} />
              {t('keys.resetAll')}
            </button>
          </ConfirmPopover>
        </div>
      </div>
      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`mb-4 rounded-md border px-3 py-2 text-xs ${notice.tone === 'error' ? 'border-red-300 text-red-700 dark:border-red-400/40 dark:text-red-300' : 'border-line text-ink'}`}
        >
          {notice.text}
        </p>
      )}
      {clashes.length > 0 && (
        <p role="alert" className="mb-4 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs text-ink dark:border-amber-300/30 dark:bg-amber-400/10">
          {t('keys.clashes', { list: conflictList(clashes) })}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {groups.length === 0 ? (
        <p className="py-2 text-sm text-sub">{t('shortcuts.noMatch')}</p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <section key={g.scope} aria-label={g.title} data-scope={g.scope}>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{g.title}</h3>
              <div className="divide-y divide-line border-y border-line">{g.rows.map(rowView)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
