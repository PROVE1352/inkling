import type { BlockNoteEditor } from '@blocknote/core'
import { SuggestionMenuController } from '@blocknote/react'
import { CARET_MENU_FLOATING } from '../lib/caretMenu'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import type { PageMetaDTO } from '@inkling/shared'
import { internalHref } from '@inkling/shared/sectionLink'
import { useQueryClient } from '@tanstack/react-query'
import { useCreatePage, usePages } from '../api'
import { useT } from '../i18n'
import { fetchHeadings, type PageHeading } from '../lib/sectionLinks'
import { noteOnboarding } from '../onboarding/api'

// [[ autocomplete: inserts a standard inline link (href = /w/<ws>/p/<page>).
// [[Page# autocomplete: the page's section headings; inserts a section link (docs/adr/2100-*), text
// `Page#Heading`, href with the heading's text and block id (lib/sectionLinks.ts).
// ![[ autocomplete: inserts a pageEmbed block (M12 page embed).
// In the installed version (0.51.4) triggerCharacter is typed `string`, so multi-char "[[" / "![["
// work as is. The two triggers share a suffix ("![[" ends in "[["), so the "![[" controller is
// rendered first to register first in the SuggestionMenu plugin's trigger map (first match wins).
export function WikilinkMenu({
  editor,
  wsId,
}: {
  editor: BlockNoteEditor<any, any, any>
  wsId: string
}) {
  const t = useT()
  const pages = usePages(wsId)
  const createPage = useCreatePage(wsId)
  const queryClient = useQueryClient()

  const insertLink = (pageId: string, title: string) => {
    noteOnboarding('link')
    editor.insertInlineContent([
      { type: 'link', href: `/w/${wsId}/p/${pageId}`, content: title || t('common.untitled') },
      ' ',
    ])
  }

  const insertSectionLink = (page: PageMetaDTO, h: PageHeading) => {
    noteOnboarding('link')
    const title = page.title || t('common.untitled')
    editor.insertInlineContent([
      {
        type: 'link',
        href: internalHref(wsId, page.id, { heading: h.text, blockId: h.blockId, ...(page.title ? { page: page.title } : {}) }),
        content: `${title}#${h.text}`,
      },
      ' ',
    ])
  }

  // `Page#heading query`: the page whose whole title (or alias) is left of a `#` — the last such `#`,
  // so a title with `#` works — and its headings that contain the text after it. null: not that form.
  const getSectionItems = async (query: string): Promise<DefaultReactSuggestionItem[] | null> => {
    const all = pages.data ?? []
    let page: PageMetaDTO | undefined
    let rest = ''
    for (let i = query.indexOf('#'); i > 0; i = query.indexOf('#', i + 1)) {
      const name = query.slice(0, i).trim().toLowerCase()
      const hit =
        all.find((p) => (p.title || '').toLowerCase() === name) ??
        all.find((p) => (p.aliases ?? []).some((a) => a.toLowerCase() === name))
      if (hit && hit.kind === 'doc') {
        page = hit
        rest = query.slice(i + 1).trim().toLowerCase()
      }
    }
    if (!page) return null
    const target = page
    const headings = await fetchHeadings(queryClient, target.id).catch(() => [] as PageHeading[])
    const title = target.title || t('common.untitled')
    const matches = headings.filter((h) => h.text.toLowerCase().includes(rest)).slice(0, 12)
    if (!matches.length) {
      return [{ title, subtext: t('sectionLink.noHeadings', { page: title }), onItemClick: () => insertLink(target.id, target.title) }]
    }
    return matches.map((h) => ({
      title: `${'\u2003'.repeat(Math.max(0, Math.min(h.level, 6) - 1))}${h.text}`,
      subtext: t('sectionLink.headingIn', { page: title }),
      onItemClick: () => insertSectionLink(target, h),
    }))
  }

  // Insert a pageEmbed block. SuggestionMenu has already removed trigger + query, so replace the
  // current block if it is empty, otherwise insert below (avoids a leftover empty paragraph).
  const insertEmbed = (pageId: string) => {
    const cur = editor.getTextCursorPosition().block
    const embed = { type: 'pageEmbed' as const, props: { pageId } }
    const empty =
      (!Array.isArray(cur.content) || cur.content.length === 0) &&
      (!Array.isArray(cur.children) || cur.children.length === 0)
    if (empty && cur.type === 'paragraph') {
      editor.replaceBlocks([cur], [embed, { type: 'paragraph' }])
    } else {
      editor.insertBlocks([embed], cur, 'after')
    }
  }

  // Match title + aliases. When an alias matches, show it as "(alias)" next to the title.
  const matchPages = (query: string): { page: PageMetaDTO; alias?: string }[] => {
    const all = pages.data ?? []
    const q = query.trim().toLowerCase()
    if (q.length === 0) return all.slice(0, 8).map((page) => ({ page }))
    const out: { page: PageMetaDTO; alias?: string }[] = []
    for (const page of all) {
      if ((page.title || '').toLowerCase().includes(q)) {
        out.push({ page })
        continue
      }
      const alias = (page.aliases ?? []).find((a) => a.toLowerCase().includes(q))
      if (alias) out.push({ page, alias })
      if (out.length >= 8) break
    }
    return out.slice(0, 8)
  }

  const label = (page: PageMetaDTO, alias?: string) => {
    const title = page.title || t('common.untitled')
    return alias ? `${title} (${alias})` : title
  }

  const getLinkItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    if (query.includes('#')) {
      const sectionItems = await getSectionItems(query)
      if (sectionItems) return sectionItems
    }
    const items: DefaultReactSuggestionItem[] = matchPages(query).map(({ page, alias }) => ({
      title: label(page, alias),
      subtext: page.kind === 'folder' ? t('common.folder') : undefined,
      onItemClick: () => insertLink(page.id, page.title),
    }))
    const title = query.trim()
    if (title.length > 0) {
      items.push({
        title: t('wikilink.newPage', { title }),
        onItemClick: () => {
          createPage
            .mutateAsync({ workspaceId: wsId, title })
            .then((page) => insertLink(page.id, page.title || title))
            .catch(() => {})
        },
      })
    }
    return items
  }

  const getEmbedItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const items: DefaultReactSuggestionItem[] = matchPages(query).map(({ page, alias }) => ({
      title: label(page, alias),
      subtext: t('wikilink.embed'),
      onItemClick: () => insertEmbed(page.id),
    }))
    const title = query.trim()
    if (title.length > 0) {
      items.push({
        title: t('wikilink.newPageEmbed', { title }),
        onItemClick: () => {
          createPage
            .mutateAsync({ workspaceId: wsId, title })
            .then((page) => insertEmbed(page.id))
            .catch(() => {})
        },
      })
    }
    return items
  }

  return (
    <>
      {/* Register "![[" first so it wins over the overlapping suffix "[[". */}
      <SuggestionMenuController triggerCharacter="![[" getItems={getEmbedItems} floatingUIOptions={CARET_MENU_FLOATING} />
      <SuggestionMenuController triggerCharacter="[[" getItems={getLinkItems} floatingUIOptions={CARET_MENU_FLOATING} />
    </>
  )
}
