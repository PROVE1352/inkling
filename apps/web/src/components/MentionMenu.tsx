import type { BlockNoteEditor } from '@blocknote/core'
import { SuggestionMenuController } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { useMembers, usePages } from '../api'
import { AGENT_MENTION_KIND } from '@inkling/shared'
import { connectionLabel, useAgentConnections } from '../teamAgentsApi'
import { pageIcon } from '../lib/pageIcon'
import { useT } from '../i18n'
import { liveStatus, statusLabel } from '../memberStatusApi'

// `@` autocomplete → inserts an inline mention (M13).
// Shows members (people) and pages in one list. People = kind 'user' blue chip, pages = kind 'page' link.
export function MentionMenu({
  editor,
  wsId,
}: {
  editor: BlockNoteEditor<any, any, any>
  wsId: string
}) {
  const t = useT()
  const members = useMembers(wsId)
  const pages = usePages(wsId)
  // members' live agent connections ("Bob · Claude Code", docs/adr/1861-*): a chip of kind 'agent'
  const connections = useAgentConnections(wsId)

  const insertMention = (kind: 'user' | 'page' | typeof AGENT_MENTION_KIND, id: string, label: string) => {
    editor.insertInlineContent([
      { type: 'mention', props: { kind, id, label: label || t('mention.noName') } },
      ' ',
    ])
  }

  const getItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const q = query.trim().toLowerCase()
    const items: DefaultReactSuggestionItem[] = []

    for (const m of members.data ?? []) {
      if (items.length >= 12) break
      if (q && !m.name.toLowerCase().includes(q) && !m.email.toLowerCase().includes(q)) {
        continue
      }
      // a status in force shows before the email (docs/adr/1846-*)
      const status = liveStatus(m.status)
      items.push({
        title: m.name,
        subtext: status ? `${statusLabel(status)} · ${m.email}` : m.email,
        onItemClick: () => insertMention('user', m.id, m.name),
      })
    }

    let agents = 0
    for (const c of connections.data ?? []) {
      if (agents >= 6) break
      const label = connectionLabel(c)
      if (q && !label.toLowerCase().includes(q)) continue
      agents++
      items.push({
        title: label,
        subtext: t('teamAgents.connectionSub'),
        onItemClick: () => insertMention(AGENT_MENTION_KIND, c.ref, label),
      })
    }

    for (const p of pages.data ?? []) {
      if (items.length >= 26) break
      const title = p.title || t('common.untitled')
      if (q && !title.toLowerCase().includes(q)) continue
      items.push({
        title: `${pageIcon(p)} ${title}`,
        subtext: t('common.page'),
        onItemClick: () => insertMention('page', p.id, title),
      })
    }

    return items
  }

  return <SuggestionMenuController triggerCharacter="@" getItems={getItems} />
}
