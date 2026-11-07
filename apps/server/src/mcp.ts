import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { PageMetaDTO, PageProperty, TemplateDTO, WorkspaceDTO } from '@inkling/shared'
import type { AuthUser } from './auth'
import { db } from './db/index'
import { pageDocs, pages } from './db/schema'
import { stateToBlocks, stripFrontmatter } from './md/convert'
import {
  getBearerUser,
  MCP_INTERNAL_HEADER,
  MCP_INTERNAL_SECRET,
  publicOrigin,
  readBearer,
} from './oauth'
import { findVisiblePage } from './pageDto'

/**
 * Inkling remote MCP server (Streamable HTTP, stateless: a new server/transport per request).
 *
 * Authentication: OAuth 2.1 access token (Authorization: Bearer). Missing or invalid -> 401 +
 *   WWW-Authenticate(resource_metadata=…) so the client starts the OAuth flow.
 * Authorization: every tool calls the existing /api REST routes via app.inject as "the token's user",
 *   so workspace membership and 🔒 private-page visibility checks are 100% identical to the web app.
 *   inject carries the original client IP (remoteAddress) so rate limiting doesn't pile into one bucket.
 * Tools for permanent deletion, member management or public sharing are intentionally absent (trash only).
 */

interface ToolCtx {
  app: FastifyInstance
  token: string
  ip: string
  user: AuthUser
  origin: string
}

class ToolError extends Error {}

interface InjectOpts {
  json?: unknown
  payload?: Buffer
  headers?: Record<string, string>
  query?: Record<string, string>
}

/** Call an existing REST route as the token user; 4xx/5xx become a ToolError carrying the server message */
async function call(ctx: ToolCtx, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: InjectOpts = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.token}`,
    [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET,
    ...opts.headers,
  }
  let payload: string | Buffer | undefined = opts.payload
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(opts.json)
  }
  const res = await ctx.app.inject({
    method,
    url,
    query: opts.query,
    headers,
    payload,
    remoteAddress: ctx.ip,
  })
  if (res.statusCode >= 400) {
    let message = `Request failed (HTTP ${res.statusCode})`
    try {
      const body = res.json() as { error?: { message?: string; code?: string } }
      if (body?.error?.message) message = `${body.error.message} (${body.error.code ?? res.statusCode})`
    } catch {
      // Body is not JSON: keep the default message
    }
    if (res.statusCode === 404) message = `${message}: the page/workspace does not exist or you don't have access`
    throw new ToolError(message)
  }
  return res
}

function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] }
}
function json(v: unknown): CallToolResult {
  return text(JSON.stringify(v))
}

/** Tool handler wrapper: turns ToolError/validation errors into an isError result */
function wrap<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args)
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : 'Internal server error'
      if (!(err instanceof ToolError)) console.error('[inkling] MCP tool error', err)
      return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] }
    }
  }
}

const sectionOf = (p: PageMetaDTO) => (p.scope === 'private' ? 'private' : 'shared')
const titleOf = (p: { title: string }) => p.title || 'Untitled'
const pageUrl = (ctx: ToolCtx, p: { workspaceId: string; id: string }) =>
  `${ctx.origin}/w/${p.workspaceId}/p/${p.id}`

