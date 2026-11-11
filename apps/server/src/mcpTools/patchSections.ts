import { z } from 'zod'
import { call, text, ToolError, wrapWrite } from './core'
import type { McpServer, ToolCtx } from './core'
import { largeLine, loadAgentContext, withApplies } from './agentContext'
import { pageRef, resolvePageRef } from './shortIds'
import { cleanText, wrapUntrusted } from './trust'
import type { SectionConflict } from '../routes/sectionBatch'
import type { SuggestionDTO } from '@inkling/shared'
import { suggestionsMadeText } from './collabTools'

/**
 * patch_sections (docs/adr/1542-*): several patch_section edits on one page in one call, all or
 * nothing. Calls POST /api/pages/:id/sections, which runs the same checks as patch_section once
 * and every edit under one write gate. A failure lists every edit that cannot apply (with the
 * current text for version conflicts) and writes nothing.
 */

interface BatchOk {
  ok: true
  results: { index: number; section: { anchor: string; version: string } | null; movedFrom?: string }[]
}

interface BatchConflict {
  error: { message: string; conflicts: SectionConflict[]; anchors?: string[] }
}

export function renderSectionConflicts(pageId: string, body: BatchConflict): string {
  const lines = [`Conflict: ${body.error.message}`]
  const data: string[] = []
  for (const c of body.error.conflicts) {
    const where = c.reason === 'not_found' || c.reason === 'ambiguous' || c.reason === 'empty' ? `"${cleanText(c.ref)}"` : `§${c.anchor}`
    lines.push(`- edit ${c.index + 1} ${where}: ${cleanText(c.message)}`)
    if (c.reason === 'version' && c.markdown !== undefined) {
      data.push(`edit ${c.index + 1}: current §${c.anchor} (v=${c.version})`, c.markdown, '')
    }
  }
  if (body.error.conflicts.some((c) => c.reason === 'not_found') && body.error.anchors?.length) {
    lines.push(`Available anchors: ${body.error.anchors.map((a) => cleanText(a)).join(', ')}`)
  }
  if (data.length) lines.push('', wrapUntrusted(data.join('\n').trim(), { source: 'page', id: pageId }))
  return lines.join('\n')
}

export function registerPatchSectionsTool(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'patch_sections',
    {
      title: 'Patch sections',
      description:
        'Several patch_section edits on one document page in one call, applied together or not at all. Each edit is ' +
        '{section, mode, markdown, baseVersion} exactly as in patch_section (baseVersion required for replace/delete); they apply ' +
        'in order and each section may appear once. If any edit cannot apply (changed since baseVersion, unknown section), ' +
        'nothing is written and every problem is listed with the current text — fix them and send all edits again. ' +
        'suggest=true leaves all edits as suggestions for a person to accept (one per section, made together); on pages locked to ' +
        '"agents: suggestions only" that happens without asking.',
      inputSchema: {
        pageId: pageRef().describe('Page id (kind=doc; full or 8-character prefix)'),
        edits: z
          .array(
            z.object({
              section: z.string().trim().min(1).max(500).describe('Section anchor, heading text or heading block id'),
              mode: z.enum(['replace', 'append', 'prepend', 'insert_after', 'delete']).describe('How to apply the markdown'),
              markdown: z.string().max(1_000_000).optional().describe('Markdown to write (not needed for delete)'),
              baseVersion: z.string().trim().max(64).optional().describe('Section version you based the edit on (v=…)'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Edits, applied in order'),
        suggest: z.boolean().optional().describe('true: write nothing; leave every edit as a suggestion for a person'),
      },
    },
    wrapWrite(ctx, async ({ pageId: ref, edits, suggest }) => {
      edits.forEach((e, i) => {
        if ((e.mode === 'replace' || e.mode === 'delete') && !e.baseVersion) {
          throw new ToolError(
            `edit ${i + 1}: baseVersion is required for mode=${e.mode}; get it from read_page(pageId, outline=true) or find_context (v=…). Nothing was written.`,
          )
        }
        if (e.mode !== 'delete' && !e.markdown?.trim()) throw new ToolError(`edit ${i + 1}: markdown is empty; use mode=delete to remove a section. Nothing was written.`)
      })
      const pageId = await resolvePageRef(ctx, ref)
      const res = await call(ctx, 'POST', `/api/pages/${pageId}/sections`, {
        json: {
          edits: edits.map((e) => ({ ref: e.section, markdown: e.markdown ?? '', mode: e.mode, ...(e.baseVersion ? { baseVersion: e.baseVersion } : {}) })),
          ...(suggest ? { suggest } : {}),
        },
        passStatuses: [409],
      })
      // Kept as suggestions instead of written (docs/adr/1538-*)
      if (res.statusCode === 202) return text(suggestionsMadeText((res.json() as { suggestions: SuggestionDTO[] }).suggestions))
      if (res.statusCode === 409) {
        return { isError: true, content: [{ type: 'text', text: renderSectionConflicts(pageId, res.json() as BatchConflict) }] }
      }
      const r = res.json() as BatchOk
      const ac = await loadAgentContext(ctx, [pageId])
      const large = largeLine(ac, pageId)
      const parts = r.results.map((x) => (x.section ? `§${x.section.anchor} v=${x.section.version}` : `edit ${x.index + 1}: section removed`))
      const moved = r.results
        .filter((x) => x.movedFrom && x.section)
        .map((x) => `moved_to: §${x.section!.anchor} (edit ${x.index + 1}: the heading was renamed; "${cleanText(x.movedFrom!)}" no longer exists)`)
      return text(withApplies(ac, [`Done: ${edits.length} edits. ${parts.join('; ')}.`, ...moved, ...(large ? [large] : [])].join('\n')))
    }),
  )
}
