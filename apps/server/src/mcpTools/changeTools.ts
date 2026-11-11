import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { FEED_MAX_BUDGET, FEED_MIN_BUDGET } from '../context/changeFeed'
import type { FeedResult } from '../context/changeFeed'
import { CHANGE_WAIT_MAX_SEC, changeMark, waitForChanges } from '../context/changeWait'
import { noteWait } from '../connectionUsage'
import { db } from '../db/index'
import { workspaceMembers } from '../db/schema'
import { call, text, wrap, idArg } from './core'
import type { ToolCtx } from './core'

/** Said when a wait could not be granted (limits, shutdown): the answer is the plain read. */
export const WAIT_SKIPPED_LINE =
  'wait skipped: the server has too many waiting calls right now (or is restarting); call again in a few seconds'

/**
 * Long-poll (docs/adr/1551-*): `first` came back empty for `cursor`; wait for a change in the
 * caller's workspaces and read again, until something comes back or `waitSec` is over. The wait is
 * reported to the usage frame so it does not count as latency (docs/adr/1552-*).
 */
async function readWithWait(
  ctx: ToolCtx,
  read: (cursor: string) => Promise<FeedResult>,
  first: FeedResult,
  mark: number,
  workspaces: string[],
  waitSec: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const until = Date.now() + waitSec * 1000
  const conn = ctx.user.grantId ?? `user:${ctx.user.id}`
  let r = first
  let m = mark
  for (;;) {
    const t0 = Date.now()
    const waiting = waitForChanges({ conn, workspaces, mark: m, until, signal })
    if (!waiting) return `${WAIT_SKIPPED_LINE}\n${r.text}`
    const outcome = await waiting
    noteWait(Date.now() - t0)
    if (outcome !== 'changed') return r.text
    m = changeMark(workspaces)
    r = await read(r.cursor)
    if (r.status !== 'ok' || r.changes > 0 || r.more || Date.now() >= until) return r.text
  }
}

/** Change feed tool (docs/adr/0932-*): changes_since. Calls GET /api/changes as the token user. */
export function registerChangeTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'changes_since',
    {
      title: 'Changes since',
      description:
        'What changed in your notes since a cursor, as compact diffs per section (added text, -/+ lines, removed, ' +
        'renamed, moved; page renames, moves, trash, visibility; new collections and rows, row property changes), with ' +
        'who/which agent made them. ' +
        'Without a cursor it only returns the current cursor: store it. In a later session call changes_since(cursor) ' +
        'and update only what changed instead of re-reading pages; every call returns the next cursor to store ' +
        '(always the last line). Output fits a token budget (default 3000, max 12000); entries that do not fit are ' +
        'listed without detail.',
      inputSchema: {
        cursor: z.string().trim().min(1).max(200).optional().describe('Cursor from a previous call (omit to start tracking)'),
        workspaceId: idArg('workspace').optional().describe('Limit to one workspace (keep using the same value with its cursors)'),
        budget: z
          .number()
          .int()
          .min(FEED_MIN_BUDGET)
          .max(FEED_MAX_BUDGET)
          .optional()
          .describe('Max tokens to return (default 3000)'),
        detail: z
          .enum(['none', 'diff', 'full'])
          .optional()
          .describe("'diff' (default): -/+ lines; 'full': whole new section text; 'none': one line per change"),
        wait: z
          .number()
          .int()
          .min(0)
          .max(CHANGE_WAIT_MAX_SEC)
          .optional()
          .describe(
            `With a cursor: if nothing changed yet, wait up to this many seconds (max ${CHANGE_WAIT_MAX_SEC}) and return as soon ` +
              'as something changes; empty at the end. Use instead of calling again in a loop.',
          ),
      },
    },
    async (args, extra) =>
      wrap(async ({ cursor, workspaceId, budget, detail, wait }: typeof args) => {
        const read = async (c: string | undefined) => {
          const query: Record<string, string> = {}
          if (c) query.cursor = c
          if (workspaceId) query.workspaceId = workspaceId
          if (budget) query.budget = String(budget)
          if (detail) query.detail = detail
          return (await call(ctx, 'GET', '/api/changes', { query })).json() as FeedResult
        }
        if (!wait || !cursor) return text((await read(cursor)).text)
        // Workspaces a change may come from (a superset is fine: a wake-up only means "read again").
        const workspaces = workspaceId
          ? [workspaceId]
          : (await db.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, ctx.user.id))).map((r) => r.id)
        // The mark comes before the read: a change committed after it ends the wait at once.
        const mark = changeMark(workspaces)
        const first = await read(cursor)
        if (first.status !== 'ok' || first.changes > 0 || first.more) return text(first.text)
        return text(await readWithWait(ctx, read, first, mark, workspaces, wait, extra?.signal))
      })(args),
  )
}
