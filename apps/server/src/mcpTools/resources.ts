import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { and, asc, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/index'
import { bookmarks, pages } from '../db/schema'
import { memberWorkspaceIds } from '../context/retrieve'
import { visibleTo } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'
import { runAsConnection } from './agentContext'
import type { ToolCtx } from './core'
import { cleanText } from './trust'

/**
 * MCP resources (docs/adr/2001-*): pages as `inkling://page/<id>`, for clients that attach a
 * resource to the conversation (Claude Code's @-mentions).
 *
 * - resources/templates/list: one template, `inkling://page/{id}` (a full id or the 8+ hex prefix
 *   tools print).
 * - resources/list: at most RESOURCE_LIST_MAX pages — the person's favorites (their order), then the
 *   most recently changed pages — never the whole workspace; anything else is reached through the
 *   template or find_context. Pages are what this connection can see: member workspaces that allow
 *   agents and are not blocked by the two-step requirement, the connection range, visibleTo
 *   (shared pages and the person's own private ones), live pages of live workspaces; collection
 *   rows and folders are left out. Names are titles (cleanText, cut at NAME_MAX); the description
 *   is fixed server text.
 * - resources/read: the read_page answer for that page, run through the server's own tools/call
 *   handler (the same REST permission checks, id resolution, <untrusted_content> wrapping and
 *   metering as the tool). A page that does not exist and one this connection may not see give the
 *   same error.
 */

export const RESOURCE_LIST_MAX = 50
const FAVORITES_MAX = 25
const NAME_MAX = 120
/** MCP's "resource not found" error code (spec: -32002). */
export const RESOURCE_NOT_FOUND = -32002

export const PAGE_URI_PREFIX = 'inkling://page/'
export const pageUri = (id: string) => `${PAGE_URI_PREFIX}${id}`

type Handler = (req: unknown, extra: unknown) => Promise<unknown>

interface Listed {
  uri: string
  name: string
  description: string
  mimeType: string
}

const nameOf = (title: string) => {
  const t = cleanText(title || 'Untitled').replace(/\s+/g, ' ')
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t
}

/** Favorites first, then recently changed pages, deduplicated, capped (exported for tests). */
export async function listPageResources(ctx: ToolCtx): Promise<Listed[]> {
  return runAsConnection(ctx, async () => {
    const ws = await memberWorkspaceIds(ctx.user.id)
    if (!ws.length) return []
    const parent = alias(pages, 'parent')
    const base = and(
      inArray(pages.workspaceId, ws),
      isNull(pages.deletedAt),
      visibleTo(ctx.user.id),
      liveWorkspace(pages.workspaceId),
      ne(pages.kind, 'folder'),
      or(isNull(pages.parentId), ne(parent.kind, 'collection')),
    )
    const favs = await db
      .select({ id: pages.id, title: pages.title })
      .from(bookmarks)
      .innerJoin(pages, eq(pages.id, bookmarks.pageId))
      .leftJoin(parent, eq(pages.parentId, parent.id))
      .where(and(eq(bookmarks.userId, ctx.user.id), base))
      .orderBy(asc(bookmarks.sortOrder), asc(pages.id))
      .limit(FAVORITES_MAX)
    const recent = await db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .leftJoin(parent, eq(pages.parentId, parent.id))
      .where(base)
      .orderBy(desc(pages.updatedAt), asc(pages.id))
      .limit(RESOURCE_LIST_MAX)
    const seen = new Set<string>()
    const out: Listed[] = []
    const add = (p: { id: string; title: string }, description: string) => {
      if (seen.has(p.id) || out.length >= RESOURCE_LIST_MAX) return
      seen.add(p.id)
      out.push({ uri: pageUri(p.id), name: nameOf(p.title), description, mimeType: 'text/markdown' })
    }
    for (const p of favs) add(p, 'Favorite')
    for (const p of recent) add(p, 'Recently changed')
    return out
  })
}

export function registerResources(server: McpServer, ctx: ToolCtx): void {
  server.registerResource(
    'page',
    new ResourceTemplate(`${PAGE_URI_PREFIX}{id}`, {
      list: async () => ({ resources: await listPageResources(ctx) }),
    }),
    {
      // no `title` here: the SDK copies the template's metadata into every listed page, and a client
      // shows `title` before `name` (the page title)
      description: 'A page as read_page shows it (Markdown; member text inside <untrusted_content>). id: the page id or its first 8+ hex characters.',
      mimeType: 'text/markdown',
    },
    async (uri, variables, extra) => {
      const raw = variables.id
      const id = Array.isArray(raw) ? raw[0] : raw
      const notFound = () => new McpError(RESOURCE_NOT_FOUND, `Resource not found or not visible to you: ${uri.toString().slice(0, 200)}`)
      if (typeof id !== 'string' || !/^[0-9a-fA-F-]{8,36}$/.test(id)) throw notFound()
      const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers
      const res = (await handlers.get('tools/call')!({ method: 'tools/call', params: { name: 'read_page', arguments: { pageId: id } } }, extra)) as CallToolResult
      const body = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n')
      if (res.isError) {
        if (/not found|not visible|no page you can see|is not a page id/i.test(body)) throw notFound()
        throw new McpError(-32603, body.replace(/^Error: /, '').slice(0, 500))
      }
      return { contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: body }] }
    },
  )
}
