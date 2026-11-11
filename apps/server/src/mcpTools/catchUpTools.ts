import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CATCH_UP_DEFAULT_BUDGET, CATCH_UP_MAX_BUDGET, CATCH_UP_MIN_BUDGET } from '../catchUp'
import type { CatchUpResult } from '../catchUp'
import { call, text, wrap, idArg } from './core'
import type { ToolCtx } from './core'

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
          .describe('A previous catch_up or changes_since cursor, or a time (2026-11-08T09:00Z); omit to continue from the last catch_up'),
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
    wrap(async ({ workspaceId, since, budget, peek, team }) => {
      const query: Record<string, string> = {}
      if (workspaceId) query.workspaceId = workspaceId
      if (since) query.since = since
      if (budget) query.budget = String(budget)
      if (peek) query.advance = '0'
      if (team) query.team = '1'
      const res = await call(ctx, 'GET', '/api/catch-up', { query })
      return text((res.json() as CatchUpResult).text)
    }),
  )
}
