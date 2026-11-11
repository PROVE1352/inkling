import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { SPLIT_MAX_PAGES } from '@inkling/shared'
import type { SplitPlanDTO } from '@inkling/shared'
import { call, text, wrapWrite, idArg } from './core'
import type { ToolCtx } from './core'
import { cleanText } from './trust'

/**
 * split_page (docs/adr/1140-*): cut a document at its headings into subpages through the same REST
 * route as the web app (`POST /pages/:id/split`), so membership, the edit lock and placement rules
 * apply unchanged. Output is a fixed line per section, deterministic for the same document.
 */

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

export function formatSplit(r: SplitPlanDTO): string {
  const levels = r.levels.map((n, i) => (n ? `h${i + 1} ${n}` : '')).filter(Boolean).join(', ') || 'none'
  if (!r.sections.length) {
    return `No top-level heading of level ${r.level} on this page. Top-level headings: ${levels}. Try another level.`
  }
  const lines: string[] = []
  if (r.preview) {
    lines.push(`Preview, nothing changed: splitting at heading level ${r.level} would create ${r.sections.length} subpage(s):`)
  } else {
    lines.push(`Split at heading level ${r.level}: created ${r.sections.length} subpage(s) under this page.`)
  }
  for (const s of r.sections) {
    const facts = [`${r.preview ? 'section' : 'was section'}=${s.anchor}`, `heading=${s.blockId}`, `${s.blocks} blocks`, kb(s.bytes)]
    if (s.comments) facts.push(`${s.comments} comment thread(s)${r.preview ? '' : ' moved'}`)
    lines.push(`- "${cleanText(s.title || 'Untitled')}"${s.pageId ? ` id=${s.pageId}` : ''} (${facts.join(', ')})`)
  }
  if (r.preview) {
    lines.push(`Top-level headings: ${levels}. Call split_page again without dry_run to split.`)
  } else {
    lines.push(
      'The page keeps what came before and between the sections, and a link to each subpage where its section was. ' +
        'Block ids are kept: read a moved section with read_page pageId=<id>.',
    )
    if (r.openBy > 0) lines.push(`${r.openBy} other person(s) had the page open; they saw the change live.`)
  }
  return lines.join('\n')
}

export function registerSplitTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'split_page',
    {
      title: 'Split page into subpages',
      description:
        'Split a long document into subpages at its headings: every top-level heading of the given level starts a subpage ' +
        '(titled with the heading) holding that heading and everything up to the next heading of that level or higher. ' +
        'The page keeps its intro and higher-level headings, and gets a link to each subpage where the section was. ' +
        'Block ids and comment threads move with their blocks; links to the page keep working. ' +
        `Use dry_run=true first to see the sections. At most ${SPLIT_MAX_PAGES} subpages per call.`,
      inputSchema: {
        pageId: idArg('page').describe('Page id (kind=doc)'),
        level: z.number().int().min(1).max(6).default(2).describe('Heading level to split at (1 = h1, 2 = h2, …); default 2'),
        sections: z
          .array(z.string().min(1).max(100))
          .max(SPLIT_MAX_PAGES)
          .optional()
          .describe('Only these sections: heading block ids from a dry run (default: every section of that level)'),
        dry_run: z.boolean().optional().describe('true = only list what would be split (nothing changes)'),
      },
    },
    wrapWrite(ctx, async ({ pageId, level, sections, dry_run }) => {
      const res = await call(ctx, 'POST', `/api/pages/${pageId}/split`, { json: { level, sections, preview: !!dry_run } })
      return text(formatSplit(res.json() as SplitPlanDTO))
    }),
  )
}
