// Math rendering engine for the editor and the public page (docs/adr/0997-*, 0998-*).
// - KaTeX, its CSS and fonts are fetched the first time a page shows math (lazy chunks under
//   assets/lazy/, vite.config.ts LAZY_ONLY), from the same origin: CSP 'self' holds.
// - A formula is looked up in a memory LRU (per tab; a persistent IndexedDB cache was measured and
//   rejected: no gain on a second visit, docs/adr/0998-*), and otherwise
//   rendered on the main thread in time-sliced batches (./mathScheduler.ts), and the HTML is
//   handed to React at most INSERTS_PER_FRAME per frame. (A Web Worker was measured and rejected:
//   KaTeX itself takes < 6 ms even for 4,000-character formulas; inserting the HTML is the cost.)
// - Until then the placeholder shows the LaTeX source as text, with the expected size reserved.
// - Off-screen formulas are deferred only on pages with very many of them (LAZY_THRESHOLD).
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'
import { renderLatex, type MathRender } from './mathRender'
import {
  RenderCache,
  isPrinting,
  mathMode,
  mathOutput,
  onPrint,
  placeholderStyle,
  rememberSize,
  requestMathRender,
  scheduleRender,
  whenDeferring,
} from './mathScheduler'
import { t } from '../i18n'

type Katex = typeof import('katex')['default']

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

let cssLoading: Promise<unknown> | null = null
/** KaTeX's stylesheet and fonts (needed wherever rendered HTML is shown). */
export function loadKatexCss(): Promise<unknown> {
  cssLoading ??= import('katex/dist/katex.min.css').catch((e) => {
    cssLoading = null
    throw e
  })
  return cssLoading
}

let loading: Promise<Katex> | null = null
let loaded: Katex | null = null
/** KaTeX on the main thread. */
export function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import('katex'), loadKatexCss()])
    .then(([m]) => (loaded = m.default))
    .catch((e) => {
      loading = null // allow a retry (offline, deploy swapped the chunk)
      throw e
    })
  return loading
}

/** Main-thread KaTeX once loaded (starts loading); null meanwhile, 'error' if it failed. */
export function useKatex(enabled = true): Katex | null | 'error' {
  const [k, setK] = useState<Katex | null | 'error'>(loaded)
  useEffect(() => {
    if (k || !enabled) return
    let live = true
    loadKatex().then(
      (m) => live && setK(m),
      () => live && setK('error'),
    )
    return () => {
      live = false
    }
  }, [k, enabled])
  return k
}

// ---------------------------------------------------------------------------
// caches
// ---------------------------------------------------------------------------

const memory = new RenderCache<{ r: MathRender; size: number }>()
export const mathKey = (latex: string, display: boolean) => `${display ? 'D' : 'I'}${latex}`

function remember(key: string, r: MathRender): void {
  memory.set(key, { r, size: (r.ok ? r.html.length : 0) + key.length + 32 })
}

/** Synchronous render through the memory cache (preview while editing, print). */
export function renderNow(k: Katex, latex: string, display: boolean): MathRender {
  const key = mathKey(latex, display)
  const hit = memory.get(key)
  if (hit) return hit.r
  const r = renderLatex(k, latex, display, mathOutput)
  remember(key, r)
  return r
}

// ---------------------------------------------------------------------------
// pacing
// ---------------------------------------------------------------------------

// Inserting KaTeX HTML (React commit + layout) costs more main-thread time than rendering it, so
// finished formulas are handed to React at most INSERTS_PER_FRAME per animation frame, in the order
// they finished (document order, so the viewport first).
export const INSERTS_PER_FRAME = 16
let toDeliver: (() => void)[] = []
let deliverFrame = 0
export function deliver(fn: () => void): void {
  toDeliver.push(fn)
  deliverFrame ||= requestAnimationFrame(flushDeliveries)
}
function flushDeliveries(): void {
  deliverFrame = 0
  const now = toDeliver.slice(0, INSERTS_PER_FRAME)
  toDeliver = toDeliver.slice(INSERTS_PER_FRAME)
  now.forEach((fn) => fn())
  if (toDeliver.length) deliverFrame = requestAnimationFrame(flushDeliveries)
}

/**
 * Render state for `latex`, asynchronously: memory cache, else the main thread (sliced).
 * Calls `done` once, unless cancelled through the returned function.
 */
