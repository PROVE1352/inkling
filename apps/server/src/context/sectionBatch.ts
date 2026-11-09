import * as Y from 'yjs'
import type { AnyBlock } from '../md/convert'
import { INTRO_ANCHOR, splitSections } from './chunker'
import type { Section } from './chunker'
import { applySectionPatch, readBlocks } from './sectionPatch'
import type { EchoIndex, PatchMode } from './sectionPatch'

/**
 * patch_sections (docs/adr/1542-*): several section patches on one document, all or nothing.
 *
 * Runs synchronously inside one write-gated transaction (the caller's `gatedTransact`), so no
 * remote update can land between the checks and the edits:
 *   1. Every target is found again by its heading block id (stable across the other edits; the intro
 *      by its anchor) and every baseVersion is compared with the document as it is now. Any miss or
 *      stale version → nothing is written, every failure is returned.
 *   2. The whole batch runs on a copy of the document first. If any edit fails there (a structure
 *      error, a validation fallback that throws, a section that an earlier edit removed), nothing is
 *      written.
 *   3. Only then does the same deterministic sequence run on the live document — the copy-then-live
 *      rule applySectionPatch already follows per patch (docs/adr/0940-*), lifted to the batch.
 * Edits apply in the order given; later edits see the earlier ones (by block id, not by anchor, so
 * a heading an earlier edit renamed or a section it inserted does not redirect them).
 */

export interface BatchEdit {
  /** Heading block id of the target section, or null for the intro. */
  blockId: string | null
  anchor: string
  incoming: AnyBlock[]
  mode: PatchMode
  baseVersion?: string
  echo: EchoIndex | null
}

export type BatchFailure =
  | { index: number; reason: 'version'; section: Section; blocks: AnyBlock[] }
  | { index: number; reason: 'not_found' }
  | { index: number; reason: 'invalid'; message: string }

export type BatchOutcome =
  | { status: 'ok'; results: (Section | null)[]; sections: number }
  | { status: 'failed'; failures: BatchFailure[]; sections: Section[] }

const refOf = (e: BatchEdit) => e.blockId ?? INTRO_ANCHOR

function findTarget(sections: Section[], e: BatchEdit): Section | undefined {
  return e.blockId ? sections.find((s) => s.blockId === e.blockId) : sections.find((s) => s.level === 0 && s.anchor === INTRO_ANCHOR)
}

/** Runs every edit on `doc` in order; throws or returns the first failure without catching. */
function runAll(doc: Y.Doc, edits: BatchEdit[]): { results: (Section | null)[]; sections: number; failure?: BatchFailure } {
  const results: (Section | null)[] = []
  let sections = 0
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    let out
    try {
      out = applySectionPatch(doc, refOf(e), e.incoming, e.mode, undefined, e.echo)
    } catch (err) {
      return { results, sections, failure: { index: i, reason: 'invalid', message: err instanceof Error ? err.message : String(err) } }
    }
    if (out.status !== 'ok') return { results, sections, failure: { index: i, reason: 'not_found' } }
    results.push(out.section)
    sections = out.sections.length
  }
  return { results, sections }
}

export function applySectionBatch(doc: Y.Doc, edits: BatchEdit[]): BatchOutcome {
  const blocks = readBlocks(doc)
  const sections = splitSections(blocks)
  const failures: BatchFailure[] = []
  edits.forEach((e, index) => {
    const s = findTarget(sections, e)
    if (!s) failures.push({ index, reason: 'not_found' })
    else if (e.baseVersion && e.baseVersion !== s.version) failures.push({ index, reason: 'version', section: s, blocks })
  })
  if (failures.length) return { status: 'failed', failures, sections }

  // Dry run on a copy: a failure anywhere leaves the live document untouched.
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  try {
    const dry = runAll(copy, edits)
    if (dry.failure) return { status: 'failed', failures: [dry.failure], sections }
  } finally {
    copy.destroy()
  }
  const live = runAll(doc, edits)
  // The copy ran the same edits on the same state; a live failure here would be a determinism bug.
  if (live.failure) throw new Error(`patch_sections: edit ${live.failure.index + 1} failed on the live document after the dry run`)
  return { status: 'ok', results: live.results, sections: live.sections }
}
