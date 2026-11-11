// PDF preview under a file block (docs/adr/2480-*, 2481-*). The block stays BlockNote's file block — same
// config, parse, HTML export and stored props; the document schema does not change. The node view only
// gets one non-editable host after the file name when the file is a PDF uploaded to this server, and
// <PdfPortals> (inside BlockNoteView, like MermaidPortals) renders the preview into it. The preview
// itself (PdfPreview.tsx) and pdf.js (pdfDocument.ts) are lazy chunks, fetched only when a PDF block
// comes near the screen.
import { Component, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { defaultBlockSpecs, type BlockNoteEditor } from '@blocknote/core'
import { usePageInkPresence } from '../../api'
import { fileIdOf, isUndoKey, pdfByName, previewsAllowed } from '../../lib/pdfFile'
import { t, useT } from '../../i18n'
import type { PdfPreviewProps } from './PdfPreview'

export type PdfHost = {
  el: HTMLElement
  blockId: string
  url: string
  fileId: string
  name: string
  /** 'pdf' by the file name; 'unknown' = no extension, the preview asks the server's mime first */
  byName: 'pdf' | 'unknown'
  editor: BlockNoteEditor<any, any, any>
}

const hostsByEditor = new WeakMap<object, PdfHost[]>()
const listenersByEditor = new WeakMap<object, Set<() => void>>()
const EMPTY: PdfHost[] = []

function notify(editor: object) {
  listenersByEditor.get(editor)?.forEach((l) => l())
}

const baseFile = defaultBlockSpecs.file.implementation

/** Events ProseMirror must leave to the preview (it lives inside the editable body). */
const OWN_EVENTS = new Set([
  'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
  'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend',
  'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend',
  'copy', 'cut', 'paste', 'focus', 'blur', 'focusin', 'focusout', 'wheel', 'selectstart', 'dragstart',
])

/**
 * A drag that starts with a press inside a preview never moves anything: when the file block is selected
 * ProseMirror makes the block draggable, and the dragstart of a press on the PDF can then target the block
 * rather than the host. One capture listener for the tab looks at where the press began.
 */
let pressInPreview = false
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    pressInPreview = e.target instanceof Element && !!e.target.closest('[data-pdf-host]')
  }, true)
  document.addEventListener('dragstart', (e) => {
    const t = e.target instanceof Node ? e.target : null
    const inside = t && (t instanceof Element ? t : t.parentElement)?.closest('[data-pdf-host]')
    if (pressInPreview || inside) {
      e.preventDefault()
      e.stopPropagation()
    }
  }, true)
}

type RenderFn = (typeof baseFile)['render']
const baseRender: RenderFn = baseFile.render

/**
 * BlockNote's file block with the preview host: the default spec with only `render` wrapped (config,
 * parse and HTML export are the same objects). Only the live editor's node view gets the host
 * (`renderType` 'nodeView'): copies of the block (presentation slides, the clipboard's HTML, exports)
 * render as before.
 */
export const pdfFileSpec = {
  ...defaultBlockSpecs.file,
  implementation: {
    ...baseFile,
    render(this: ThisParameterType<RenderFn>, block: Parameters<RenderFn>[0], editor: Parameters<RenderFn>[1]) {
      const view = baseRender.call(this, block, editor)
      const isNodeView = (this as { renderType?: string } | undefined)?.renderType === 'nodeView'
      if (!isNodeView || typeof window === 'undefined') return view
      const url = String(block.props.url ?? '')
      const name = String(block.props.name ?? '')
      const fileId = fileIdOf(url, window.location.origin)
      const byName = pdfByName(name)
      if (!fileId || byName === 'other') return view
      const dom = view.dom as HTMLElement
      const wrapper = dom.querySelector<HTMLElement>('.bn-file-block-content-wrapper') ?? dom
      const host = document.createElement('div')
      host.className = 'nd-pdf-host'
      host.contentEditable = 'false'
      host.setAttribute('data-pdf-host', '')
      // the editor's own key commands (undo, indent, fold, …) leave keys typed in the preview alone, and the
      // browser's undo does not reach back into the body from here
      host.setAttribute('data-own-keys', '')
      host.addEventListener('keydown', (e) => {
        if (isUndoKey(e)) e.preventDefault()
      })
      // under the file name line, above a caption
      const nameLine = wrapper.querySelector(':scope > .bn-file-name-with-icon')
      if (nameLine) nameLine.after(host)
      else wrapper.appendChild(host)
      const key = editor as object
      const entry: PdfHost = { el: host, blockId: block.id, url, fileId, name, byName: byName === 'pdf' ? 'pdf' : 'unknown', editor: editor as BlockNoteEditor<any, any, any> }
      hostsByEditor.set(key, [...(hostsByEditor.get(key) ?? []), entry])
      notify(key)
      const destroy = (view as { destroy?: () => void }).destroy
      return {
        ...view,
        // React renders into the host, pdf.js draws canvases and text there, and selecting the PDF's
        // text is the reader's own selection: none of it is an edit or a document selection. Outside the
        // host the answer is ProseMirror's default for a node view without contentDOM (prosemirror-view
        // 1.42.4 ViewDesc.ignoreMutation: everything but a selection change)
        ignoreMutation: (m: { target: Node; type: string }) => host.contains(m.target) || m.type !== 'selection',
        stopEvent: (e: Event) => e.target instanceof Node && host.contains(e.target) && OWN_EVENTS.has(e.type),
        destroy: () => {
          hostsByEditor.set(key, (hostsByEditor.get(key) ?? []).filter((h) => h !== entry))
          notify(key)
          destroy?.()
        },
      }
    },
  },
} as typeof defaultBlockSpecs.file

