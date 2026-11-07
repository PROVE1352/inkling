/**
 * Explain one find_context ranking on a bench database (docs/adr/1210-*): word weights and the top
 * candidates with their scores. Not part of CI.
 *
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/context-explain.ts <workspaceId> <userId> "query" [budget]
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
async function main() {
  const [wsId, userId, query, budget] = process.argv.slice(2)
  const { findContext } = await import('../src/context/retrieve')
  const { closeDb } = await import('../src/db/index')
  const r = await findContext({
    userId,
    query,
    workspaceIds: [wsId],
    budget: budget ? Number(budget) : undefined,
    explain: (i) => {
      console.log(`candidates ${i.candidates}, N ${i.n}`)
      i.groups.forEach((g, k) => console.log(`  ${g.variants.join('|')}: df ${i.df[k]} idf ${i.idf[k].toFixed(2)}`))
      for (const c of i.ranked.slice(0, 12)) console.log(`  ${c.score.toFixed(3)} ${c.title} › ${c.headingPath} (${c.tokens} tok)`)
    },
  })
  console.log('shown:', r.fragments.map((f) => `${f.title}#${f.sections.map((s) => s.short).join('+')}`).join(' | '))
  console.log('more:', r.more.map((m) => `${m.title}#${m.short}`).join(' | '))
  await closeDb()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
