import type { FastifyInstance } from 'fastify'
import { instructionBody, instructionRows } from '../agentInstructions'
import { getUser, requireUser } from '../auth'
import { idParam, requireMembership } from '../helpers'
import { INSTRUCTION_WARN_BYTES, INSTRUCTION_WARN_LINES, measureInstructions } from '../instructionLength'
import type { InstructionLength } from '../instructionLength'

/**
 * Length of a workspace's agent instruction pages (docs/adr/2004-*), for the warning on the
 * instruction page's settings in the web app.
 *
 *   GET /workspaces/:id/agent-instructions/length → InstructionLengthsDTO (members)
 *
 * Measured on the Markdown get_instructions sends (instructionBody: the live document, cut at
 * INSTRUCTION_BODY_MAX characters), with the same function and limits as the note get_instructions
 * prints. Sizes only, no text. Who may see the list of instruction pages is unchanged: any member
 * (GET /workspaces/:id/agent-instructions).
 */

export interface InstructionLengthsDTO {
  limits: { lines: number; bytes: number }
  /** Every `always` page together: what every agent session in the workspace receives first. */
  always: InstructionLength & { pages: number }
  pages: (InstructionLength & { pageId: string; mode: 'always' | 'match' | 'manual'; truncated: boolean })[]
}

export async function registerInstructionLengthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/workspaces/:id/agent-instructions/length', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const rows = await instructionRows([id])
    const bodies = await Promise.all(rows.map(async (r) => ({ r, body: await instructionBody(r.pageId) })))
    const always = bodies.filter((x) => x.r.mode === 'always')
    const dto: InstructionLengthsDTO = {
      limits: { lines: INSTRUCTION_WARN_LINES, bytes: INSTRUCTION_WARN_BYTES },
      always: { ...measureInstructions(always.map((x) => x.body.markdown)), pages: always.length },
      pages: bodies.map(({ r, body }) => ({
        pageId: r.pageId,
        mode: r.mode,
        ...measureInstructions([body.markdown]),
        truncated: body.truncated,
      })),
    }
    return dto
  })
}
