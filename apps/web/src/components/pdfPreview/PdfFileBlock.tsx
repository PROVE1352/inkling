// PDF preview under a file block (docs/adr/2480-*, 2481-*). The block stays BlockNote's file block — same
// config, parse, HTML export and stored props; the document schema does not change. The node view only
// gets one non-editable host after the file name when the file is a PDF uploaded to this server, and
// <PdfPortals> (inside BlockNoteView, like MermaidPortals) renders the preview into it. The preview
// itself (PdfPreview.tsx) and pdf.js (pdfDocument.ts) are lazy chunks, fetched only when a PDF block
// comes near the screen.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { defaultBlockSpecs, type BlockNoteEditor } from '@blocknote/core'
import { fileIdOf, pdfByName } from '../../lib/pdfFile'
import { useT } from '../../i18n'
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
      // a text drag out of the preview would drop the text into the document
      host.addEventListener('dragstart', (e) => e.preventDefault())
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
        // text is the reader's own selection: none of it is an edit or a document selection
        ignoreMutation: (m: { target: Node; type: string }) => host.contains(m.target),
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

/** Renders the PDF previews of `editor`'s file blocks into their hosts. */
export function PdfPortals({ editor, readOnly }: { editor: BlockNoteEditor<any, any, any>; readOnly: boolean }) {
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
  return <>{hosts.map((h) => createPortal(<PdfHostView host={h} readOnly={readOnly} />, h.el, `${h.blockId}:${h.url}`))}</>
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
