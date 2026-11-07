import type { PageKind, PageMetaDTO } from '@inkling/shared'
import { CanvasIcon, DatabaseIcon, FileTextIcon, FolderIcon } from './Icons'

/** Monochrome line icon for a page kind (the default when the user picked no icon). */
export function KindIcon({ kind, size = 16, className }: { kind: PageKind; size?: number; className?: string }) {
  const Icon =
    kind === 'folder' ? FolderIcon : kind === 'collection' ? DatabaseIcon : kind === 'canvas' ? CanvasIcon : FileTextIcon
  return <Icon size={size} className={className} />
}

/**
 * A page's icon for lists (sidebar tree, bookmarks, folder view, search…): the user's emoji when
 * one is set, otherwise a muted line icon in the style of Icons.tsx instead of a colour emoji
 * (📄📁 stood out next to the text). The string form `pageIcon()` stays for text-only places.
 */
export function PageIconGlyph({
  page,
  size = 16,
  className = '',
}: {
  page: Pick<PageMetaDTO, 'icon' | 'kind'>
  /** Line icon size in px (an emoji follows the surrounding font size) */
  size?: number
  className?: string
}) {
  if (page.icon) return <span className={className}>{page.icon}</span>
  return (
    <span className={`inline-flex items-center justify-center text-sub ${className}`} aria-hidden="true">
      <KindIcon kind={page.kind} size={size} />
    </span>
  )
}
