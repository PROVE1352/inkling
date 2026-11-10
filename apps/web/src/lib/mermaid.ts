// Mermaid diagrams for ```mermaid code blocks (docs/adr/2104-*, 2105-*).
//
// Loading: `import('mermaid')` on the first diagram only, so pages without one never fetch it; the
// chunks are emitted under assets/lazy/ (vite.config.ts LAZY_ONLY) and not precached by the service
// worker. Mermaid's diagram types are its own further lazy chunks.
//
// Safety (the source is member text, so untrusted):
//   securityLevel 'strict'  labels pass Mermaid's DOMPurify, `click` callbacks and links are off
//   htmlLabels false        labels are SVG text, not HTML in foreignObject
//   secure keys             a `%%{init: …}%%` directive in the source cannot change these, nor
//                           dompurifyConfig, themeCSS or the size limits
//   output                  cleaned again (lib/mermaidSvg.ts) and shown as an <img> data: URL — an
//                           SVG image runs no script and loads nothing
// Fonts: an SVG image cannot use the page's web fonts, so Mermaid measures and the image draws with
// the same system font stack; a label never overflows its box because of a font swap.
//
// Mermaid's configuration is global: renders run one at a time (a queue), each initializing with its
// theme. Results are cached per (theme, source) in a small LRU.

import { RenderCache } from './mathScheduler'
import { cleanMermaidSvg, svgDataUrl } from './mermaidSvg'

export type MermaidTheme = 'light' | 'dark'

export type MermaidResult =
  | { ok: true; src: string; width: number; height: number }
  | { ok: false; message: string }

/** Longest source rendered (Mermaid's own default maxTextSize). */
export const MERMAID_MAX_CHARS = 50_000
const MAX_EDGES = 500
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", Roboto, Helvetica, Arial, sans-serif'

/** Keys a diagram's own `%%{init}%%` directive may not change (Mermaid's list plus ours). */
export const MERMAID_SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
  'htmlLabels',
  'dompurifyConfig',
  'themeCSS',
  'fontFamily',
  'altFontFamily',
  'arrowMarkerAbsolute',
  'deterministicIds',
  'deterministicIDSeed',
  'legacyMathML',
  'forceLegacyMathML',
] as const

export function mermaidConfig(theme: MermaidTheme) {
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MERMAID_MAX_CHARS,
    maxEdges: MAX_EDGES,
    theme: theme === 'dark' ? ('dark' as const) : ('default' as const),
    darkMode: theme === 'dark',
    fontFamily: FONT_STACK,
    themeVariables: { fontFamily: FONT_STACK },
    secure: [...MERMAID_SECURE_KEYS],
    deterministicIds: true,
    logLevel: 5 as const,
  }
}

type MermaidApi = typeof import('mermaid').default
let loader: Promise<MermaidApi> | null = null

export function loadMermaid(): Promise<MermaidApi> {
  loader ??= import('mermaid').then((m) => m.default).catch((e) => {
    loader = null // a failed chunk load (offline) can be retried on the next render
    throw e
  })
  return loader
}

/** Short, single-paragraph error text for the block (Mermaid's parser messages run many lines). */
export function shortError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : String((e as { message?: unknown })?.message ?? e)
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^-+\^$/.test(l))
  const text = lines.slice(0, 2).join(' — ')
  return text.length > 240 ? `${text.slice(0, 237)}…` : text || 'Syntax error'
}

const cache = new RenderCache<{ size: number; result: MermaidResult }>(200, 8_000_000)
let queue: Promise<unknown> = Promise.resolve()
let seq = 0
let pending = 0
const idle = new Set<() => void>()

/** Resolves when no diagram is waiting or rendering (PDF export waits for it, docs/adr/2106-*). */
export function mermaidIdle(): Promise<void> {
  return pending === 0 ? Promise.resolve() : new Promise((r) => idle.add(r))
}

export function cachedMermaid(source: string, theme: MermaidTheme): MermaidResult | undefined {
  return cache.get(`${theme}\u0000${source}`)?.result
}

export function renderMermaid(source: string, theme: MermaidTheme): Promise<MermaidResult> {
  const key = `${theme}\u0000${source}`
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit.result)
  if (source.length > MERMAID_MAX_CHARS) return Promise.resolve({ ok: false, message: `Diagram longer than ${MERMAID_MAX_CHARS} characters` })
  pending++
  const run = queue.then(async (): Promise<MermaidResult> => {
    const id = `nd-mermaid-${++seq}`
    try {
      const mermaid = await loadMermaid()
      mermaid.initialize(mermaidConfig(theme))
      await mermaid.parse(source)
      const { svg } = await mermaid.render(id, source)
      const clean = cleanMermaidSvg(svg)
      if (!clean) return { ok: false, message: 'Mermaid returned no drawable diagram' }
      return { ok: true, src: svgDataUrl(clean.svg), width: clean.width, height: clean.height }
    } catch (e) {
      return { ok: false, message: shortError(e) }
    } finally {
      // Mermaid measures in a temporary node under <body>; an error can leave it behind
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
      document.getElementById(`i${id}`)?.remove()
    }
  })
  queue = run.catch(() => undefined)
  return run.then((result) => {
    cache.set(key, { size: source.length + (result.ok ? result.src.length : result.message.length), result })
    return result
  }).finally(() => {
    if (--pending === 0) {
      for (const r of idle) r()
      idle.clear()
    }
  })
}
