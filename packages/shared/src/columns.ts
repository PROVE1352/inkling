// Columns: blocks side by side (docs/adr/2420-*).
//
// Two ProseMirror nodes next to BlockNote's own: `columnList` (a group of 2–4 columns) and `column`
// (one column, holding ordinary blocks). They are bnBlock nodes like BlockNote's `blockContainer`,
// so the names are the ones @blocknote/core 0.51 already treats as columns (its getBlockInfo,
// Tab/Shift+Tab, Backspace/Delete at a column edge, side menu, moveBlocks and copy look for them).
// The web editor, the page-embed viewer and the server schema all build the nodes from this file:
// y-prosemirror deletes nodes a reading schema does not know (ADR 0940), so every reader needs them
// with the same names and attributes.
//
// `width` of a column is a weight (flex-grow); equal columns all have the default 1. A resize writes
// whole percentages turned back into weights (`pctToWeights`), so the Markdown notation
// (`widths` in percent, md/notation.ts) round-trips the stored numbers.
//
// This is MIT code written against the public node structure documented in @blocknote/core
// (MPL-2.0); the GPL/commercial @blocknote/xl-multi-column package is not used or copied.

export const COLUMN_LIST_TYPE = 'columnList' as const
export const COLUMN_TYPE = 'column' as const
export const MIN_COLUMNS = 2
export const MAX_COLUMNS = 4
/** Narrowest column a resize leaves, in percent of the group. */
export const MIN_COLUMN_PCT = 15
/** Below this width (px) of the group the columns stack (web CSS / public page CSS). */
export const COLUMNS_STACK_BELOW_PX = 640

/** Prop schemas (BlockNote block props = node attributes besides `id`). */
export const columnListPropSchema = {} as const
export const columnPropSchema = { width: { default: 1 } } as const

/** A finite positive weight, or 1. */
export function columnWeight(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 && n < 100 ? n : 1
}

/** Weights → whole percentages that add up to 100 (largest remainder). */
export function weightsToPct(weights: number[]): number[] {
  const w = weights.map(columnWeight)
  const total = w.reduce((a, b) => a + b, 0)
  const raw = w.map((x) => (x / total) * 100)
  const out = raw.map(Math.floor)
  let left = 100 - out.reduce((a, b) => a + b, 0)
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++
  return out
}

/** Percentages → stored weights (n columns at pct p weigh p·n/100; equal columns weigh 1). */
export function pctToWeights(pct: number[]): number[] {
  const n = pct.length
  const total = pct.reduce((a, b) => a + b, 0) || 1
  return pct.map((p) => Math.round(((p / total) * n) * 10000) / 10000)
}

/** True when every weight is the same (the notation then leaves `widths` out). */
export function equalWeights(weights: number[]): boolean {
  const pct = weightsToPct(weights)
  return pct.every((p) => Math.abs(p - pct[0]) <= 1)
}

/**
 * Two neighbouring columns after a drag: `leftPct` of their combined share goes to the left one,
 * both kept at MIN_COLUMN_PCT of the group or more. Returns all columns' whole percentages.
 */
export function resizePair(pct: number[], index: number, leftPct: number): number[] {
  const out = [...pct]
  const pair = out[index] + out[index + 1]
  const min = Math.min(MIN_COLUMN_PCT, Math.floor(pair / 2))
  const left = Math.max(min, Math.min(pair - min, Math.round(leftPct)))
  out[index] = left
  out[index + 1] = pair - left
  return out
}

/** The parts of a Tiptap `Node.create` config the column nodes use (no @tiptap import here). */
interface NodeFactory<N> {
  create(config: Record<string, unknown>): N
}

interface DomDoc {
  createElement(tag: string): { setAttribute(name: string, value: string): void; className: string }
}

function domOf(attrs: Record<string, unknown>, className: string, type: string) {
  // the server renders inside server-util's JSDOM, installed as the global `document` for the call
  const doc = (globalThis as unknown as { document: DomDoc }).document
  const dom = doc.createElement('div')
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && k !== 'class') dom.setAttribute(k, String(v))
  dom.className = className
  dom.setAttribute('data-node-type', type)
  return { dom, contentDOM: dom }
}

/**
 * Tiptap node configs for both nodes. `Node` is Tiptap's Node class, taken from a BlockNote node the
 * caller already has (neither the web nor the server package depends on @tiptap/core directly).
 * A group holds `column+`, not `column column+`: when two people remove different columns at once,
 * Yjs can leave one column, and y-prosemirror deletes an element whose content the schema rejects —
 * with every block inside it. One column is valid, shown full width, and can be unwrapped. The web
 * editor never reaches core's fixColumnList (which assumes two or more): it does column edits itself
 * (lib/columns.ts).
 */
export function columnNodes<N>(Node: NodeFactory<N>): { columnList: N; column: N } {
  const columnList = Node.create({
    name: COLUMN_LIST_TYPE,
    group: 'childContainer bnBlock blockGroupChild',
    content: 'column+',
    priority: 40,
    selectable: false,
    isolating: true,
    parseHTML: () => [{ tag: `div[data-node-type="${COLUMN_LIST_TYPE}"]`, priority: 200 }],
    renderHTML: ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) =>
      domOf(HTMLAttributes, 'bn-block-column-list', COLUMN_LIST_TYPE),
  })
  const column = Node.create({
    name: COLUMN_TYPE,
    group: 'bnBlock childContainer',
    content: 'blockContainer+',
    priority: 40,
    selectable: false,
    isolating: true,
    addAttributes: () => ({
      width: {
        default: 1,
        parseHTML: (el: { getAttribute(name: string): string | null }) => columnWeight(el.getAttribute('data-width')),
        renderHTML: (attrs: { width?: unknown }) => {
          const w = columnWeight(attrs.width)
          return { 'data-width': String(w), style: `flex-grow: ${w}` }
        },
      },
    }),
    parseHTML: () => [{ tag: `div[data-node-type="${COLUMN_TYPE}"]`, priority: 200 }],
    renderHTML: ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) =>
      domOf(HTMLAttributes, 'bn-block-column', COLUMN_TYPE),
  })
  return { columnList, column }
}