/** Page title -> import filename (strips path separators, quotes and control characters) */
function safeFilenameTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const s = title.replace(/[/\\"\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s || 'Untitled'
}

function multipartMd(filenameTitle: string, markdown: string): { payload: Buffer; contentType: string } {
  const boundary = `----inkling${randomBytes(12).toString('hex')}`
  const encoded = encodeURIComponent(`${filenameTitle}.md`)
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filenameTitle}.md"; filename*=UTF-8''${encoded}\r\n` +
    `Content-Type: text/markdown\r\n\r\n`
  const payload = Buffer.concat([
    Buffer.from(head, 'utf8'),
    Buffer.from(markdown, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ])
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` }
}

const uuid = () => z.uuid()

function buildServer(ctx: ToolCtx): McpServer {
  const server = new McpServer(
    { name: 'inkling', version: '1.0.0' },
    {
      instructions:
        'Read and write my notes in Inkling (a self-hosted notes app). First get a workspace id with list_workspaces, ' +
        'find page ids with list_pages/search, then read them with read_page. Upload a whole local folder at once with import_folder. Page bodies are Markdown and ' +
        '[[Page title]] becomes an internal wiki link. Deleting is limited to moving pages to the trash (trash_page).',
    },
  )

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description: 'Inkling workspaces I am a member of (id, name, role).',
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      const res = await call(ctx, 'GET', '/api/workspaces')
      const { workspaces } = res.json() as { workspaces: WorkspaceDTO[] }
      return json(workspaces.map((w) => ({ id: w.id, name: w.name, icon: w.icon, role: w.role })))
    }),
  )

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description:
        "The workspace's page tree (excluding trash). Each item: id, title, kind (doc/folder/canvas/collection), parentId, " +
        'section (shared/private; private pages are visible only to me), path (ancestor path), children (child count). ' +
        "With parentId, returns only that page's direct children; with 'root', only top-level pages.",
      inputSchema: {
        workspaceId: uuid().describe('Workspace id (from list_workspaces)'),
        parentId: z
          .string()
          .optional()
          .describe("Only the direct children of this page; 'root' for top-level pages only"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ workspaceId, parentId }) => {
      const res = await call(ctx, 'GET', `/api/workspaces/${workspaceId}/pages`)
      const { pages: all } = res.json() as { pages: PageMetaDTO[] }
      const byId = new Map(all.map((p) => [p.id, p]))
      const childCount = new Map<string, number>()
      for (const p of all) {
        if (p.parentId) childCount.set(p.parentId, (childCount.get(p.parentId) ?? 0) + 1)
      }
      const pathOf = (p: PageMetaDTO): string => {
        const parts: string[] = []
        let cur = p.parentId ? byId.get(p.parentId) : undefined
        for (let i = 0; cur && i < 50; i++) {
          parts.unshift(titleOf(cur))
          cur = cur.parentId ? byId.get(cur.parentId) : undefined
        }
        return parts.join(' / ')
      }
      let list = all
      if (parentId === 'root') list = all.filter((p) => !p.parentId)
      else if (parentId) list = all.filter((p) => p.parentId === parentId)
      const LIMIT = 500
      const out = list.slice(0, LIMIT).map((p) => ({
        id: p.id,
        title: titleOf(p),
        kind: p.kind,
        parentId: p.parentId,
        section: sectionOf(p),
        path: pathOf(p),
        children: childCount.get(p.id) ?? 0,
      }))
      const note = list.length > LIMIT ? { truncated: true, total: list.length } : undefined
      return json(note ? { pages: out, ...note } : { pages: out })
    }),
  )

  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Full-text search over page titles and bodies (substring match). Omit workspaceId to search all my workspaces. ' +
        'Body matches include a snippet. Up to 20 results per workspace.',
      inputSchema: {
        query: z.string().min(1).max(200).describe('Search query'),
        workspaceId: uuid().optional().describe('Limit to one workspace'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ query, workspaceId }) => {
      let wsIds: string[]
      if (workspaceId) wsIds = [workspaceId]
      else {
        const res = await call(ctx, 'GET', '/api/workspaces')
        wsIds = (res.json() as { workspaces: WorkspaceDTO[] }).workspaces.map((w) => w.id)
      }
      const results: unknown[] = []
      for (const ws of wsIds) {
        const res = await call(ctx, 'GET', `/api/workspaces/${ws}/search`, { query: { q: query } })
        const { pages: found } = res.json() as { pages: (PageMetaDTO & { snippet?: string })[] }
        for (const p of found) {
          results.push({
            id: p.id,
            workspaceId: p.workspaceId,
            title: titleOf(p),
            kind: p.kind,
            section: sectionOf(p),
            ...(p.snippet ? { snippet: p.snippet } : {}),
          })
        }
      }
      return json({ results })
    }),
  )

  server.registerTool(
    'read_page',
    {
      title: 'Read page',
      description:
        "Read a page's body as Markdown (child pages not included). Internal links are [[Title]], attachments /files/<id>. " +
        'Collections (databases) are returned as a table of rows, canvases as JSON Canvas.',
      inputSchema: { pageId: uuid().describe('Page id') },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ pageId }) => {
      // The export route does the permission check (visibility + membership); metadata is attached only after it passes.
      const res = await call(ctx, 'GET', `/api/pages/${pageId}/export`, { query: { format: 'md' } })
      const meta = await findVisiblePage(pageId, ctx.user.id)
      if (!meta) throw new ToolError('Page not found')
      const propsRow = (
        await db
          .select({ properties: pages.properties })
          .from(pages)
          .where(eq(pages.id, pageId))
          .limit(1)
      )[0]
      const properties = (Array.isArray(propsRow?.properties) ? (propsRow.properties as PageProperty[]) : [])
        .filter((p) => p && p.id !== 'fullWidth')
        .map((p) => ({ name: p.name, type: p.type, value: p.value ?? null }))
      const body = meta.kind === 'canvas' ? res.body : stripFrontmatter(res.body)
      const header = [
        `# ${titleOf(meta)}`,
        '',
        `- id: ${meta.id}`,
        `- workspaceId: ${meta.workspaceId}`,
        `- parentId: ${meta.parentId ?? '(top level)'}`,
        `- kind: ${meta.kind}`,
        `- section: ${meta.scope === 'private' ? 'private' : 'shared'}`,
        `- updatedAt: ${meta.updatedAt.toISOString()}`,
        `- url: ${pageUrl(ctx, meta)}`,
        ...(properties.length ? [`- properties: ${JSON.stringify(properties)}`] : []),
        '',
        '---',
        '',
      ].join('\n')
      return text(header + body)
    }),
  )

  server.registerTool(
    'create_page',
    {
      title: 'Create page',
      description:
        'Create a new document page from Markdown. With parentId it goes under that page (inheriting its section); ' +
        'otherwise at the top level of the shared section (or the private section if private=true). ' +
        '[[Other page title]] becomes a wiki link.',
      inputSchema: {
        workspaceId: uuid().describe('Workspace id'),
        title: z.string().trim().min(1).max(300).describe('Page title'),
        markdown: z.string().max(1_000_000).describe('Body Markdown (no need to include a title heading)'),
        parentId: uuid().optional().describe('Parent page id'),
        private: z.boolean().optional().describe('Create at the top level of the private (🔒) section (only without parentId)'),
      },
    },
    wrap(async ({ workspaceId, title, markdown, parentId, private: isPrivate }) => {
      if (isPrivate && parentId) {
        throw new ToolError('private can only be used when creating a top-level page without parentId (child pages follow their parent section)')
      }
      const fileTitle = safeFilenameTitle(title)
      const { payload, contentType } = multipartMd(fileTitle, markdown)
      const res = await call(ctx, 'POST', `/api/workspaces/${workspaceId}/import`, {
        payload,
        headers: { 'content-type': contentType },
        query: parentId ? { parentId } : undefined,
      })
      const created = (res.json() as { pages: PageMetaDTO[] }).pages[0]
      if (!created) throw new ToolError('Could not create the page')
      let page = created
      // If the title had characters a filename can't carry (/ etc.), restore the real title; move to the private section if requested
      const patch: Record<string, unknown> = {}
      if (created.title !== title) patch.title = title
      if (isPrivate) patch.scope = 'private'
      if (Object.keys(patch).length) {
        const r = await call(ctx, 'PATCH', `/api/pages/${created.id}`, { json: patch })
        page = (r.json() as { page: PageMetaDTO }).page
      }
      return json({
        id: page.id,
        workspaceId: page.workspaceId,
        title: page.title,
        parentId: page.parentId,
        section: sectionOf(page),
        url: pageUrl(ctx, page),
      })
    }),
  )

  server.registerTool(
    'import_folder',
    {
      title: 'Import folder',
      description:
        "Upload a local folder's Markdown files in one go, keeping the directory structure. Folders become folder pages, .md files become document pages. " +
        'folderName becomes the title of the top-level folder page; files[].path is the path relative to it (e.g. "notes/day1.md"). ' +
        'Non-.md files are ignored. Up to 300 files, 50 MB total. With parentId, the folder is created under that page.',
      inputSchema: {
        workspaceId: uuid().describe('Workspace id'),
        folderName: z.string().trim().min(1).max(300).describe('Title of the top-level folder page (usually the local folder name)'),
        files: z
          .array(
            z.object({
              path: z.string().trim().min(1).max(1000).describe('Path relative to folderName, ending in .md'),
              markdown: z.string().max(1_000_000).describe('File contents'),
            }),
          )
          .min(1)
          .max(300)
          .describe('Files to upload'),
        parentId: uuid().optional().describe('Parent page id'),
      },
    },
    wrap(async ({ workspaceId, folderName, files, parentId }) => {
      const root = safeFilenameTitle(folderName)
      const boundary = `----inkling${randomBytes(12).toString('hex')}`
      const chunks: Buffer[] = []
      let count = 0
      for (const f of files) {
        const segs = f.path.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.')
        if (segs.length === 0 || segs.includes('..')) throw new ToolError(`Invalid path: ${f.path}`)
        if (!/\.md$/i.test(segs[segs.length - 1])) continue
        const rel = encodeURIComponent([root, ...segs].join('/'))
        chunks.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${rel}"\r\n` +
              `Content-Type: text/markdown\r\n\r\n`,
            'utf8',
          ),
          Buffer.from(f.markdown, 'utf8'),
          Buffer.from('\r\n', 'utf8'),
        )
        count++
      }
      if (count === 0) throw new ToolError('No .md files')
      chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
      const res = await call(ctx, 'POST', `/api/workspaces/${workspaceId}/import-folder`, {
        payload: Buffer.concat(chunks),
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        query: parentId ? { parentId } : undefined,
      })
      const pages = (res.json() as { pages: PageMetaDTO[] }).pages
      const top = pages.find((p) => p.parentId === (parentId ?? null)) ?? pages[0]
      return json({
        created: pages.length,
        root: top ? { id: top.id, title: top.title, url: pageUrl(ctx, top) } : null,
        pages: pages.map((p) => ({ id: p.id, title: p.title, parentId: p.parentId })),
      })
    }),
  )

  server.registerTool(
    'update_page',
    {
      title: 'Update page body',
      description:
        "Edit a document page's body with Markdown. mode='append' adds to the end, 'replace' replaces everything " +
        '(the state right before the replace is kept as a snapshot in version history). Changes show live to anyone viewing the page.',
      inputSchema: {
        pageId: uuid().describe('Page id (kind=doc)'),
        markdown: z.string().max(1_000_000).describe('Markdown'),
        mode: z.enum(['append', 'replace']).describe('append = add to the end, replace = replace the whole body'),
      },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ pageId, markdown, mode }) => {
      await call(ctx, 'POST', `/api/pages/${pageId}/content`, { json: { markdown, mode } })
      return text(
        mode === 'append'
          ? 'Appended to the end of the body.'
          : 'Replaced the body (the previous content is saved as a version-history snapshot).',
      )
    }),
  )

  server.registerTool(
    'rename_page',
    {
      title: 'Rename page',
      description: "Change a page's title.",
      inputSchema: {
        pageId: uuid().describe('Page id'),
        title: z.string().trim().min(1).max(300).describe('New title'),
      },
    },
    wrap(async ({ pageId, title }) => {
      const r = await call(ctx, 'PATCH', `/api/pages/${pageId}`, { json: { title } })
      const page = (r.json() as { page: PageMetaDTO }).page
      return json({ id: page.id, title: page.title })
    }),
  )

  server.registerTool(
    'move_page',
    {
      title: 'Move page',
      description:
        'Move a page (and everything under it) under another parent page in the same workspace, or to the top level (parentId=null). ' +
        'The page and its new parent must be in the same section (shared/private). When moving to the top level, section can switch shared/private. ' +
        'Pages cannot be moved to another workspace.',
      inputSchema: {
        pageId: uuid().describe('Id of the page to move'),
        parentId: uuid().nullable().describe('New parent page id, or null for the top level'),
        section: z.enum(['shared', 'private']).optional().describe('Section (shared/private) when moving to the top level'),
      },
    },
    wrap(async ({ pageId, parentId, section }) => {
      const body: Record<string, unknown> = { parentId }
      if (section) {
        if (parentId) throw new ToolError('section can only be set when moving to the top level (parentId=null)')
        body.scope = section
      }
      const r = await call(ctx, 'PATCH', `/api/pages/${pageId}`, { json: body })
      const page = (r.json() as { page: PageMetaDTO }).page
      return json({ id: page.id, title: titleOf(page), parentId: page.parentId, section: sectionOf(page) })
    }),
  )

  server.registerTool(
    'trash_page',
    {
      title: 'Move to trash',
      description:
        'Move a page (and everything under it) to the trash. It can be restored from the trash in the web app and is permanently deleted after 30 days. ' +
        'There is no permanent-delete tool.',
      inputSchema: { pageId: uuid().describe('Page id') },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ pageId }) => {
      await call(ctx, 'DELETE', `/api/pages/${pageId}`)
      return text('Moved to the trash (restorable from the trash in the web app; permanently deleted after 30 days).')
    }),
  )

  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description: "Start a new comment thread on a page. The comment is anchored to the page's first block.",
      inputSchema: {
        pageId: uuid().describe('Page id (kind=doc)'),
        body: z.string().trim().min(1).max(4000).describe('Comment text'),
      },
    },
    wrap(async ({ pageId, body }) => {
      // Check permissions (visibility + membership) first; read the document only after that passes.
      await call(ctx, 'GET', `/api/pages/${pageId}/comments`)
      const row = (
        await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, pageId)).limit(1)
      )[0]
      const blockId = row ? stateToBlocks(row.state)[0]?.id : undefined
      if (!blockId) throw new ToolError("Can't comment on a page with an empty body")
      const r = await call(ctx, 'POST', `/api/pages/${pageId}/comments`, { json: { blockId, body } })
      const c = (r.json() as { comment: { id: string } }).comment
      return json({ id: c.id, pageId })
    }),
  )

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description:
        'Page templates I can use in a workspace: built-ins (id = key such as "project", "meeting") and the workspace\'s ' +
        'custom templates (id = uuid; private ones only if I created them). kind=structure templates create a page tree ' +
        '(sub-pages, collections, canvases). inputs are the {{input:…}} questions create_from_template can answer.',
      inputSchema: { workspaceId: uuid().describe('Workspace id') },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ workspaceId }) => {
      const res = await call(ctx, 'GET', `/api/workspaces/${workspaceId}/templates`)
      const { templates } = res.json() as { templates: TemplateDTO[] }
      return json(
        templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          category: t.category,
          kind: t.kind,
          pages: t.pageCount,
          builtin: t.builtin,
          section: t.scope,
          withDate: t.withDate,
          inputs: t.inputs,
        })),
      )
    }),
  )

  server.registerTool(
    'create_from_template',
    {
      title: 'Create from template',
      description:
        'Create a page (or a page tree, for structure templates) from a template returned by list_templates. Variables such as ' +
        '{{date}}, {{author}} and {{title}} are filled in by the server; answer {{input:…}} questions with inputs ' +
        '(question → answer; unanswered ones use their default). With parentId the pages go under that page (inheriting its section); ' +
        'otherwise at the top level of the shared section (or the private section if private=true).',
      inputSchema: {
        workspaceId: uuid().describe('Workspace id'),
        template: z.string().trim().min(1).max(64).describe('Template id from list_templates (built-in key or uuid)'),
        title: z.string().trim().max(300).optional().describe('Title of the created root page (default: the template title)'),
        parentId: uuid().optional().describe('Parent page id'),
        private: z.boolean().optional().describe('Create at the top level of the private (🔒) section (only without parentId)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Date for {{date}} and dated templates (YYYY-MM-DD, default today)'),
        inputs: z.record(z.string().max(200), z.string().max(2000)).optional().describe('Answers to the template inputs'),
      },
    },
    wrap(async ({ workspaceId, template, title, parentId, private: isPrivate, date, inputs }) => {
      if (isPrivate && parentId) {
        throw new ToolError('private can only be used when creating at the top level without parentId (child pages follow their parent section)')
      }
      const isUuid = uuid().safeParse(template).success
      const res = await call(ctx, 'POST', '/api/pages/from-template', {
        json: {
          workspaceId,
          ...(isUuid ? { templateId: template } : { builtinKey: template }),
          ...(title ? { title } : {}),
          ...(parentId ? { parentId } : {}),
          ...(isPrivate ? { scope: 'private' } : {}),
          ...(date ? { date } : {}),
          ...(inputs ? { inputs } : {}),
        },
      })
      const { page, pages } = res.json() as { page: PageMetaDTO; pages: PageMetaDTO[] }
      return json({
        id: page.id,
        title: page.title,
        section: sectionOf(page),
        url: pageUrl(ctx, page),
        created: pages.length,
        pages: pages.map((p) => ({ id: p.id, title: titleOf(p), kind: p.kind, parentId: p.parentId })),
      })
    }),
  )

  return server
}

