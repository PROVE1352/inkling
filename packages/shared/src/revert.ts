import { z } from 'zod'

// ---------------------------------------------------------------------------
// Reverting logged changes, one or an agent's whole run (docs/adr/1620-* .. 1624-*)
// ---------------------------------------------------------------------------

const seqSchema = z.string().regex(/^\d{1,19}$/)

/** POST /pages/:id/revert — explicit changes (`seqs`) or one agent's changes on the page in a period. */
export const revertPageSchema = z
  .object({
    seqs: z.array(seqSchema).min(1).max(200).optional(),
    /** Client name of the agent (page_changes.via_client). */
    via: z.string().trim().min(1).max(100).optional(),
    /** The member whose connection made the changes (narrows `via`). */
    actorId: z.uuid().optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    /** Preview only: what would be applied, what conflicts, nothing written. */
    dryRun: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !!v.seqs || !!v.via, 'give seqs, or via (an agent) with a period')
export type RevertPageInput = z.infer<typeof revertPageSchema>

/** POST /workspaces/:id/revert — one agent's changes across the workspace (owners and admins). */
export const revertWorkspaceSchema = z
  .object({
    via: z.string().trim().min(1).max(100),
    actorId: z.uuid().optional(),
    since: z.iso.datetime({ offset: true }),
    until: z.iso.datetime({ offset: true }).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
export type RevertWorkspaceInput = z.infer<typeof revertWorkspaceSchema>

/** POST /changes/:seq/revert */
export const revertChangeSchema = z.object({ dryRun: z.boolean().optional() }).strict()

/**
 * What happened (or would happen) to one logged change:
 *   applied     every hunk of its inverse went in
 *   partial     some went in; the others overlap later edits (see conflicts)
 *   conflict    nothing went in: every hunk overlaps a later edit
 *   noop        the document already looks like before the change
 *   unsupported this kind of change is not reverted here (see reason)
 */
export type RevertOutcome = 'applied' | 'partial' | 'conflict' | 'noop' | 'unsupported'

/** Why a change cannot be reverted here. */
export type RevertUnsupported = 'large' | 'page_event' | 'moved' | 'heading_only' | 'section_gone' | 'section_exists' | 'no_source' | 'too_complex'

export interface RevertConflictDTO {
  /** Light Markdown the revert wanted to bring back (empty = it wanted to remove `now`). */
  wanted: string
  /** What the section holds there now (someone changed it after this change). */
  now: string
  /** overlap = a later edit touched the same blocks; no_source = the removed block cannot be rebuilt. */
  reason: 'overlap' | 'no_source'
}

export interface RevertChangeDTO {
  seq: string
  kind: string
  anchor: string | null
  headingPath: string
  via: string | null
  actor: string | null
  changedAt: string
  outcome: RevertOutcome
  /** Hunks applied (or that would be). */
  applied: number
  conflicts: RevertConflictDTO[]
  /** Blocks brought back from the change log's plain text (no version kept their formatting). */
  plainText: number
  reason?: RevertUnsupported
}

export interface RevertPageDTO {
  pageId: string
  title: string
  changes: RevertChangeDTO[]
  /** The page was written (false in a preview, or when nothing applied or it failed). */
  written: boolean
  /** The page could not be reverted at all (locked, no edit access, changed during the write). */
  error?: { code: string; message: string }
}

export interface RevertResultDTO {
  dryRun: boolean
  pages: RevertPageDTO[]
  totals: { pages: number; changes: number; applied: number; partial: number; conflicts: number; unsupported: number; noop: number }
  /** More changes matched than one call handles; run it again after this one. */
  truncated: boolean
}

/** Revert facts of a logged change for the history and activity lists. */
export interface ChangeRevertInfoDTO {
  /** A section change with texts: POST /changes/:seq/revert can try it. */
  revertable: boolean
  /** Someone reverted it (newest revert). */
  revertedBy: { name: string; at: string } | null
  /** It is itself the edit a revert made. */
  isRevert: boolean
}
