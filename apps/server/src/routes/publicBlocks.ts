/**
 * Blocks with data from elsewhere on public pages (docs/adr/2121-*). One gate for every kind: a block
 * shows data only from pages inside what the link shares (`inShare`: the page of a single-page
 * link; the folder and its current subtree for a folder link, as routes/public.ts computes it on
 * every request), never what the person who shared it can see.
 *
 *   page embed of a page inside   its title (a link) and its body, one level deep: a page embedded
 *                                  in an embedded page is a link; its images through its own ref
 *   page embed of a collection     the view as a table: shared rows inside the link, the view's
 *   inside (database view)         filters, order and columns, no relation titles, no rollups
 *   page embed of anything else    one line saying something is not part of the link, without its
 *                                  title, kind or id
 *   link embed                     a card: the cached preview title (never fetched here) and the URL
 *   query block (```dataview)      a table of the results, run with no user inside the link's
 *                                  subtree (connection range of docs/adr/1200-*), then cut to
 *                                  `inShare`; relation cells keep linked pages inside only
 *
 * Every replacement is an ordinary block, built before blocksToFullHTML, so no id, query text or
 * config reaches the HTML; md/convert.ts publicBlocks still drops whatever is left (fail closed).
 */
import { eq } from 'drizzle-orm'
import { parseHttpUrl } from '@inkling/shared'
import type { QueryResultDTO } from '@inkling/shared'
import { db } from '../db/index'
import { pageDocs } from '../db/schema'
import { env } from '../env'
import type { Locale } from '../i18n'
import { peekLinkPreview } from '../linkPreview'
import { markdownToBlocks, rewriteAssetUrlsForPublic, stateToBlocks } from '../md/convert'
import type { AnyBlock, Inline } from '../md/convert'
import { loadEmbedView, mdCell, queryBlockSource, queryResultMarkdown, viewTableMarkdown } from '../md/customTables'
import { runInRange } from '../tokenRange'
import { runWorkspaceQuery } from './query'

/** The pages a public block may show data of. */
export interface PublicPageRef {
  id: string
  workspaceId: string
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  title: string
}

export interface PublicBlocksCtx {
  workspaceId: string
  /** pages inside the link (the root of a folder link included) */
  inShare: ReadonlyMap<string, PublicPageRef>
  /** subtree root of the link (the range a query runs in) */
  rootId: string
  /** the page being shown */
  hostId: string
  /** public URL of an attachment of a page inside the link, or null */
  fileUrl: (pageId: string, fileId: string) => string | null
  /** replaces chart blocks with their public form (docs/adr/1605-*, 2440-*); embedded pages use it too */
  charts?: (blocks: AnyBlock[]) => Promise<AnyBlock[]>
}

/** No account has this id: `visibleTo` of it is "shared pages" and the range does the rest. */
export const PUBLIC_READER_ID = '00000000-0000-0000-0000-000000000000'

const TEXT: Record<Locale, Record<'outside' | 'unavailable' | 'noResults', string>> = {
  en: {
    outside: 'Embedded content that is not part of this link.',
    unavailable: 'This content is not available on a shared page.',
    noResults: 'No results inside this link.',
  },
  ko: {
    outside: '이 링크에 포함되지 않은 내용이 임베드되어 있습니다.',
    unavailable: '공유 페이지에서는 볼 수 없는 내용입니다.',
    noResults: '이 링크 안에는 결과가 없습니다.',
  },
}

function note(key: keyof (typeof TEXT)['en']): AnyBlock {
  const text = (TEXT[env.defaultLocale] ?? TEXT.en)[key]
  return { type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: { italic: true } }], children: [] }
}

function boldLink(href: string, text: string): Inline {
  return { type: 'link', href, content: [{ type: 'text', text, styles: { bold: true } }] } as Inline
}

async function docBlocks(pageId: string): Promise<AnyBlock[]> {
  const [row] = await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, pageId)).limit(1)
  if (!row) return []
  try {
    return stateToBlocks(row.state)
  } catch {
    return []
  }
}

