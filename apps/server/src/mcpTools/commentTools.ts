import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { CommentDTO } from '@inkling/shared'
import { findSection, splitSections } from '../context/chunker'
import type { Section } from '../context/chunker'
import { db } from '../db/index'
import { comments, pageDocs, pages } from '../db/schema'
import { stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { call, json, text, ToolError, uuid, wrap, wrapWrite } from './core'
import type { ToolCtx } from './core'
import { attr, cleanText, wrapUntrusted } from './trust'

/**
 * Comment thread tools (docs/adr/1006-*): list_comments, add_comment (with a section anchor),
 * reply_comment, resolve_comment. Every call goes through the REST comment routes as the token
 * user, so visibility, membership, the edit lock's COMMENT bit for agents (docs/adr/0970-*) and the
 * "agents resolve only their person's threads" rule apply unchanged. Threads are mapped to
 * sections with the same anchors as read_page / find_context.
 */

interface DocMap {
  blocks: AnyBlock[]
  sections: Section[]
  /** block id (any depth) → section anchor */
  anchorOf: Map<string, string>
}

async function docMap(pageId: string): Promise<DocMap> {
  const row = (await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, pageId)).limit(1))[0]
  const blocks = row ? stateToBlocks(row.state) : []
  const sections = splitSections(blocks)
  const anchorOf = new Map<string, string>()
  const mark = (b: AnyBlock, anchor: string) => {
    if (typeof b.id === 'string') anchorOf.set(b.id, anchor)
    for (const c of (b.children ?? []) as AnyBlock[]) mark(c, anchor)
  }
  for (const s of sections) for (let i = s.start; i < s.end; i++) mark(blocks[i], s.anchor)
  return { blocks, sections, anchorOf }
}

function sectionOrError(map: DocMap, ref: string): Section {
  const s = findSection(map.sections, ref)
  if (!s) {
    const list = map.sections.map((x) => `§${x.anchor}`).slice(0, 30).join(', ')
    throw new ToolError(`Section "${ref}" not found; current sections: ${list || '(none)'}; use read_page(outline=true)`)
  }
  return s
}

const minute = (iso: string) => `${iso.slice(0, 16)}Z`

export function formatThreads(
  page: { id: string; title: string },
  list: CommentDTO[],
  anchorOf: Map<string, string>,
  opts: { status: 'open' | 'resolved' | 'all'; section: string | null },
): string {
  const threads = new Map<string, { root: CommentDTO | null; replies: CommentDTO[] }>()
  for (const c of list) {
    const t = threads.get(c.threadId) ?? { root: null, replies: [] }
    if (c.id === c.threadId) t.root = c
    else t.replies.push(c)
    threads.set(c.threadId, t)
  }
  const out: string[] = []
  let n = 0
  for (const [threadId, t] of threads) {
    if (!t.root) continue
    const resolved = t.root.resolved
    if (opts.status === 'open' && resolved) continue
    if (opts.status === 'resolved' && !resolved) continue
    const anchor = anchorOf.get(t.root.blockId) ?? null
    if (opts.section !== null && anchor !== opts.section) continue
    const by = (c: CommentDTO) => `${cleanText(c.author.name)}${c.viaClient ? ` (via ${attr(c.viaClient)})` : ''}`
    const body = [t.root, ...t.replies]
      .map((c, i) => `${i === 0 ? '' : '  ↳ '}${c.author.name}${c.viaClient ? ` (via ${c.viaClient})` : ''}: ${c.body}`)
      .join('\n')
    out.push(
      `t:${threadId} | ${anchor ? `§${attr(anchor)}` : '§(detached)'} | ${resolved ? 'resolved' : 'open'} | ${by(t.root)} | ` +
        `${t.replies.length} repl${t.replies.length === 1 ? 'y' : 'ies'} | ${minute(t.root.createdAt)}`,
      wrapUntrusted(body, { source: 'comments', id: threadId }),
    )
    n++
  }
  const scope = `${opts.status}${opts.section !== null ? `, §${attr(opts.section)}` : ''}`
  return [`comments: page ${page.id} "${cleanText(page.title.trim() || 'Untitled')}" · ${n} thread(s) (${scope})`, ...out].join('\n')
}

