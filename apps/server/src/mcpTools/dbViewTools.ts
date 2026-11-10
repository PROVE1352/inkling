/**
 * Inline database views in agent reads (docs/adr/2123-*). A database view is a page embed of a
 * collection (docs/adr/2120-*), so it reads as the page-embed token with ids only:
 *
 *   <!-- inkling:pageEmbed {"pageId":"<collection id>","viewId":"<view id>"} -->
 *   <!-- inkling:view-info database "Roadmap", view "Board" (board); its rows: query_rows -->
 *
 * The second line names the database and the view for this reader. Like the chart data line
 * (docs/adr/1604-*) it is an HTML comment that is not a token (`view-info` does not match the token
 * pattern), so writing the read back drops it and the block is unchanged; rows are never listed.
 * It is computed through GET /pages/:id/collection?rows=0 as the token's user, so a database the
 * reader cannot see gets no name (only "unavailable" when the block names a view).
 */
import type { CollectionDTO } from '@inkling/shared'
import { findVisiblePage } from '../pageDto'
import { call } from './core'
import type { ToolCtx } from './core'
import { cleanText } from './trust'

/** Database views annotated per read (each is one request). */
const MAX_ANNOTATED = 20
const TOKEN_LINE = /^([ \t>]*)<!--[ \t]*inkling:pageEmbed[ \t]+(\{.*\})[ \t]*-->[ \t]*$/gm
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Member text inside an HTML comment: one line, no `--`, quotes kept apart. */
function quoted(s: string): string {
  const t = cleanText(s || 'Untitled')
    .replace(/[\r\n]+/g, ' ')
    .replace(/-{2,}/g, (m) => m.split('').join(' '))
    .replace(/"/g, "'")
  return `"${t}"`
}

async function infoFor(ctx: ToolCtx, pageId: string, viewId: string): Promise<string | null> {
  const res = await call(ctx, 'GET', `/api/pages/${pageId}/collection`, { query: { rows: '0' }, passStatuses: [400, 403, 404] })
  // 400: not a collection (a page embed: nothing to add). 403/404: hidden or gone — named only when
  // the block itself says it is a database view (a viewId), so the line is no visibility oracle.
  if (res.statusCode === 400) return null
  if (res.statusCode !== 200) return viewId ? 'unavailable: this database is not visible to you (or was deleted)' : null
  const { collection } = res.json() as { collection: CollectionDTO }
  const title = (await findVisiblePage(pageId, ctx.user.id))?.title ?? ''
  const views = collection.views ?? []
  const view = (viewId && views.find((v) => v.id === viewId)) || views[0]
  const gone = !!viewId && !views.some((v) => v.id === viewId)
  const viewPart = view ? `, view ${quoted(view.name)} (${view.type})${gone ? ' — the saved view was deleted, the first view is shown' : ''}` : ', no views'
  return `database ${quoted(title)}${viewPart}; its rows: query_rows`
}

/**
 * Under each page-embed token that is a database view, one comment line naming it for this reader.
 * Other page embeds are left as they are.
 */
export async function annotateDbViews(ctx: ToolCtx, markdown: string): Promise<string> {
  if (!markdown.includes('inkling:pageEmbed')) return markdown
  const lines = [...markdown.matchAll(TOKEN_LINE)].slice(0, MAX_ANNOTATED)
  if (!lines.length) return markdown
  const notes = new Map<string, string>()
  for (const m of lines) {
    if (notes.has(m[0])) continue
    let raw: { pageId?: unknown; viewId?: unknown }
    try {
      raw = JSON.parse(m[2])
    } catch {
      continue
    }
    const pageId = typeof raw.pageId === 'string' ? raw.pageId : ''
    const viewId = typeof raw.viewId === 'string' && UUID_RE.test(raw.viewId) ? raw.viewId : ''
    if (!UUID_RE.test(pageId)) continue
    const info = await infoFor(ctx, pageId, viewId)
    if (info) notes.set(m[0], `${m[1]}<!-- inkling:view-info ${info} -->`)
  }
  if (!notes.size) return markdown
  return markdown.replace(TOKEN_LINE, (line) => (notes.has(line) ? `${line}\n${notes.get(line)}` : line))
}