function renderLater(latex: string, display: boolean, done: (r: MathRender) => void): () => void {
  let cancelled = false
  const cancels: (() => void)[] = []
  const key = mathKey(latex, display)
  const finish = (r: MathRender) => {
    remember(key, r)
    deliver(() => !cancelled && done(r))
  }
  const onMain = () =>
    cancels.push(
      scheduleRender(() => {
        if (cancelled || !loaded) return
        finish(renderLatex(loaded, latex, display, mathOutput))
      }),
    )
  void (async () => {
    const hit = memory.get(key)
    if (hit) return deliver(() => !cancelled && done(hit.r))
    try {
      await loadKatex()
    } catch {
      return // KaTeX unavailable: the source text stays
    }
    if (!cancelled) onMain()
  })()
  return () => {
    cancelled = true
    cancels.forEach((c) => c())
  }
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

export type MathState = MathRender | 'pending' | 'unavailable'

/**
 * Render state of one formula shown in `ref`. `eager` (the live preview while editing) renders
 * synchronously on the main thread. Others come from the memory cache at once, or are requested
 * — immediately, or near the viewport on math-heavy pages — and show their source until then.
 */
export function useMathRender(latex: string, display: boolean, ref: RefObject<Element | null>, eager = false): MathState {
  const sync = eager || mathMode === 'a'
  const k = useKatex(sync)
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const key = mathKey(latex, display)
  const hit = sync ? undefined : memory.get(key)

  useEffect(() => {
    void loadKatexCss().catch(() => {})
  }, [])
  useEffect(() => {
    if (sync || hit || !ref.current) return
    let cancel = () => {}
    const unregister = requestMathRender(ref.current, () => {
      cancel = renderLater(latex, display, () => rerender())
    })
    return () => {
      unregister()
      cancel()
    }
  }, [sync, hit, latex, display, ref])
  // print / PDF export: render now (renderAllMathNow wraps the listeners in flushSync)
  useEffect(() => (sync || hit ? undefined : onPrint(rerender)), [sync, hit])

  if (mathMode === 'a') {
    if (k === 'error') return 'unavailable'
    return k ? renderLatex(k, latex, display, mathOutput) : 'pending' // measurement baseline: uncached
  }
  if (eager) {
    if (k === 'error') return 'unavailable'
    return k ? renderNow(k, latex, display) : 'pending'
  }
  if (hit) return hit.r
  if (isPrinting() && loaded) return renderNow(loaded, latex, display)
  return 'pending'
}

/** Placeholder size for `latex` and, after it rendered, remembering the real size. */
export function useReservedSize(latex: string, display: boolean, rendered: boolean, ref: RefObject<Element | null>) {
  const key = mathKey(latex, display)
  useLayoutEffect(() => {
    if (rendered && ref.current) rememberSize(key, ref.current)
  }, [rendered, key, ref])
  return rendered ? undefined : placeholderStyle(key, latex, display)
}

/** A value that follows `value` after `ms` of quiet (the live preview while typing LaTeX). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

/** The user-facing text for a refused or broken source. */
export function mathProblemText(r: Exclude<MathRender, { ok: true }>): string {
  if (r.reason === 'blocked') return t('math.blocked', { command: r.command })
  if (r.reason === 'tooLong') return t('math.tooLong', { max: r.max })
  return r.message
}

/** Loads main-thread KaTeX in idle time, so `beforeprint` can render deferred formulas. */
export function preloadForPrint(): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
  ;(idle ?? ((cb: () => void) => setTimeout(cb, 2000)))(() => void loadKatex().catch(() => {}))
}
whenDeferring.push(preloadForPrint)

// ---------------------------------------------------------------------------
// public share page
// ---------------------------------------------------------------------------

/**
 * Public share page (docs/adr/0997-*): the server HTML carries each formula's source in `data-latex`
 * (and as fallback text). After the allowlist sanitizer ran, render KaTeX into those elements. The
 * KaTeX markup is produced here, from the attribute's text, so it never goes through the
 * sanitizer (which would strip MathML and KaTeX's inline styles). Same caches, pacing and
 * deferral as the editor; returns a cleanup for when the HTML is replaced.
 */
export function renderMathIn(root: HTMLElement): () => void {
  const nodes = [
    ...root.querySelectorAll<HTMLElement>(
      '[data-content-type="math"][data-latex], [data-inline-content-type="inlineMath"][data-latex]',
    ),
  ]
  if (!nodes.length) return () => {}
  void loadKatexCss().catch(() => {})
  preloadForPrint()
  const cleanups: (() => void)[] = []
  const pending = new Map<HTMLElement, () => void>()

  const paint = (el: HTMLElement, r: MathRender) => {
    pending.delete(el)
    const display = el.getAttribute('data-content-type') === 'math'
    const latex = el.getAttribute('data-latex') ?? ''
    const target = display ? (el.querySelector<HTMLElement>('.nd-math-source') ?? el) : el
    target.removeAttribute('style')
    if (r.ok) {
      target.innerHTML = r.html // KaTeX output from the source text, trust: false
      target.classList.remove('nd-math-source', 'nd-math-inline-source')
      target.classList.add(display ? 'nd-math-rendered' : 'nd-math-inline-rendered')
      rememberSize(mathKey(latex, display), target)
    } else {
      target.textContent = latex
      target.classList.add('nd-math-failed')
      target.title = mathProblemText(r)
    }
  }

  cleanups.push(
    onPrint(() => {
      if (!loaded) return
      for (const [el, cancel] of [...pending]) {
        cancel()
        const display = el.getAttribute('data-content-type') === 'math'
        paint(el, renderNow(loaded, el.getAttribute('data-latex') ?? '', display))
      }
    }),
  )
  for (const el of nodes) {
    const display = el.getAttribute('data-content-type') === 'math'
    const latex = el.getAttribute('data-latex') ?? ''
    const target = display ? (el.querySelector<HTMLElement>('.nd-math-source') ?? el) : el
    // placeholder: the source stays as text (find in page, screen readers), expected size reserved
    Object.assign(target.style, placeholderStyle(mathKey(latex, display), latex, display))
    let cancel = () => {}
    pending.set(el, () => cancel())
    const unregister = requestMathRender(el, () => {
      cancel = renderLater(latex, display, (r) => paint(el, r))
    })
    cleanups.push(() => {
      unregister()
      cancel()
    })
  }
  return () => cleanups.forEach((c) => c())
}