async function queryTable(source: string, ctx: PublicBlocksCtx): Promise<AnyBlock[]> {
  let result: QueryResultDTO
  try {
    result = await runInRange({ userId: PUBLIC_READER_ID, kind: 'subtree', workspaceIds: [ctx.workspaceId], rootPageId: ctx.rootId }, () =>
      runWorkspaceQuery(PUBLIC_READER_ID, ctx.workspaceId, source, new Date().toISOString().slice(0, 10), 0),
    )
  } catch {
    return [note('unavailable')]
  }
  // the range walks every descendant; the link stops at private, trashed and template pages
  const rows = result.rows.filter((r) => ctx.inShare.has(r.pageId))
  if (!rows.length) return [note('noResults')]
  const md = queryResultMarkdown(
    { ...result, rows },
    {
      page: (row) => `[${mdCell(row.title || 'Untitled')}](/w/${ctx.workspaceId}/p/${row.pageId})`,
      refTitle: (id, title) => (ctx.inShare.has(id) ? title : null),
    },
  )
  return markdownToBlocks(md, () => null)
}

/**
 * The public form of `blocks` (a new list). `depth` 0 is the shown page; 1 is a page embedded in it
 * (whose own page embeds become links).
 */
export async function publicCustomBlocks(blocks: AnyBlock[], ctx: PublicBlocksCtx, depth = 0): Promise<AnyBlock[]> {
  const out: AnyBlock[] = []
  for (const b0 of blocks) {
    const b: AnyBlock = Array.isArray(b0.children) && b0.children.length ? { ...b0, children: await publicCustomBlocks(b0.children, ctx, depth) } : b0
    const type = b.type ?? ''
    if (type === 'pageEmbed') {
      const id = typeof b.props?.pageId === 'string' ? b.props.pageId : ''
      const target = id ? ctx.inShare.get(id) : undefined
      if (!target || target.workspaceId !== ctx.workspaceId) {
        out.push(note('outside'), ...(b.children ?? []))
        continue
      }
      const title = target.title || 'Untitled'
      const head: AnyBlock = { type: 'paragraph', props: {}, content: [boldLink(`/w/${ctx.workspaceId}/p/${target.id}`, title)], children: [] }
      if (target.kind === 'collection') {
        try {
          const { view } = await loadEmbedView(target.id, String(b.props?.viewId ?? ''))
          const md = await viewTableMarkdown({ id: target.id, title: target.title }, view, {
            kind: 'public',
            workspaceId: ctx.workspaceId,
            keep: (rowId) => ctx.inShare.has(rowId),
          })
          out.push(head, ...(await markdownToBlocks(md, () => null)))
        } catch {
          out.push(head, note('unavailable'))
        }
      } else if (target.kind === 'doc' && depth === 0 && target.id !== ctx.hostId) {
        let inner = await docBlocks(target.id)
        if (ctx.charts) inner = await ctx.charts(inner)
        inner = await publicCustomBlocks(inner, { ...ctx, hostId: target.id }, depth + 1)
        // the embedded page's images are served through its own address (the file gate is per page)
        rewriteAssetUrlsForPublic(inner, (fileId) => ctx.fileUrl(target.id, fileId) ?? '')
        out.push({ ...head, children: inner })
      } else {
        out.push(head)
      }
      out.push(...(b.children ?? []))
      continue
    }
    if (type === 'linkEmbed') {
      const u = parseHttpUrl(typeof b.props?.url === 'string' ? b.props.url : '')
      if (u) {
        const title = peekLinkPreview(u.href)?.title?.trim()
        const content: Inline[] = title
          ? [boldLink(u.href, title), { type: 'text', text: `\n${u.href}`, styles: {} } as Inline]
          : [{ type: 'link', href: u.href, content: [{ type: 'text', text: u.href, styles: {} }] } as Inline]
        out.push({ type: 'paragraph', props: {}, content, children: [] })
      }
      out.push(...(b.children ?? []))
      continue
    }
    const source = queryBlockSource(b)
    if (source) {
      out.push(...(await queryTable(source, ctx)), ...(b.children ?? []))
      continue
    }
    out.push(b)
  }
  return out
}
