import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CATCH_UP_DEFAULT_BUDGET, CATCH_UP_MAX_BUDGET, CATCH_UP_MIN_BUDGET, parseSince } from '../catchUp'
import type { CatchUpResult } from '../catchUp'
import { call, text, wrap, idArg } from './core'
import type { ToolCtx } from './core'
import { cursorArg } from './changeTools'

/**
 * A since time after the server's clock matches nothing (the route counts from now): say so on the
 * first line, so an agent does not report "nobody changed anything" (0.24.1). A date or a time
 * without a zone is UTC (parseSince), which is how a local date ends up in the future.
 */
export function futureSinceNote(since: string, nowMs = Date.now()): string | null {
  let at: number
  try {
    const s = parseSince(since)
    if (s.kind !== 'time') return null
    at = s.at
  } catch {
    return null // the route answers INVALID_SINCE
  }
  if (at <= nowMs) return null
  return `note: since is in the future (server time ${new Date(nowMs).toISOString().slice(0, 16)}Z, UTC); nothing can match\n`
}

/**
 * catch_up (docs/adr/1520-*): one call answers "what happened while I was away". Calls
 * GET /api/catch-up as the token user, so membership, visibility, 2FA, agent blocks and the
 * connection range are the REST route's.
 */
export function registerCatchUpTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'catch_up',
    {
      title: 'Catch up',
      description:
        'What happened while you were away, in one call, most important first: mentions/replies/assignments for the person ' +
        'you act for, tasks due within 7 days (and overdue), due Later reminders, new comment threads and replies, then ' +
        'pages changed by others (who, via which agent, how many edits, section diffs; new, trashed, moved pages), then ' +
        'your own changes. Without since it continues from this connection\'s last catch_up (or the last 24 hours). ' +
        'Material for your summary: the server does not summarize. It acknowledges nothing (use inbox/ack) and is not a ' +
        `sync cursor (use changes_since). Output fits a token budget (default ${CATCH_UP_DEFAULT_BUDGET}); the last line is the next since.`,
      inputSchema: {
        workspaceId: idArg('workspace').optional().describe('Limit to one workspace (its own "last catch_up" marker)'),
        since: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('A previous catch_up or changes_since cursor, or a time, UTC unless zoned (2026-11-08T09:00Z); omit to continue from the last catch_up'),
        budget: z
          .number()
          .int()
          .min(CATCH_UP_MIN_BUDGET)
          .max(CATCH_UP_MAX_BUDGET)
          .optional()
          .describe(`Max tokens to return (default ${CATCH_UP_DEFAULT_BUDGET})`),
        peek: z.boolean().optional().describe('true: do not move this connection\'s "last catch_up" marker'),
        team: z.boolean().optional().describe("true: also others' section claims and what each person's agents did"),
      },
    },
    wrap(async ({ workspaceId, since: sinceRaw, budget, peek, team }) => {
      // the whole printed line (`next since: … (up to …)`) is the same since (0.24.1)
      const since = cursorArg(sinceRaw)
      const query: Record<string, string> = {}
      if (workspaceId) query.workspaceId = workspaceId
      if (since) query.since = since
      if (budget) query.budget = String(budget)
      if (peek) query.advance = '0'
      if (team) query.team = '1'
      const res = await call(ctx, 'GET', '/api/catch-up', { query })
      const out = (res.json() as CatchUpResult).text
      return text(since ? `${futureSinceNote(since) ?? ''}${out}` : out)
    }),
  )
}
