import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { DownloadIcon, MonitorIcon, MoonIcon, MoreHorizontalIcon, SunIcon, WidthIcon } from './Icons'
import { PrinterIcon } from './ExportPdfButton'
import { PresentIcon } from './Presentation'
import { ThemeToggle } from './ThemeToggle'
import { markPrintRoot, printWhenReady } from '../lib/printPage'
import { setTheme, useTheme, type Theme } from '../lib/theme'
import { useT, type TKey } from '../i18n'
import '../publicView.css'

// Actions of a public page (docs/adr/2360-*, 2361-*, 2362-*, 2363-*): present, wide view, save as
// PDF, download Markdown (when the link allows it) and the theme. From the `sm` width up they are a
// row of buttons; below it one "⋯" button opens them as a menu. Hidden when printing.

const WIDTH_KEY = 'inkling-public-width'

function readWidth(): 'wide' | 'narrow' | null {
  try {
    const v = localStorage.getItem(WIDTH_KEY)
    return v === 'wide' || v === 'narrow' ? v : null
  } catch {
    return null // storage unavailable: the page's own default
  }
}

/**
 * Wide or narrow view of a public page: the visitor's last choice in this browser, else the page's
 * own "Full width" setting (docs/adr/2360-*).
 */
export function usePublicWide(pageDefault: boolean): [boolean, (wide: boolean) => void] {
  const [wide, setWide] = useState(() => {
    const saved = readWidth()
    return saved ? saved === 'wide' : pageDefault
  })
  const change = useCallback((next: boolean) => {
    setWide(next)
    try {
      localStorage.setItem(WIDTH_KEY, next ? 'wide' : 'narrow')
    } catch {
      // not remembered; the choice still applies to this page
    }
  }, [])
  return [wide, change]
}

/**
 * Keep `ref`'s element marked as the thing to print while it is shown, so the browser's own Print
 * command prints the article alone, like the button (docs/adr/2361-*). Returns the button's action.
 */
export function usePublicPrint(ref: RefObject<HTMLElement | null>, title: string): () => void {
  useEffect(() => {
    const el = ref.current
    return el ? markPrintRoot(el) : undefined
  }, [ref])
  return useCallback(() => printWhenReady(title), [title])
}

const THEME_ORDER: Theme[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<Theme, TKey> = { light: 'theme.light', dark: 'theme.dark', system: 'theme.system' }

interface Props {
  wide: boolean
  onWide: (wide: boolean) => void
  onPresent: () => void
  onPdf: () => void
  /** the Markdown download, when the link allows it */
  markdownHref?: string
  /** the theme switch belongs to this bar (single-page links; folder links keep theirs in the side bar) */
  withTheme?: boolean
}

const BTN =
  'flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

export function PublicToolbar({ wide, onWide, onPresent, onPdf, markdownHref, withTheme }: Props) {
  const t = useT()
  return (
    <div role="toolbar" aria-label={t('publicView.toolbar')} className="mb-4 flex items-center justify-end gap-1.5" data-print-hide>
      <div className="hidden items-center gap-1.5 sm:flex">
        <button type="button" onClick={onPresent} data-testid="public-present" className={BTN}>
          <PresentIcon size={14} />
          {t('present.menu')}
        </button>
        <button
          type="button"
          onClick={() => onWide(!wide)}
          aria-pressed={wide}
          title={t('publicView.wideHint')}
          data-testid="public-wide"
          className={`${BTN} ${wide ? 'bg-active text-ink' : ''}`}
        >
          <WidthIcon size={14} />
          {t('publicView.wide')}
        </button>
        <button type="button" onClick={onPdf} data-testid="public-pdf" className={BTN}>
          <PrinterIcon size={14} />
          {t('publicView.pdf')}
        </button>
        {markdownHref && (
          <a href={markdownHref} download data-testid="public-md" className={BTN}>
            <DownloadIcon size={14} />
            {t('publicView.markdown')}
          </a>
        )}
        {withTheme && <ThemeToggle />}
      </div>
      <MoreMenu wide={wide} onWide={onWide} onPresent={onPresent} onPdf={onPdf} markdownHref={markdownHref} withTheme={withTheme} />
    </div>
  )
}

/** Narrow screens: the same actions behind one "⋯" button (a menu: arrows move, Esc closes). */
function MoreMenu({ wide, onWide, onPresent, onPdf, markdownHref, withTheme }: Props) {
  const t = useT()
  const { theme } = useTheme()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }
  const run = (fn: () => void) => () => {
    close()
    fn()
  }
  const cycleTheme = () => setTheme(THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length])
  const item = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none'

  return (
    <div className="relative sm:hidden">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('publicView.more')}
        data-testid="public-more"
        className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <MoreHorizontalIcon size={18} />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={t('publicView.toolbar')}
          onKeyDown={onKey}
          data-testid="public-more-menu"
          className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-line bg-app py-1 shadow-lg"
        >
          <MenuItem className={item} onSelect={run(onPresent)} icon={<PresentIcon size={16} />}>
            {t('present.menu')}
          </MenuItem>
          <MenuItem className={item} onSelect={() => onWide(!wide)} icon={<WidthIcon size={16} />} checked={wide}>
            {t('publicView.wide')}
          </MenuItem>
          <MenuItem className={item} onSelect={run(onPdf)} icon={<PrinterIcon size={16} />}>
            {t('publicView.pdf')}
          </MenuItem>
          {markdownHref && (
            <a role="menuitem" tabIndex={-1} href={markdownHref} download onClick={() => close()} className={item}>
              <DownloadIcon size={16} />
              {t('publicView.markdown')}
            </a>
          )}
          {withTheme && (
            <MenuItem
              className={item}
              onSelect={cycleTheme}
              icon={theme === 'light' ? <SunIcon size={16} /> : theme === 'dark' ? <MoonIcon size={16} /> : <MonitorIcon size={16} />}
            >
              {t('theme.title', { theme: t(THEME_LABEL[theme]) })}
            </MenuItem>
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  className,
  onSelect,
  icon,
  checked,
  children,
}: {
  className: string
  onSelect: () => void
  icon: ReactNode
  checked?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      tabIndex={-1}
      onClick={onSelect}
      className={className}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {checked && <span aria-hidden="true">✓</span>}
    </button>
  )
}
