import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createExtension } from '@blocknote/core'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { INLINE_MATH_TYPE, MATH_BLOCK_TYPE, inlineMathConfig, mathBlockConfig, scanInlineMath } from '@inkling/shared'
import { deliver, mathKey, mathProblemText, useDebounced, useMathRender, useReservedSize } from '../../lib/katex'
import { mathStats, rememberSize, trackResident } from '../../lib/mathScheduler'
import { MOD, SHIFT, combo } from '../../lib/platform'
import { useT } from '../../i18n'
import type { InklingEditor } from '../CollabEditor'
import { insertFromSlash, type SlashEditor } from '../../lib/slashInsert'

// Math (KaTeX) nodes — docs/adr/0995-* (schema), 0996-* (Markdown), 0997-* (rendering).
// - `math` block: a display equation. Click it to edit the LaTeX in a textarea with a live preview;
//   leaving the textarea (or ⌘/Ctrl+Enter) saves, Esc cancels.
// - `inlineMath`: an atom inside text. Click it to edit in a small popover; Enter saves, Esc cancels,
//   an empty source removes it. Created from the slash menu, ⌘/Ctrl+Shift+E (Notion's key; wraps the
//   selected text), or by typing `$x^2$` — the closing `$` converts, using the same `$…$` rule as
//   Markdown import, so `$5 and $10` stays text.
// - The server knows both nodes (same configs from @inkling/shared), so server reads keep them.

type Editor = InklingEditor

// ---------------------------------------------------------------------------
// "open the editor of the node I just inserted" (local only: a collaborator who receives the
// same empty node must not have focus pulled into it)
// ---------------------------------------------------------------------------

let pendingBlockId: string | null = null
let pendingInlineAt = 0
/** `pendingBlockId` while the slash item's insertion runs: the math block that mounts now is the new one */
const NEXT_BLOCK = '\u0000next'

function takePendingBlock(id: string): boolean {
  if (pendingBlockId !== id && pendingBlockId !== NEXT_BLOCK) return false
  pendingBlockId = null
  return true
}

function takePendingInline(): boolean {
  if (Date.now() - pendingInlineAt > 1500) return false
  pendingInlineAt = 0
  return true
}

/**
 * Clicking an atom node makes ProseMirror select it and focus the editor on mouseup, after our click
 * handler opened the source field. A blur right after opening is that focus steal, not the user
 * leaving: take the focus back instead of closing.
 */
