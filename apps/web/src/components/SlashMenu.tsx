import type { BlockNoteEditor } from '@blocknote/core'
import { FilePanelExtension, filterSuggestionItems } from '@blocknote/core/extensions'
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
} from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { CARET_MENU_FLOATING } from '../lib/caretMenu'
import type { CalloutType } from './blocks/Callout'
import { usePluginSlashItems } from '../plugins/integration'
import { linkEmbedSlashItems } from './blocks/LinkEmbed'
import { chartSlashItems } from './blocks/ChartBlock'
import { buttonSlashItems } from './blocks/ButtonBlock'
import { dbViewSlashItems } from './blocks/DbViewEmbed'
import { querySlashItem } from './blocks/QueryBlock'
import { mathSlashItems } from './blocks/Math'
import { tableSizeSlashItems } from './tableSlash'
import { useT } from '../i18n'
import { insertFromSlash, withCaretBelow, type SlashEditor } from '../lib/slashInsert'

/** Default items for blocks without inline content: the caret goes to an empty line below them. */
const CARET_BELOW = new Set(['divider', 'image', 'video', 'audio', 'file'])
const FILE_BLOCKS = new Set(['image', 'video', 'audio', 'file'])

// Slash ("/") menu controller (M14).
// BlockNoteView's default slash menu is turned off with slashMenu={false}; here we render the
// default items (getDefaultReactSlashMenuItems — includes built-ins such as toggle list and quote)
// plus the callout item. → Satisfies B1 (show toggle/quote) and B2 (insert callout) in one menu.
// Default items are unchanged except that blocks without text (divider, file blocks) leave the caret on
// an empty line below them (docs/adr/1270-*).
export function SlashMenu({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const t = useT()
  // Plugin blocks (experimental `plugins`; [] when off)
  const pluginItems = usePluginSlashItems(editor)
  // Insert a callout — replaces the current block if it is an empty paragraph, otherwise inserts
  // below it, then puts the cursor inside (lib/slashInsert.ts: rendered before the caret moves in).
  const insertCallout = (type: CalloutType) => {
    insertFromSlash(editor as unknown as SlashEditor, { type: 'callout', props: { type } }, 'inside')
  }

  const getItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const calloutItem: DefaultReactSuggestionItem = {
      title: t('slash.calloutTitle'),
      subtext: t('slash.calloutSubtext'),
      // Aliases are search data, not display text: English and Korean aliases are kept in every
      // locale so both "/callout" and "/콜아웃" work regardless of the UI language.
      aliases: ['callout', '콜아웃', '강조', 'admonition', 'note', 'tip', 'warning'],
      // Join BlockNote's own "Basic blocks" group in the active dictionary.
      group: editor.dictionary.slash_menu.paragraph.group,
      icon: <span style={{ fontSize: 16, lineHeight: 1 }}>💡</span>,
      onItemClick: () => insertCallout('note'),
    }
    return filterSuggestionItems(
      groupContiguous([
        ...getDefaultReactSlashMenuItems(editor).map((item) => {
          // the React item type drops `key`, the objects still carry BlockNote's item key
          const key = (item as { key?: string }).key ?? ''
          return CARET_BELOW.has(key)
            ? {
                ...item,
                onItemClick: withCaretBelow(
                  editor as unknown as SlashEditor,
                  item.onItemClick,
                  // BlockNote opens its file panel on insert and closes it on any selection change
                  FILE_BLOCKS.has(key)
                    ? (id) => editor.getExtension(FilePanelExtension)?.showMenu(id)
                    : undefined,
                ),
              }
            : item
        }),
        calloutItem,
        ...pluginItems,
        ...linkEmbedSlashItems(editor),
        querySlashItem(editor),
        ...chartSlashItems(editor),
        ...buttonSlashItems(editor),
        ...dbViewSlashItems(editor),
        ...mathSlashItems(editor, t),
        ...tableSizeSlashItems(editor, query, t),
      ]),
      query,
    )
  }

  return <SuggestionMenuController triggerCharacter="/" getItems={getItems} floatingUIOptions={CARET_MENU_FLOATING} />
}

/**
 * BlockNote's menu renders a group label per run of equal `group` values, keyed by the group name,
 * so a group that appears twice (the callout item in "Basic blocks" after the media/other groups)
 * produced a duplicate React key and a second "Basic blocks" heading. Make every group contiguous,
 * keeping the order in which groups (and items within a group) first appear.
 */
function groupContiguous<T extends { group?: string }>(items: readonly T[]): T[] {
  const groups = new Map<string | undefined, T[]>()
  for (const item of items) {
    const list = groups.get(item.group)
    if (list) list.push(item)
    else groups.set(item.group, [item])
  }
  return [...groups.values()].flat()
}
