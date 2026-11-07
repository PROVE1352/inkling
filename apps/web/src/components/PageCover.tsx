import { useRef, useState } from 'react'
import type { PageMetaDTO } from '@inkling/shared'
import { uploadFile, useUpdatePage } from '../api'
import { filterUploadable, useFileDropZone } from '../lib/fileDrop'
import { toast } from '../lib/toast'
import { Spinner } from './Spinner'
import { ImageIcon } from './Icons'
import { useT } from '../i18n'

// Page cover image. With coverUrl: an image band (≈180px, object-cover) with [Change]/[Remove]
// on hover. Without: only an "Add cover" button on hover.
// Upload: uploadFile(wsId, file, pageId) → updatePage({ coverUrl }).
export function PageCover({
  wsId,
  page,
  readOnly = false,
}: {
  wsId: string
  page: PageMetaDTO
  /** Edit lock: show the cover only, without change/remove/drop affordances. */
  readOnly?: boolean
}) {
  const t = useT()
  const updatePage = useUpdatePage(wsId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const pick = () => inputRef.current?.click()

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      const url = await uploadFile(wsId, file, page.id)
      updatePage.mutate({ id: page.id, input: { coverUrl: url } })
    } catch {
      toast({ message: t('cover.uploadFailed') })
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = () => updatePage.mutate({ id: page.id, input: { coverUrl: null } })

  // Dropping an image on the cover area makes it the cover. preventDefault here means the
  // body drop zone (PageView) does not handle the event again.
  const dropRef = useRef<HTMLDivElement>(null)
  const dropActive = useFileDropZone(
    dropRef,
    (files) => {
      const [image] = filterUploadable(files, true)
      if (image) void onFile(image)
    },
    !readOnly,
  )

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(e) => onFile(e.target.files?.[0])}
    />
  )

  if (readOnly) {
    // Keep the layout (cover or the small spacer) but offer no editing.
    return page.coverUrl ? (
      <div className="relative mb-4 h-[180px] w-full overflow-hidden rounded-lg border border-line">
        <img src={page.coverUrl} alt={t('cover.alt')} className="h-full w-full object-cover" draggable={false} />
      </div>
    ) : (
      <div className="mb-1 h-6" />
    )
  }

  if (page.coverUrl) {
    return (
      <div
        ref={dropRef}
        className={`group/cover relative mb-4 h-[180px] w-full overflow-hidden rounded-lg border transition-colors duration-150 ${
          dropActive ? 'border-accent ring-2 ring-accent/30' : 'border-line'
        }`}
      >
        <img
          src={page.coverUrl}
          alt={t('cover.alt')}
          className="h-full w-full object-cover"
          draggable={false}
        />
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/cover:opacity-100">
          <button
            type="button"
            onClick={pick}
            disabled={busy}
            className="flex items-center gap-1 rounded-md bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm transition hover:bg-black/70 disabled:opacity-60"
          >
            {busy ? <Spinner size={12} className="border-white/40 border-t-white" /> : null}
            {t('cover.change')}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="rounded-md bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm transition hover:bg-black/70 disabled:opacity-60"
          >
            {t('common.remove')}
          </button>
        </div>
        {hiddenInput}
      </div>
    )
  }

  return (
    <div ref={dropRef} className="mb-1 h-6">
      <button
        type="button"
        onClick={pick}
        disabled={busy}
        className={`-ml-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-opacity duration-150 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/page:opacity-100 disabled:opacity-60 ${
          dropActive ? 'bg-hover text-accent opacity-100' : 'text-sub opacity-0'
        }`}
      >
        {busy ? <Spinner size={12} /> : <ImageIcon size={14} />}
        {dropActive ? t('cover.dropToSet') : t('cover.add')}
      </button>
      {hiddenInput}
    </div>
  )
}