const STEAL_MS = 400
let lastPointerDown = 0
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (lastPointerDown = Date.now()), true)
}
function keepFocus(el: HTMLElement | null, openedAt: number): boolean {
  // a new press after opening is the user moving on, not the steal
  if (!el || Date.now() - openedAt > STEAL_MS || lastPointerDown > openedAt) return false
  setTimeout(() => el.isConnected && el.focus(), 0)
  return true
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * One rendered formula. Memoized: typing elsewhere in the page never re-renders other formulas.
 * Always a single element (the ref target for deferral): until KaTeX's HTML is there it holds the
 * LaTeX source as text (found by find-in-page, read by screen readers) and reserves its size.
 * `eager`: the live preview while editing, rendered synchronously.
 */
const MathOutput = memo(function MathOutput({ latex, display, eager = false }: { latex: string; display: boolean; eager?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  // evicted by the resident cap (lib/mathScheduler.ts): back to the placeholder until it nears the
  // viewport again; the HTML stays cached, so coming back is an insertion only
  const [evicted, setEvicted] = useState(false)
  const computed = useMathRender(latex, display, ref, eager)
  const r = evicted ? 'pending' : computed
  const rendered = typeof r !== 'string'
  const showsHtml = rendered && r.ok
  const reserve = useReservedSize(latex, display, showsHtml, ref)
  const trackable = display && !eager && (showsHtml || evicted)
  useLayoutEffect(() => {
    const el = ref.current
    if (!trackable || !el) return
    return trackResident(
      el,
      () => {
        rememberSize(mathKey(latex, display), el)
        setEvicted(true)
      },
      // re-insertion is paced like first renders (INSERTS_PER_FRAME); print needs it now
      (now) => (now ? setEvicted(false) : deliver(() => setEvicted(false))),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackable])
  useLayoutEffect(() => {
    if (showsHtml && !eager) mathStats.inserts++
  }, [showsHtml, eager, latex])
  const Tag = display ? 'div' : 'span'
  const setRef = ref as never
  if (!rendered) {
    return (
      <Tag ref={setRef} className="nd-math-pending" style={reserve} aria-label={latex}>
        {latex}
      </Tag>
    )
  }
  if (!r.ok) {
    const msg = mathProblemText(r)
    return display ? (
      <div ref={setRef} className="nd-math-error" role="alert">
        <code>{latex}</code>
        <small>{msg}</small>
      </div>
    ) : (
      <span ref={setRef} className="nd-math-error" title={msg}>
        <code>{latex}</code>
      </span>
    )
  }
  // KaTeX output for this source (trust: false, refused commands never reach it — lib/mathRender.ts)
  if (!display || !r.warning) {
    return (
      <Tag
        ref={setRef}
        className={display ? 'nd-math-display' : 'nd-math-inline-out'}
        title={display ? undefined : r.warning}
        dangerouslySetInnerHTML={{ __html: r.html }}
      />
    )
  }
  return (
    <div ref={setRef} className="nd-math-error-wrap">
      <div className="nd-math-display" dangerouslySetInnerHTML={{ __html: r.html }} />
      <small className="nd-math-problem">{r.warning}</small>
    </div>
  )
})

/** Parse message under the editing preview (the preview itself shows the source in that case). */
function PreviewProblem({ latex, display }: { latex: string; display: boolean }) {
  const ref = useRef<HTMLElement>(null)
  const r = useMathRender(latex, display, ref, true)
  if (typeof r === 'string') return null
  if (r.ok) return !display && r.warning ? <small className="nd-math-problem">{r.warning}</small> : null
  return <small className="nd-math-problem">{mathProblemText(r)}</small>
}

/** The live preview under a LaTeX field: follows the draft after 150 ms without typing. */
function Preview({ draft, display }: { draft: string; display: boolean }) {
  const t = useT()
  const shown = useDebounced(draft, 150)
  return (
    <div className="nd-math-preview" aria-live="polite">
      {shown.trim() ? <MathOutput latex={shown} display={display} eager /> : <span className="nd-math-empty">{t('math.emptyPreview')}</span>}
      <PreviewProblem latex={shown} display={display} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// block
// ---------------------------------------------------------------------------

function MathBlockView({ block, editor }: { block: { id: string; props: { latex: string } }; editor: Editor }) {
  const t = useT()
  const latex = block.props.latex
  const editable = editor.isEditable
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(latex)
  const area = useRef<HTMLTextAreaElement>(null)
  // set when Esc / ⌘Enter closed the editor, so the blur of the unmounting textarea does nothing
  const closed = useRef(false)
  const openedAt = useRef(0)

  // Just inserted from the slash menu: open and focus the field in the commit that mounts the view. A
  // layout effect, because a state update from a passive effect (and the old requestAnimationFrame)
  // ran after the next key event, so keys typed right after Enter went into the paragraph above.
  const focusOnOpen = useRef(false)
  useLayoutEffect(() => {
    if (editable && takePendingBlock(block.id)) {
      focusOnOpen.current = true
      open()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useLayoutEffect(() => {
    if (!editing || !focusOnOpen.current) return
    focusOnOpen.current = false
    area.current?.focus()
  }, [editing])
  useEffect(() => {
    if (!editing) setDraft(latex) // follow remote edits while closed
  }, [latex, editing])
  useEffect(() => {
    if (editing && !editable) setEditing(false) // the page got locked meanwhile
  }, [editing, editable])

  function open() {
    closed.current = false
    openedAt.current = Date.now()
    setDraft(latex)
    setEditing(true)
    if (focusOnOpen.current) return
    requestAnimationFrame(() => {
      const a = area.current
      if (a) {
        a.focus()
        a.setSelectionRange(a.value.length, a.value.length)
      }
    })
  }
  function close(save: boolean) {
    if (closed.current) return
    closed.current = true
    setEditing(false)
    if (save && draft !== latex && editor.getBlock(block.id)) {
      editor.updateBlock(block.id, { type: MATH_BLOCK_TYPE, props: { latex: draft } } as never)
    }
  }

  if (editing) {
    const rows = Math.min(12, Math.max(2, draft.split('\n').length))
    return (
      <div className="nd-math-block nd-math-editing" contentEditable={false}>
        <textarea
          ref={area}
          value={draft}
          rows={rows}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={t('math.edit')}
          placeholder={t('math.placeholder')}
          className="nd-math-input"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => keepFocus(area.current, openedAt.current) || close(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              close(false)
              editor.focus()
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              close(true)
              editor.focus()
            }
          }}
        />
        <Preview draft={draft} display />
        <div className="nd-math-hint">{t('math.hintBlock', { mod: combo(MOD, 'Enter') })}</div>
      </div>
    )
  }

  return (
    <div
      className={`nd-math-block${editable ? ' nd-math-clickable' : ''}`}
      contentEditable={false}
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={editable ? t('math.edit') : undefined}
      // mouseup, not click: ProseMirror's node selection on mousedown re-renders the node view, and
      // the browser then never fires `click` on it
      onMouseUp={(e) => e.button === 0 && editable && open()}
      onKeyDown={(e) => {
        if (editable && e.key === 'Enter') {
          e.preventDefault()
          open()
        }
      }}
    >
      {latex.trim() ? <MathOutput latex={latex} display /> : <span className="nd-math-empty">{editable ? t('math.emptyBlock') : ''}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------

type TiptapLike = {
  view: {
    posAtDOM(node: Node, offset: number): number
    state: { doc: { nodeAt(pos: number): { type: { name: string }; nodeSize: number } | null }; tr: { delete(a: number, b: number): unknown } }
    dispatch(tr: unknown): void
  }
  commands: { setTextSelection(pos: number): boolean; focus(): boolean }
}
const tiptapOf = (editor: Editor) => (editor as unknown as { _tiptapEditor?: TiptapLike })._tiptapEditor

/** Document position of the inline math node rendered at `el` (null if it is gone). */
function inlinePos(editor: Editor, el: HTMLElement): number | null {
  const tt = tiptapOf(editor)
  if (!tt) return null
  try {
    const pos = tt.view.posAtDOM(el, 0)
    for (const p of [pos, pos - 1]) {
      if (p >= 0 && tt.view.state.doc.nodeAt(p)?.type.name === INLINE_MATH_TYPE) return p
    }
  } catch {
    // the node view was destroyed meanwhile
  }
  return null
}

function InlineMathView({
  latex,
  editor,
  update,
}: {
  latex: string
  editor: Editor
  update: (latex: string) => void
}) {
  const t = useT()
  const editable = editor.isEditable
  const anchor = useRef<HTMLSpanElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(latex)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const closed = useRef(false)
  const openedAt = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  // layout effect: the popover and its autofocused field must exist before the next key event
  // (a state update from a passive effect is scheduled after it, and the keys went into the paragraph)
  useLayoutEffect(() => {
    if (editable && !latex && takePendingInline()) {
      closed.current = false
      openedAt.current = Date.now()
      setDraft('')
      setEditing(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (editing && !editable) setEditing(false)
  }, [editing, editable])

  // keep the popover under the chip while the page scrolls or resizes
  useLayoutEffect(() => {
    if (!editing) return
    const place = () => anchor.current && setRect(anchor.current.getBoundingClientRect())
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [editing])

  function finish(save: boolean) {
    if (closed.current) return
    closed.current = true
    setEditing(false)
    const el = anchor.current
    const pos = el ? inlinePos(editor, el) : null
    const tt = tiptapOf(editor)
    const next = save ? draft.trim() : latex
    if (pos !== null && tt && !next) {
      // an equation left empty is removed, like an empty link
      tt.view.dispatch(tt.view.state.tr.delete(pos, pos + 1))
      tt.commands.setTextSelection(pos)
      tt.commands.focus()
      return
    }
    if (save && next !== latex) update(next)
    if (pos !== null && tt) {
      tt.commands.setTextSelection(pos + 1)
      tt.commands.focus()
    }
  }

  const popover =
    editing && rect
      ? createPortal(
          <div
            className="nd-pop nd-math-popover"
            style={{
              top: Math.min(rect.bottom + 6, window.innerHeight - 140),
              left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(448, window.innerWidth - 16) - 8)),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={input}
              autoFocus
              value={draft}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={t('math.edit')}
              placeholder={t('math.placeholder')}
              className="nd-math-input"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => keepFocus(input.current, openedAt.current) || finish(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  finish(true)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  finish(false)
                }
              }}
            />
            <Preview draft={draft} display={false} />
            <div className="nd-math-hint">{t('math.hintInline')}</div>
          </div>,
          document.body,
        )
      : null

  return (
    <span
      ref={anchor}
      className={`nd-math-inline${editable ? ' nd-math-clickable' : ''}${editing ? ' nd-math-active' : ''}`}
      contentEditable={false}
      title={editable ? t('math.edit') : undefined}
      onMouseUp={(e) => {
        if (e.button !== 0 || !editable || editing) return
        closed.current = false
        openedAt.current = Date.now()
        setDraft(latex)
        setEditing(true)
      }}
    >
      {latex ? <MathOutput latex={latex} display={false} /> : <span className="nd-math-empty">{t('math.emptyInline')}</span>}
      {popover}
    </span>
  )
}

// ---------------------------------------------------------------------------
// typing `$…$` and ⌘/Ctrl+Shift+E
// ---------------------------------------------------------------------------

type PMState = {
  selection: {
    empty: boolean
    from: number
    to: number
    $from: {
      pos: number
      parentOffset: number
      start(): number
      parent: { type: { spec: { code?: boolean } }; textBetween(a: number, b: number, sep?: string, leaf?: string): string }
      marks(): { type: { name: string } }[]
    }
  }
  doc: { textBetween(a: number, b: number, sep?: string, leaf?: string): string; rangeHasMark(a: number, b: number, t: unknown): boolean }
  schema: { nodes: Record<string, { create(attrs: object): unknown } | undefined>; marks: Record<string, unknown> }
  tr: { replaceWith(a: number, b: number, node: unknown): unknown }
}
const OBJ = '￼'

function pmOf(editor: Editor): { state: PMState; dispatch(tr: unknown): void } | null {
  const tt = (editor as unknown as { _tiptapEditor?: { state: PMState; view: { dispatch(tr: unknown): void } } })._tiptapEditor
  return tt ? { state: tt.state, dispatch: (tr) => tt.view.dispatch(tr) } : null
}

function inCode(state: PMState, from: number, to: number): boolean {
  const $from = state.selection.$from
  if ($from.parent.type.spec.code) return true
  const code = state.schema.marks.code
  if (!code) return false
  return from === to ? $from.marks().some((m) => m.type.name === 'code') : state.doc.rangeHasMark(from, to, code)
}

/** The closing `$` of `$latex$` was typed: replace the span with an inline math node. */
function convertTypedDollar(editor: Editor): boolean {
  const pm = pmOf(editor)
  if (!pm) return false
  const { state } = pm
  const sel = state.selection
  const node = state.schema.nodes[INLINE_MATH_TYPE]
  if (!sel.empty || !node) return false
  const $from = sel.$from
  if ($from.parent.type.spec.code) return false
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 2000), $from.parentOffset, undefined, OBJ)
  const offset = $from.parentOffset - before.length
  const text = `${before}$`
  const spans = scanInlineMath(text)
  const last = spans[spans.length - 1]
  if (!last || last.end !== text.length || text[last.start + 1] === '$') return false
  // other inline nodes inside, or something that reads like money (`$5-$`)
  if (last.latex.includes(OBJ) || /^[\d\s.,+\-–~%]*$/.test(last.latex)) return false
  const from = $from.start() + offset + last.start
  if (inCode(state, from, $from.pos)) return false
  pm.dispatch(state.tr.replaceWith(from, $from.pos, node.create({ latex: last.latex })))
  return true
}

/** ⌘/Ctrl+Shift+E: the selected text becomes an inline equation, or an empty one opens for typing. */
function insertInlineMath(editor: Editor): boolean {
  const pm = pmOf(editor)
  if (!pm || !editor.isEditable) return false
  const { state } = pm
  const { from, to, empty } = state.selection
  const node = state.schema.nodes[INLINE_MATH_TYPE]
  if (!node || state.selection.$from.parent.type.spec.code) return false
  const selected = empty ? '' : state.doc.textBetween(from, to, ' ', OBJ)
  if (selected.includes(OBJ) || selected.includes('\n') || inCode(state, from, to)) return false
  if (!selected.trim()) pendingInlineAt = Date.now()
  pm.dispatch(state.tr.replaceWith(from, to, node.create({ latex: selected.trim() })))
  return true
}

const mathKeys = createExtension({
  key: 'inklingMath',
  keyboardShortcuts: {
    $: ({ editor }) => convertTypedDollar(editor as Editor),
    'Mod-Shift-e': ({ editor }) => insertInlineMath(editor as Editor),
  },
})

// ---------------------------------------------------------------------------
// specs
// ---------------------------------------------------------------------------

export const mathBlockSpec = createReactBlockSpec(
  mathBlockConfig,
  {
    render: ({ block, editor }) => <MathBlockView block={block} editor={editor as Editor} />,
    // HTML/clipboard outside the editor: the Markdown notation as text
    toExternalHTML: ({ block }) => <p>{`$$${block.props.latex}$$`}</p>,
  },
  [mathKeys],
)()

export const inlineMathSpec = createReactInlineContentSpec(inlineMathConfig, {
  render: ({ inlineContent, updateInlineContent, editor }) => (
    <InlineMathView
      latex={String(inlineContent.props.latex)}
      editor={editor as unknown as Editor}
      update={(latex) => updateInlineContent({ type: INLINE_MATH_TYPE, props: { latex } })}
    />
  ),
  toExternalHTML: ({ inlineContent }) => <span>{`$${String(inlineContent.props.latex)}$`}</span>,
})

/** Slash menu: "Math block" and "Inline math". */
export function mathSlashItems(editor: Editor, t: ReturnType<typeof useT>): DefaultReactSuggestionItem[] {
  if (!(MATH_BLOCK_TYPE in editor.schema.blockSchema)) return []
  const group = editor.dictionary.slash_menu.table.group
  return [
    {
      title: t('slash.mathTitle'),
      subtext: t('slash.mathSubtext'),
      // Aliases are search data, not display text: English and Korean are kept in every locale.
      aliases: ['math', 'equation', 'formula', 'latex', 'katex', 'tex', '수식', '방정식', '공식', '블록수식'],
      group,
      icon: <span style={{ fontSize: 15, lineHeight: 1, fontFamily: 'serif' }}>∑</span>,
      // The new block opens its source field (MathBlockView) when it mounts. That is normally in the
      // microtask after this call; should it ever mount during the insertion, before the id is known
      // here, the marker is "the next math block" for exactly the duration of this call.
      onItemClick: () => {
        pendingBlockId = NEXT_BLOCK
        const inserted = insertFromSlash(editor as unknown as SlashEditor, { type: MATH_BLOCK_TYPE, props: { latex: '' } }, 'own')
        pendingBlockId = pendingBlockId === NEXT_BLOCK ? (inserted?.id ?? null) : null
      },
    },
    {
      title: t('slash.inlineMathTitle'),
      subtext: t('slash.inlineMathSubtext', { shortcut: combo(MOD, SHIFT, 'E') }),
      aliases: ['inline math', 'inlinemath', 'equation', 'latex', 'katex', '$', '인라인수식', '인라인 수식', '수식'],
      group,
      icon: <span style={{ fontSize: 13, lineHeight: 1, fontFamily: 'serif', fontStyle: 'italic' }}>x²</span>,
      onItemClick: () => {
        pendingInlineAt = Date.now()
        editor.insertInlineContent([{ type: INLINE_MATH_TYPE, props: { latex: '' } } as never])
      },
    },
  ]
}
