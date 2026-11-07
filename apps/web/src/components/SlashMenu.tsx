import type { BlockNoteEditor } from '@blocknote/core'
import { filterSuggestionItems } from '@blocknote/core/extensions'
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
} from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import type { CalloutType } from './blocks/Callout'
import { usePluginSlashItems } from '../plugins/integration'
import { linkEmbedSlashItems } from './blocks/LinkEmbed'
import { querySlashItem } from './blocks/QueryBlock'
import { useT } from '../i18n'

// Slash ("/") menu controller (M14).
// BlockNoteView's default slash menu is turned off with slashMenu={false}; here we render the
// default items (getDefaultReactSlashMenuItems — includes built-ins such as toggle list and quote)
// plus the callout item. → Satisfies B1 (show toggle/quote) and B2 (insert callout) in one menu,
// with the default items unchanged.
export function SlashMenu({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const t = useT()
  // Plugin blocks (experimental `plugins`; [] when off)
  const pluginItems = usePluginSlashItems(editor)
  // Insert a callout — replaces the current block if it is an empty paragraph, otherwise inserts
  // below it, then puts the cursor inside.
  const insertCallout = (type: CalloutType) => {
    const cur = editor.getTextCursorPosition().block
    const callout = { type: 'callout' as const, props: { type } }
    const empty =
      (!Array.isArray(cur.content) || cur.content.length === 0) &&
      (!Array.isArray(cur.children) || cur.children.length === 0)
    const inserted =
      empty && cur.type === 'paragraph'
        ? editor.replaceBlocks([cur], [callout]).insertedBlocks[0]
        : editor.insertBlocks([callout], cur, 'after')[0]
    if (inserted) editor.setTextCursorPosition(inserted, 'end')
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
        ...getDefaultReactSlashMenuItems(editor),
        calloutItem,
        ...pluginItems,
        ...linkEmbedSlashItems(editor),
        querySlashItem(editor),
      ]),
      query,
    )
  }

  return <SuggestionMenuController triggerCharacter="/" getItems={getItems} />
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
