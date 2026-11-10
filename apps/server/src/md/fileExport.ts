/**
 * The Markdown download (`notation=file`, docs/adr/2122-*): blocks whose numbers are computed when
 * read keep a way back and show their numbers at export time.
 *
 *   chart           its token, then a snapshot of its table (the exporting member's numbers)
 *   database view   (page embed of a collection, docs/adr/2120-*) its token, then a snapshot of the
 *                   view's rows (filters, order, columns) as the member sees them
 *   query block     the ```dataview fence as before, then a snapshot of its results
 *   page embed      a link to the page (`[[Title]]`), or nothing when the member cannot see it
 *   link embed      a link to the address (with the cached preview title when there is one)
 *
 * A snapshot is a synthetic block (notation.ts SNAPSHOT_BLOCK) written between
 * `<!-- inkling:snapshot -->` and `<!-- /inkling:snapshot -->`; an import drops it after a token or
 * a fence, so the block comes back and export → import → export gives the same file. A chart whose
 * source the member cannot see keeps its token (the config is in the page anyway) and gets no
 * snapshot; a page embed of a page they cannot see is left out (database view or page: not said).
 */
import { eq } from 'drizzle-orm'
import { chartTableMarkdown, parseChartBlockConfig, parseHttpUrl } from '@inkling/shared'
import type { ChartDataDTO } from '@inkling/shared'
import { db } from '../db/index'
import { pages } from '../db/schema'
import { exportFor } from '../charts/render'
import { peekLinkPreview } from '../linkPreview'
import { findVisiblePage } from '../pageDto'
import { runWorkspaceQuery } from '../routes/query'
import { markdownToBlocks } from './convert'
import type { AnyBlock, Inline } from './convert'
import { loadEmbedView, mdCell, queryBlockSource, queryResultMarkdown, viewTableMarkdown } from './customTables'
import { SNAPSHOT_BLOCK } from './notation'

const LINKED = new Set(['chart', 'pageEmbed', 'linkEmbed', 'codeBlock'])

function needsWork(blocks: AnyBlock[]): boolean {
  return blocks.some((b) => LINKED.has(b.type ?? '') || (Array.isArray(b.children) && needsWork(b.children)))
}

const bold = (s: string) => `**${s.replace(/[\\`*_[\]<>|~]/g, '\\$&').replace(/[\r\n]+/g, ' ')}**\n\n`

async function snapshot(markdown: string): Promise<AnyBlock> {
  return { type: SNAPSHOT_BLOCK, props: {}, content: [], children: await markdownToBlocks(markdown, () => null) }
}

function linkParagraph(href: string, text: string): AnyBlock {
  const link = { type: 'link', href, content: [{ type: 'text', text, styles: {} }] } as Inline
  return { type: 'paragraph', props: {}, content: [link], children: [] }
}

/** The file-export form of a page's blocks (a new list; `blocks` is not changed). */
export async function fileExportBlocks(blocks: AnyBlock[], pageId: string, userId: string): Promise<AnyBlock[]> {
  // no such block, no extra statement (zip exports call this for every page)
  if (!needsWork(blocks)) return blocks
  const [p] = await db.select({ workspaceId: pages.workspaceId }).from(pages).where(eq(pages.id, pageId)).limit(1)
  if (!p) return blocks
  const workspaceId = p.workspaceId
  const chartData = exportFor(userId, workspaceId)
  const today = new Date().toISOString().slice(0, 10)

  const walk = async (list: AnyBlock[]): Promise<AnyBlock[]> => {
    const out: AnyBlock[] = []
    for (const b0 of list) {
      const b: AnyBlock = Array.isArray(b0.children) && b0.children.length ? { ...b0, children: await walk(b0.children) } : b0
      const type = b.type ?? ''
      if (type === 'chart') {
        out.push(b)
        const cfg = parseChartBlockConfig(b.props?.config)
        let data: ChartDataDTO | null = null
        if (cfg) data = await chartData(cfg).catch(() => null)
        if (cfg && data) out.push(await snapshot(`${cfg.title ? bold(cfg.title) : ''}${chartTableMarkdown(data, { empty: 'No value' })}`))
        continue
      }
      if (type === 'pageEmbed') {
        const target = typeof b.props?.pageId === 'string' && b.props.pageId ? await findVisiblePage(b.props.pageId, userId) : null
        const visible = target && target.workspaceId === workspaceId ? target : null
        if (visible?.kind === 'collection') {
          out.push(b)
          const md = await (async () => {
            const { view } = await loadEmbedView(visible.id, String(b.props?.viewId ?? ''))
            const table = await viewTableMarkdown({ id: visible.id, title: visible.title }, view, { kind: 'user', userId, workspaceId })
            return `${bold(`${visible.title || 'Untitled'}${view ? ` · ${view.name}` : ''}`)}${table}`
          })().catch(() => null)
          if (md) out.push(await snapshot(md))
          continue
        }
        // a page: a link (`[[Title]]` once written); not visible: nothing, as before (its children stay)
        if (visible) out.push({ ...linkParagraph(`/w/${workspaceId}/p/${visible.id}`, visible.title || 'Untitled'), children: b.children ?? [] })
        else out.push(...(b.children ?? []))
        continue
      }
      if (type === 'linkEmbed') {
        const url = typeof b.props?.url === 'string' ? b.props.url : ''
        const u = parseHttpUrl(url)
        if (u) out.push({ ...linkParagraph(u.href, peekLinkPreview(u.href)?.title || u.href), children: b.children ?? [] })
        else out.push(...(b.children ?? []))
        continue
      }
      const source = queryBlockSource(b)
      if (source) {
        out.push(b)
        const result = await runWorkspaceQuery(userId, workspaceId, source, today, 0).catch(() => null)
        if (result) {
          const md = queryResultMarkdown(result, {
            // an internal link: written as `[[Title]]` like every other link to a page
            page: (row) => `[${mdCell(row.title || 'Untitled')}](/w/${workspaceId}/p/${row.pageId})`,
            refTitle: (_id, title) => title,
          })
          out.push(await snapshot(md))
        }
        continue
      }
      out.push(b)
    }
    return out
  }
  return walk(structuredClone(blocks))
}