// ---------------------------------------------------------------------------
// /mcp route
// ---------------------------------------------------------------------------

export async function registerMcpRoutes(scope: FastifyInstance, rootApp: FastifyInstance): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = publicOrigin(req)
    const token = readBearer(req.headers.authorization)
    const user = token ? await getBearerUser(token) : null
    if (!token || !user) {
      const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`
      return reply
        .code(401)
        .header(
          'WWW-Authenticate',
          `Bearer resource_metadata="${metadata}"${token !== null ? ', error="invalid_token"' : ''}`,
        )
        .send({
          error: token !== null ? 'invalid_token' : 'unauthorized',
          error_description: 'Sign-in required (OAuth access token)',
        })
    }

    // Stateless mode: there is no server-to-client SSE stream (GET) and no session termination (DELETE).
    if (req.method !== 'POST') {
      return reply
        .code(405)
        .header('Allow', 'POST')
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
    }

    const server = buildServer({ app: rootApp, token, ip: req.ip, user, origin })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    // From here the transport writes the raw response, so copy headers set by hooks (CORS etc.) first.
    reply.hijack()
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) reply.raw.setHeader(k, v as string | number | string[])
    }
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req.raw, reply.raw, req.body)
    } catch (err) {
      req.log.error(err)
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500
        reply.raw.setHeader('content-type', 'application/json')
        reply.raw.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }),
        )
      }
    }
  }

  // import_folder sends many files at once; the default 1 MB limit overflows even for small folders
  scope.post('/mcp', { bodyLimit: 12 * 1024 * 1024 }, handler)
  scope.get('/mcp', handler)
  scope.delete('/mcp', handler)
}
