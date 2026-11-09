import type { DefaultReactSuggestionItem } from '@blocknote/react'
import type { InklingEditor } from './CollabEditor'
import type { TKey, TParams } from '../i18n'
import { tableSizeFromQuery } from '../lib/tableInput'
import { insertSizedTable } from '../lib/tableQuickInput'

type T = (key: TKey, params?: TParams) => string

/**
 * "/표 3x4", "/table 3*4" (docs/adr/1642-*): one extra slash item for a table of that size (3 columns ×
 * 4 rows). The menu filters by title and aliases, so the item carries the query itself as an alias. While
 * only the column count is typed ("/표 3") the item is still there — BlockNote closes the menu after a few
 * keys without results — and inserts 3 × 3 if picked. Plain "/표" stays BlockNote's own item.
 */
export function tableSizeSlashItems(editor: InklingEditor, query: string, t: T): DefaultReactSuggestionItem[] {
  const size = tableSizeFromQuery(query)
  if (!size) return []
  const rows = size.rows ?? 3
  return [
    {
      title: size.rows ? t('slash.tableSizeTitle', { cols: size.cols, rows }) : t('slash.tableSizePending', { cols: size.cols }),
      subtext: size.rows ? t('slash.tableSizeSubtext', { cols: size.cols, rows }) : t('slash.tableSizePendingSubtext'),
      aliases: [query],
      group: editor.dictionary.slash_menu.table.group,
      icon: <span style={{ fontSize: 15, lineHeight: 1 }}>▦</span>,
      onItemClick: () => {
        insertSizedTable(editor, size.cols, rows)
      },
    },
  ]
}
