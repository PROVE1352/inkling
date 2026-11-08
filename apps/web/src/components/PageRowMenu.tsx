import type { PageMetaDTO } from '@inkling/shared'
import { useT } from '../i18n'
import {
  CheckIcon,
  CanvasIcon,
  CopyIcon,
  DatabaseIcon,
  DownloadIcon,
  EditIcon,
  FolderPlusIcon,
  LinkIcon,
  LockIcon,
  MoveIcon,
  PlusIcon,
  TemplateIcon,
  TrashIcon,
  UploadIcon,
  WidthIcon,
} from './Icons'

// Action menu items for a tree row (shared). The ⋯ dropdown and the right-click context menu use the same items.
// Positioning/motion belong to the wrapper (panel div); this only renders the list of buttons.
// Delete moves to trash immediately, without confirmation, plus an undo toast (onDelete). The caller closes the menu via onClose.
export function PageRowMenu({
  page,
  isFolder,
  isBookmarked,
  onToggleBookmark,
  onRename,
  onAddChild,
  onMove,
  onDuplicate,
  onSaveTemplate,
  onExpandCanvas,
  onToggleFullWidth,
  onExport,
  onNotion,
  onShare,
  onLock,
  onDelete,
  onClose,
  guest = false,
}: {
  page: PageMetaDTO
  isFolder: boolean
  isBookmarked: boolean
  onToggleBookmark: () => void
  onRename: () => void
  onAddChild: (kind: 'doc' | 'folder' | 'collection') => void
  onMove: () => void
  onDuplicate: () => void
  onSaveTemplate: () => void
  onExpandCanvas: () => void
  onToggleFullWidth: () => void
  onExport: (format: 'md' | 'canvas' | 'zip') => void
  onNotion: () => void
  /** Share to web (doc/collection/folder, shared section only). Item hidden when absent. */
  onShare?: () => void
  /** Edit lock / agent instructions dialog (shared pages). Item hidden when absent. */
  onLock?: () => void
  onDelete: () => void
  onClose: () => void
  /**
   * Guest of the workspace (docs/adr/1252-*): only what the server lets a guest do on a page —
   * rename, add a subpage or folder (on pages they can edit) and full width.
   */
  guest?: boolean
}) {
  const t = useT()
  const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover'
  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }

  if (guest) {
    return (
      <>
        <button type="button" onClick={run(onRename)} className={item}>
          <EditIcon size={15} /> {t('common.rename')}
        </button>
        <button type="button" onClick={run(() => onAddChild('doc'))} className={item}>
          <PlusIcon size={15} /> {t('rowMenu.subpage')}
        </button>
        <button type="button" onClick={run(() => onAddChild('folder'))} className={item}>
          <FolderPlusIcon size={15} /> {t('rowMenu.subfolder')}
        </button>
        {page.kind === 'doc' && (
          <button type="button" onClick={run(onToggleFullWidth)} className={item}>
            <WidthIcon size={15} />
            <span className="flex-1">{t('rowMenu.fullWidth')}</span>
            {page.fullWidth && <CheckIcon size={14} />}
          </button>
        )}
      </>
    )
  }

  return (
    <>
      <button type="button" onClick={run(onToggleBookmark)} className={item}>
        <span className={`text-[15px] leading-none ${isBookmarked ? 'text-amber-500' : ''}`}>
          {isBookmarked ? '★' : '☆'}
        </span>{' '}
        {isBookmarked ? t('rowMenu.removeFavorite') : t('rowMenu.addFavorite')}
      </button>
      <button type="button" onClick={run(onRename)} className={item}>
        <EditIcon size={15} /> {t('common.rename')}
      </button>
      <button type="button" onClick={run(() => onAddChild('doc'))} className={item}>
        <PlusIcon size={15} /> {t('rowMenu.subpage')}
      </button>
      <button type="button" onClick={run(() => onAddChild('folder'))} className={item}>
        <FolderPlusIcon size={15} /> {t('rowMenu.subfolder')}
      </button>
      <button type="button" onClick={run(() => onAddChild('collection'))} className={item}>
        <DatabaseIcon size={15} /> {t('rowMenu.subdatabase')}
      </button>
      <button type="button" onClick={run(onMove)} className={item}>
        <MoveIcon size={15} /> {t('rowMenu.moveTo')}
      </button>
      <button type="button" onClick={run(onDuplicate)} className={item}>
        <CopyIcon size={15} /> {t('common.duplicate')}
      </button>
      {page.kind === 'doc' && (
        <button type="button" onClick={run(onSaveTemplate)} className={item}>
          <TemplateIcon size={15} /> {t('rowMenu.saveAsTemplate')}
        </button>
      )}
      {page.kind === 'doc' && (
        <button type="button" onClick={run(onExpandCanvas)} className={item}>
          <CanvasIcon size={15} /> {t('rowMenu.expandToCanvas')}
        </button>
      )}
      {page.kind === 'doc' && (
        <button type="button" onClick={run(onToggleFullWidth)} className={item}>
          <WidthIcon size={15} />
          <span className="flex-1">{t('rowMenu.fullWidth')}</span>
          {page.fullWidth && <CheckIcon size={14} />}
        </button>
      )}
      {!isFolder &&
        (page.kind === 'canvas' ? (
          <button type="button" onClick={run(() => onExport('canvas'))} className={item}>
            <DownloadIcon size={15} /> {t('rowMenu.exportCanvas')}
          </button>
        ) : (
          <button type="button" onClick={run(() => onExport('md'))} className={item}>
            <DownloadIcon size={15} /> {t('rowMenu.exportMd')}
          </button>
        ))}
      <button type="button" onClick={run(() => onExport('zip'))} className={item}>
        <DownloadIcon size={15} /> {t('rowMenu.exportZip')}
      </button>
      {(page.kind === 'doc' || page.kind === 'collection') && (
        <button type="button" onClick={run(onNotion)} className={item}>
          <UploadIcon size={15} /> {t('rowMenu.sendToNotion')}
        </button>
      )}
      {onShare &&
        page.scope !== 'private' &&
        (page.kind === 'doc' || page.kind === 'collection' || page.kind === 'folder') && (
          <button type="button" onClick={run(onShare)} className={item}>
            <LinkIcon size={15} /> {t('rowMenu.shareToWeb')}
          </button>
        )}
      {onLock && page.scope !== 'private' && (
        <button type="button" onClick={run(onLock)} className={item}>
          <LockIcon size={15} />
          <span className="flex-1">{t('rowMenu.editLock')}</span>
          {page.editLocked && <CheckIcon size={14} />}
        </button>
      )}
      <div className="my-1 border-t border-line" />
      <button
        type="button"
        onClick={run(onDelete)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-hover"
      >
        <TrashIcon size={15} /> {t('common.delete')}
      </button>
    </>
  )
}
