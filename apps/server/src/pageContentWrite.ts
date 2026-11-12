import type { AuthUser } from './auth'
import type { CheckedAccess } from './aclVersion'
import { actorOf, withEditActor } from './context/attribution'
import { buildEchoIndex } from './context/sectionPatch'
import type { EchoIndex } from './context/sectionPatch'
import { currentBlocks, pageMentionKeys } from './context/sectionSource'
import { pageEditGate } from './docWriteGate'
import type { Locale } from './i18n'
import { blocksToMarkdown, markdownToBlocks, stripFrontmatter } from './md/convert'
import type { AnyBlock } from './md/convert'
import { writeBlocksToDoc } from './md/docWrite'
import { buildTitleResolver } from './md/importer'
import type { PageRow } from './pageDto'
import { createSnapshot, currentSnapshotSource } from './snapshotStore'
import { asAgentStep, lineDelta } from './context/sectionWrite'
import { isAgentVia } from './agentVia'

/**
 * update_page's write as a given user (POST /pages/:id/content), shared with accepting a whole-body
 * suggestion (docs/adr/1533-*). The caller has checked membership, visibility and the edit lock and
 * passes the role + access version it decided on (the write runs under the write gate, ADR 1150).
 */

/** Blocks above which update_page(replace) computes no echo (≈ 0.4 ms per block). */
const REPLACE_ECHO_MAX_BLOCKS = 2_000
/** Markdown above which an agent's replace reports no line counts (docs/adr/2551-*). */
const REPLACE_LINE_COUNT_MAX_CHARS = 256 * 1024

function countBlocks(blocks: { children?: unknown }[]): number {
  let n = 0
  for (const b of blocks) n += 1 + (Array.isArray(b.children) ? countBlocks(b.children as { children?: unknown }[]) : 0)
  return n
}

export async function writePageContentAs(
  user: AuthUser,
  page: PageRow,
  access: CheckedAccess,
  body: { markdown: string; mode: 'replace' | 'append' },
  locale: () => Promise<Locale>,
): Promise<void> {
  const id = page.id
  const resolveTitle = await buildTitleResolver(page.workspaceId, new Map(), user.id)
  // Notation from read_page (callouts, embeds, files) comes back as those blocks; mention chips
  // already in the page may be kept, not created (docs/adr/1500-*).
  const notation = { mentions: await pageMentionKeys(id, body.markdown) }
  const incoming = await markdownToBlocks(stripFrontmatter(body.markdown), resolveTitle, undefined, notation)

  // An agent write is one AI step (docs/adr/2180-*): asAgentStep keeps the page before and after it.
  const agent = isAgentVia(user.via)
  if (body.mode === 'replace' && !agent) {
    // Prefer the in-memory document: page_docs trails it by the store debounce (ADR 0757).
    const before = await currentSnapshotSource(id)
    // the label is stored in the DB, so it is written in the editor's locale
    if (before) {
      const label = (await locale()) === 'ko' ? 'AI 편집 전' : 'Before AI edit'
      await createSnapshot(id, before, label, user.id, user.via ?? null)
    }
  }

  // replace is a minimal edit of the whole document; the echo of what the agent read lets the
  // blocks it sent back unchanged stay untouched (docs/adr/1500-*). Very large pages skip the
  // echo (two conversions per block) and are diffed block by block instead.
  let echo: EchoIndex | null = null
  // The page before a replace, for the step's line counts (only where the echo is computed too).
  let old: AnyBlock[] | null = null
  if (body.mode === 'replace') {
    const blocks = await currentBlocks(id)
    if (countBlocks(blocks) <= REPLACE_ECHO_MAX_BLOCKS) {
      echo = await buildEchoIndex(blocks, resolveTitle, notation, incoming)
      old = blocks
    }
  }

  // The change feed reads the actor (user + OAuth client) while the store hook indexes this edit.
  // Under the write gate (docs/adr/1150-*): a lock change or agent block that commits after the
  // check above is seen before the edit, or waits until the edit is in the document.
  const gate = pageEditGate(id, page.workspaceId, user.id, access)
  await asAgentStep(id, user, locale, async () => {
    await withEditActor([id], actorOf(user), () => writeBlocksToDoc(id, incoming, body.mode, gate, echo))
    if (!agent) return { result: undefined, step: null }
    const md = async (blocks: AnyBlock[]) => (blocks.length ? (await blocksToMarkdown(blocks, { assetMode: 'absolute', notation: 'agent' })).markdown.trim() : '')
    // A very large replaced page (no echo) reports no line counts: the whole body was written. The
    // same for a very large new body (docs/adr/2551-*): exporting it to count lines costs a DOM of the
    // whole body that BlockNote's exporter keeps alive afterwards (~130 MB for 1 MB).
    const countLines = old && countBlocks(incoming) <= REPLACE_ECHO_MAX_BLOCKS && body.markdown.length <= REPLACE_LINE_COUNT_MAX_CHARS
    const delta = body.mode === 'append' ? lineDelta('', await md(incoming)) : countLines ? lineDelta(await md(old!), await md(incoming)) : {}
    return { result: undefined, step: { tool: 'update_page', mode: body.mode, ...delta } }
  })
}
