import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { uploadFile } from '../api'
import { t } from '../i18n'
import { toast } from './toast'
import type { InklingEditor } from '../components/CollabEditor'

// Shared utilities for receiving OS file drags. BlockNote only handles files dropped on the body
// (.ProseMirror), so everything outside it (title, cover, the space below the body, canvas) is handled here.

// Same list as ALLOWED_MIME in the server files route. Filtering here first saves a 415 round trip.
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'text/plain',
])

// Same value as the server's MAX_FILE_BYTES.
const MAX_FILE_BYTES = 25 * 1024 * 1024

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') && ALLOWED_MIME.has(file.type)
}

/** Is the dragged data an OS file (text/link drags excluded)? */
export function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes('Files')
}

/** Pre-upload validation — returns the files that pass and reports rejected ones in a toast. */
export function filterUploadable(files: File[], imagesOnly = false): File[] {
  const ok: File[] = []
  let rejectedType = 0
  let rejectedSize = 0
  for (const f of files) {
    if (!(imagesOnly ? isImageFile(f) : ALLOWED_MIME.has(f.type))) {
      rejectedType++
      continue
    }
    if (f.size > MAX_FILE_BYTES) {
      rejectedSize++
      continue
    }
    ok.push(f)
  }
  if (rejectedType > 0) {
    toast({
      message: imagesOnly
        ? t('fileDrop.imagesOnly')
        : t('fileDrop.unsupportedType'),
    })
  }
  if (rejectedSize > 0) toast({ message: t('fileDrop.tooLarge', { max: '25MB' }) })
  return ok
}

type BlockType = 'image' | 'video' | 'audio' | 'file'

function blockTypeFor(file: File): BlockType {
  if (isImageFile(file)) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

/** Reuses the last block if it is an empty paragraph, otherwise appends a new block at the end. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function appendBlock(editor: InklingEditor, block: any): string | null {
  const last = editor.document.at(-1)
  if (!last) return null
  const isEmptyParagraph =
    last.type === 'paragraph' && Array.isArray(last.content) && last.content.length === 0
  if (isEmptyParagraph) return editor.updateBlock(last, block).id
  return editor.insertBlocks([block], last, 'after')[0].id
}

/**
 * Uploads files and appends them as attachment blocks at the end of the document. Like BlockNote's
 * own flow (create an empty block first, fill in the url when the upload finishes), so a placeholder
 * shows while uploading.
 */
export async function appendFilesToEditor(
  editor: InklingEditor,
  wsId: string,
  pageId: string,
  files: File[],
): Promise<void> {
  for (const file of filterUploadable(files)) {
    const blockId = appendBlock(editor, {
      type: blockTypeFor(file),
      props: { name: file.name },
    })
    if (!blockId) continue
    try {
      const url = await uploadFile(wsId, file, pageId)
      editor.updateBlock(blockId, { props: { url } })
    } catch {
      editor.removeBlocks([blockId])
      toast({ message: t('fileDrop.uploadFailed', { name: file.name }) })
    }
  }
}

/**
 * Attaches OS file dropping to an element. Returns the active state, for showing an overlay.
 *
 * Already-handled events (defaultPrevented) are skipped — ProseMirror catches drops on the body first
 * and calls preventDefault, so this hook only gets areas BlockNote leaves alone. That is also why it
 * uses native listeners instead of React synthetic events (synthetic events are handled together at
 * the root, so their order relative to native handlers below is hard to guarantee).
 */
export function useFileDropZone(
  ref: RefObject<HTMLElement | null>,
  onFiles: (files: File[], point: { x: number; y: number }) => void,
  enabled = true,
): boolean {
  const [active, setActive] = useState(false)
  const handlerRef = useRef(onFiles)
  handlerRef.current = onFiles

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    // dragover repeats while the cursor stays. dragleave fires at every child boundary and can't be
    // trusted, so the overlay turns off shortly after the last dragover instead.
    // Browsers keep sending dragover roughly every 350ms even when the cursor is still, so the
    // delay must be comfortably longer or the hint flickers.
    let hideTimer: number | undefined
    const scheduleHide = () => {
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => setActive(false), 700)
    }

    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setActive(true)
      scheduleHide()
    }
    const onDrop = (e: DragEvent) => {
      window.clearTimeout(hideTimer)
      setActive(false)
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length > 0) handlerRef.current(files, { x: e.clientX, y: e.clientY })
    }
    const onDragEnd = () => {
      window.clearTimeout(hideTimer)
      setActive(false)
    }

    // Leaving the area entirely turns it off at once (moves between children are ignored).
    const onDragLeave = (e: DragEvent) => {
      const to = e.relatedTarget
      if (to instanceof Node && el.contains(to)) return
      window.clearTimeout(hideTimer)
      setActive(false)
    }

    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.clearTimeout(hideTimer)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [ref, enabled])

  return active
}
