import type { PageKind, PageMetaDTO } from '@inkling/shared'
import { t } from '../i18n'

// Default emoji per page kind. A user-set icon takes precedence.
export function kindEmoji(kind: PageKind, expanded = false): string {
  if (kind === 'folder') return expanded ? '📂' : '📁'
  if (kind === 'canvas') return '🖼'
  if (kind === 'collection') return '🗂'
  return '📄'
}

export function pageIcon(
  page: Pick<PageMetaDTO, 'icon' | 'kind'>,
  expanded = false,
): string {
  return page.icon || kindEmoji(page.kind, expanded)
}

export function kindLabel(kind: PageKind): string {
  if (kind === 'folder') return t('common.folder')
  if (kind === 'canvas') return t('common.canvas')
  if (kind === 'collection') return t('common.database')
  return t('common.document')
}