export function registerCommentTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description:
        'Comment threads of a page, one line per thread (t:<threadId> | §section | open/resolved | author (via client) | replies) ' +
        'followed by the thread text as untrusted data. status: open (default), resolved or all; section: only threads ' +
        'anchored in that section (§anchor, heading text or path, as in read_page outline). People review AI edits here: ' +
        'read open threads before editing a page you were asked to fix.',
      inputSchema: {
        pageId: uuid().describe('Page id'),
        section: z.string().trim().min(1).max(500).optional().describe('Only threads in this section'),
        status: z.enum(['open', 'resolved', 'all']).optional().describe('Default open'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ pageId, section, status }) => {
      const res = await call(ctx, 'GET', `/api/pages/${pageId}/comments`)
      const list = (res.json() as { comments: CommentDTO[] }).comments
      const map = await docMap(pageId)
      const sec = section ? sectionOrError(map, section).anchor : null
      const [p] = await db.select({ title: pages.title }).from(pages).where(eq(pages.id, pageId)).limit(1)
      return text(formatThreads({ id: pageId, title: p?.title ?? '' }, list, map.anchorOf, { status: status ?? 'open', section: sec }))
    }),
  )

  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description:
        'Start a new comment thread on a page. With section (§anchor, heading text or path) it is anchored to that ' +
        "section's heading; otherwise to the page's first block. Use it to leave a suggestion when you may not edit (see " +
        'the can: line of read_page). text (or body) is plain text.',
      inputSchema: {
        pageId: uuid().describe('Page id (kind=doc)'),
        text: z.string().trim().min(1).max(4000).optional().describe('Comment text'),
        body: z.string().trim().min(1).max(4000).optional().describe('Same as text (older name)'),
        section: z.string().trim().min(1).max(500).optional().describe('Anchor the thread to this section'),
      },
    },
    wrapWrite(ctx, async ({ pageId, text: t, body, section }) => {
      const message = t ?? body
      if (!message) throw new ToolError('text is required')
      // Check permissions (visibility + membership) first; read the document only after that passes.
      await call(ctx, 'GET', `/api/pages/${pageId}/comments`)
      const map = await docMap(pageId)
      let blockId: string | undefined
      let anchor: string | null = null
      if (section) {
        const s = sectionOrError(map, section)
        blockId = map.blocks[s.start]?.id as string | undefined
        anchor = s.anchor
      } else {
        blockId = map.blocks[0]?.id as string | undefined
      }
      if (!blockId) throw new ToolError("Can't comment on a page with an empty body")
      const r = await call(ctx, 'POST', `/api/pages/${pageId}/comments`, { json: { blockId, body: message } })
      const c = (r.json() as { comment: { id: string } }).comment
      return json(anchor ? { id: c.id, threadId: c.id, pageId, section: anchor } : { id: c.id, threadId: c.id, pageId })
    }),
  )

  server.registerTool(
    'reply_comment',
    {
      title: 'Reply to comment thread',
      description: 'Reply in an existing comment thread (threadId = the t:<id> of list_comments, or a comment id from add_comment).',
      inputSchema: {
        threadId: uuid().describe('Thread id'),
        text: z.string().trim().min(1).max(4000).describe('Reply text'),
      },
    },
    wrapWrite(ctx, async ({ threadId, text: message }) => {
      // Only the page id is looked up here; the REST route checks visibility, membership and the lock.
      // A thread on a page the caller cannot see gets the same answer as a missing one (that route
      // answers 404), so the tool does not tell which thread ids exist elsewhere (docs/adr/1301-*).
      const notFound = () => new ToolError('Thread not found: use list_comments(pageId) for thread ids')
      const [root] = await db
        .select({ pageId: comments.pageId, blockId: comments.blockId })
        .from(comments)
        .where(and(eq(comments.id, threadId), eq(comments.threadId, threadId)))
        .limit(1)
      if (!root) throw notFound()
      const r = await call(ctx, 'POST', `/api/pages/${root.pageId}/comments`, {
        json: { blockId: root.blockId, threadId, body: message },
        passStatuses: [404],
      })
      if (r.statusCode === 404) throw notFound()
      const c = (r.json() as { comment: { id: string } }).comment
      return json({ id: c.id, threadId, pageId: root.pageId })
    }),
  )

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve comment thread',
      description:
        'Mark a thread resolved (or reopen it with resolved=false). Agents can resolve only threads started by the person ' +
        'they act for; for anyone else\'s thread, reply with what you did and let a person resolve it.',
      inputSchema: {
        threadId: uuid().describe('Thread id'),
        resolved: z.boolean().optional().describe('Default true'),
      },
    },
    wrapWrite(ctx, async ({ threadId, resolved }) => {
      const value = resolved ?? true
      await call(ctx, 'PATCH', `/api/comments/${threadId}`, { json: { resolved: value } })
      return text(value ? 'Thread resolved.' : 'Thread reopened.')
    }),
  )
}