/**
 * Renders the PDF previews of `editor`'s file blocks into their hosts — on pages whose body may hold them
 * (lib/pdfFile.ts previewsAllowed, docs/adr/2481-*): never in pen mode or on a page with ink strokes, whose
 * strokes are placed by the body's height. Otherwise every host stays empty (and hidden by CSS), so the
 * block is exactly as tall as before 0.21 and nothing is fetched.
 */
export function PdfPortals({ editor, readOnly, pageId, penMode }: { editor: BlockNoteEditor<any, any, any>; readOnly: boolean; pageId: string; penMode: boolean }) {
  const key = editor as object
  const subscribe = useCallback(
    (cb: () => void) => {
      const set = listenersByEditor.get(key) ?? new Set()
      set.add(cb)
      listenersByEditor.set(key, set)
      return () => {
        set.delete(cb)
      }
    },
    [key],
  )
  const getSnapshot = useCallback(() => hostsByEditor.get(key) ?? EMPTY, [key])
  const hosts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const ink = usePageInkPresence(pageId, hosts.length > 0 && !penMode)
  const allowed = previewsAllowed({ penMode, savingInk: ink.saving, ink: ink.state })
  if (!allowed) return null
  return (
    <>
      {hosts.map((h) =>
        createPortal(
          <PreviewBoundary host={h}>
            <PdfHostView host={h} readOnly={readOnly} />
          </PreviewBoundary>,
          h.el,
          `${h.blockId}:${h.url}`,
        ),
      )}
    </>
  )
}

/**
 * Anything a preview throws while rendering stays in that block: it shows a message and the download
 * link, and the page and the editor go on (docs/adr/2483-*).
 */
class PreviewBoundary extends Component<{ host: PdfHost; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.warn('PDF preview failed:', error)
  }
  render() {
    if (!this.state.failed) return this.props.children
    const { url, name } = this.props.host
    return (
      <div className="nd-pdf rounded-md border border-line bg-app px-3 py-3 text-sm" data-testid="pdf-preview" data-state="error" role="alert">
        <p className="text-ink" data-testid="pdf-error" data-reason="crashed">
          {t('pdfPreview.error.other')}
        </p>
        <a href={url} download={name || ''} className="mt-1.5 inline-block text-accent underline underline-offset-2" data-testid="pdf-error-download">
          {t('pdfPreview.downloadFile', { name: name || 'PDF' })}
        </a>
      </div>
    )
  }
}

let chunk: Promise<ComponentType<PdfPreviewProps>> | null = null
function loadChunk(): Promise<ComponentType<PdfPreviewProps>> {
  chunk ??= import('./PdfPreview').then((m) => m.PdfPreview)
  chunk.catch(() => {
    chunk = null
  })
  return chunk
}

/**
 * Waits until the block is near the screen, then loads the preview chunk. Until then (and on a page
 * scrolled past it) nothing is fetched: neither the chunk nor the file.
 */
function PdfHostView({ host, readOnly }: { host: PdfHost; readOnly: boolean }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [Preview, setPreview] = useState<ComponentType<PdfPreviewProps> | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true)
        io.disconnect()
      }
    }, { rootMargin: '300px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [near])

  useEffect(() => {
    if (!near || Preview) return
    let live = true
    loadChunk().then(
      (C) => live && setPreview(() => C),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [near, Preview])

  if (Preview) return <Preview host={host} readOnly={readOnly} />
  return (
    <div ref={ref} className="nd-pdf nd-pdf-pending" data-testid="pdf-preview" data-state={failed ? 'error' : 'pending'}>
      {failed && (
        <p className="px-3 py-3 text-sm text-sub" role="alert">
          {t('pdfPreview.chunkFailed')}{' '}
          <a href={host.url} download={host.name || undefined} className="text-ink underline underline-offset-2">
            {t('pdfPreview.download')}
          </a>
        </p>
      )}
    </div>
  )
}
