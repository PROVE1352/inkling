/**
 * Downgrade helper (docs/adr/1100-*, 1101-*): rewrites every V2 page_docs row as V1 and every
 * snapshot row as a whole V1 state, so a server older than these ADRs can read the database again.
 * Only needed before rolling back to v0.4.0 or earlier; newer servers read both formats.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://… npx tsx scripts/states-to-v1.ts [--dry-run]
 *
 * Stop the server first (a running server converts rows back to V2 on its next store). Works page
 * by page, one transaction each; safe to re-run (rows already V1 and whole are skipped). Snapshot
 * rows grow back to whole states (the version history takes the space it took before ADR 1100).
 */
import { sql } from 'drizzle-orm'
import * as Y from 'yjs'

const DRY = process.argv.includes('--dry-run')
const { db, closeDb } = await import('../src/db/index')
const { snapshotDoc } = await import('../src/snapshotStore')

let docs = 0
let snaps = 0
const docRows = (await db.execute(sql`
  SELECT page_id AS id FROM page_docs WHERE state_format = 2 OR (octet_length(state) > 2 AND get_byte(state, 0) = 0)
`)) as unknown as { id: string }[]
for (const { id } of docRows) {
  await db.transaction(async (tx) => {
    const [r] = (await tx.execute(sql`SELECT state FROM page_docs WHERE page_id = ${id} FOR UPDATE`)) as unknown as { state: Buffer }[]
    if (!r || !(r.state.length > 2 && r.state[0] === 0)) return
    const v1 = Y.convertUpdateFormatV2ToV1(r.state)
    if (!DRY) await tx.execute(sql`UPDATE page_docs SET state = ${Buffer.from(v1)}, state_format = 1 WHERE page_id = ${id}`)
    docs++
  })
}
const pagesWithChains = (await db.execute(sql`
  SELECT DISTINCT page_id AS id FROM page_snapshots WHERE base_id IS NOT NULL OR state_format = 2
`)) as unknown as { id: string }[]
for (const { id: pageId } of pagesWithChains) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'page-snapshots:' + pageId}))`)
    const rows = (await tx.execute(sql`
      SELECT id FROM page_snapshots WHERE page_id = ${pageId} AND (base_id IS NOT NULL OR state_format = 2) ORDER BY created_at, id
    `)) as unknown as { id: string }[]
    // Rebuild every row first (chains still intact), then write: a whole row never feeds another.
    const whole = new Map<string, Uint8Array>()
    for (const { id } of rows) {
      try {
        const doc = await snapshotDoc(pageId, id, tx)
        if (doc) whole.set(id, Y.encodeStateAsUpdate(doc))
      } catch (err) {
        console.error(`snapshot ${id} of ${pageId} cannot be rebuilt; deleting it`, (err as Error).message)
        if (!DRY) await tx.execute(sql`DELETE FROM page_snapshots WHERE id = ${id}`)
      }
    }
    if (DRY) return void (snaps += whole.size)
    for (const [id, state] of whole) {
      await tx.execute(sql`
        UPDATE page_snapshots SET state = ${Buffer.from(state)}, state_format = 1, base_id = NULL, depth = 0 WHERE id = ${id}
      `)
      snaps++
    }
  })
}
console.log(`${DRY ? '[dry run] would rewrite' : 'rewrote'} ${docs} page_docs rows and ${snaps} snapshot rows as V1`)
await closeDb()
process.exit(0)
