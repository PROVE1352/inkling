import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { FEED_MAX_BUDGET, FEED_MIN_BUDGET } from '../context/changeFeed'
import type { FeedResult } from '../context/changeFeed'
import { call, text, uuid, wrap } from './core'
import type { ToolCtx } from './core'

/** Change feed tool (docs/adr/0932-*): changes_since. Calls GET /api/changes as the token user. */
export function registerChangeTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'changes_since',
    {
      title: 'Changes since',
      description:
        'What changed in your notes since a cursor, as compact diffs per section (added text, -/+ lines, removed, ' +
        'renamed, moved; page renames, moves, trash, visibility), with who/which agent made them. ' +
        'Without a cursor it only returns the current cursor: store it. In a later session call changes_since(cursor) ' +
        'and update only what changed instead of re-reading pages; every call returns the next cursor to store ' +
        '(always the last line). Output fits a token budget (default 3000, max 12000); entries that do not fit are ' +
        'listed without detail.',
      inputSchema: {
        cursor: z.string().trim().min(1).max(200).optional().describe('Cursor from a previous call (omit to start tracking)'),
        workspaceId: uuid().optional().describe('Limit to one workspace (keep using the same value with its cursors)'),
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
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ cursor, workspaceId, budget, detail }) => {
      const query: Record<string, string> = {}
      if (cursor) query.cursor = cursor
      if (workspaceId) query.workspaceId = workspaceId
      if (budget) query.budget = String(budget)
      if (detail) query.detail = detail
      const res = await call(ctx, 'GET', '/api/changes', { query })
      return text((res.json() as FeedResult).text)
    }),
  )
}
