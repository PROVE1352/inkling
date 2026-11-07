// Notion export importer: pure helpers and the planning phase (no database). docs/adr/0960-*.
// The full import (pages, collections, documents, attachments) is covered by notionImport.db.test.ts.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import JSZip from 'jszip'
import { buildNotionFixture, H } from './notionFixture'
import { planNotionExport } from './notionImport'
import {
  candidatePaths,
  decodeHref,
  hashFromNotionUrl,
  inferNotionColumn,
  looksLikeNotionExport,
  parseNotionDate,
  parseNotionName,
  preprocessNotionMarkdown,
  splitLeadingTitle,
  splitRelationCell,
  stripRowProperties,
  uniqueTitle,
} from './notionParse'

describe('Notion names', () => {
  it('strips the 32-hex id and recognises _all CSVs and NFD names', () => {
    assert.deepEqual(parseNotionName(`Team Wiki ${H.wiki}.md`), { title: 'Team Wiki', hash: H.wiki, ext: '.md', isAll: false })
    assert.deepEqual(parseNotionName(`Projects ${H.projects}_all.csv`), { title: 'Projects', hash: H.projects, ext: '.csv', isAll: true })
    assert.equal(parseNotionName(`${H.beta}.md`).title, 'Untitled')
    assert.equal(parseNotionName('Plain name.md').hash, null)
    assert.equal(parseNotionName(`로드맵 ${H.roadmap}.md`.normalize('NFD')).title, '로드맵')
    assert.equal(parseNotionName(`Folder ${H.wiki}`, true).ext, '')
  })
  it('detects Notion exports from names', () => {
    assert.equal(looksLikeNotionExport([`A ${H.wiki}.md`, `A ${H.wiki}/B ${H.start}.md`, 'x.png']), true)
    assert.equal(looksLikeNotionExport(['notes/a.md', 'notes/b.md', 'assets/x.png']), false)
    assert.equal(looksLikeNotionExport(['Export-0f0f0f0f-0000-4000-8000-000000000001-Part-1.zip']), true)
  })
  it('de-duplicates sibling titles', () => {
    const taken = new Set<string>()
    assert.deepEqual(['Notes', 'notes', 'Notes'].map((t) => uniqueTitle(t, taken)), ['Notes', 'notes (2)', 'Notes (3)'])
  })
})

describe('Notion links', () => {
  it('decodes percent-encoded hrefs and resolves them relative to the file', () => {
    assert.equal(decodeHref('Getting%20Started%20abc.md#section'), 'Getting Started abc.md')
    assert.equal(decodeHref('%E0%A4%A'), null)
    assert.deepEqual(candidatePaths('Wiki/Page.md', 'Sub/Child.md'), ['Wiki/Sub/Child.md', 'Sub/Child.md'])
    assert.deepEqual(candidatePaths('Wiki/Page.md', '../Home.md'), ['Home.md'])
    assert.deepEqual(candidatePaths('Page.md', '../../etc/passwd'), [])
  })
  it('extracts ids from notion.so / notion.site URLs only', () => {
    assert.equal(hashFromNotionUrl(`https://www.notion.so/acme/Roadmap-${H.roadmap}?pvs=4`), H.roadmap)
    assert.equal(hashFromNotionUrl('https://acme.notion.site/Page-0f0f0f0f-0000-4000-8000-000000000001'), '0f0f0f0f000040008000000000000001')
    assert.equal(hashFromNotionUrl(`https://example.com/Roadmap-${H.roadmap}`), null)
  })
  it('splits relation cells without breaking titles inside the path parentheses', () => {
    assert.deepEqual(splitRelationCell('Alpha (P/Alpha%20x.md), Beta, Gamma (P/a,b.md)'), ['Alpha (P/Alpha%20x.md)', 'Beta', 'Gamma (P/a,b.md)'])
  })
})

describe('Notion Markdown', () => {
  it('turns callouts into quotes and equations into code, outside code fences only', () => {
    const { md, stats } = preprocessNotionMarkdown(
      '<aside>\n💡 Tip\n</aside>\n\n$$\nE=mc^2\n$$\n\nCost $5 and $10, math $x_1$.\n\n```\n$$ keep $x$\n```\n',
    )
    assert.match(md, /^> 💡 Tip$/m)
    assert.match(md, /```latex\nE=mc\^2\n```/)
    assert.match(md, /Cost \$5 and \$10, math `\$x_1\$`\./)
    assert.match(md, /```\n\$\$ keep \$x\$\n```/)
    assert.deepEqual(stats, { callouts: 1, equations: 2 })
  })
  it('strips the title heading and row property lines', () => {
    const { title, body } = splitLeadingTitle('# Alpha project\n\nStatus: Active\nTags: a\n\nBody', 'Alpha project')
    assert.equal(title, 'Alpha project')
    assert.equal(stripRowProperties(body, ['Name', 'Status', 'Tags']).trim(), 'Body')
    // a heading that is not the title stays
    assert.equal(splitLeadingTitle('# Intro\nText', 'Something else').title, null)
    // a "Key: value" line that is not a column stays
    assert.equal(stripRowProperties('\nNote: hi\nBody', ['Status']), '\nNote: hi\nBody')
  })
})

describe('Notion CSV cells', () => {
  it('parses Notion date spellings', () => {
    assert.equal(parseNotionDate('November 7, 2026'), '2026-11-07')
    assert.equal(parseNotionDate('Nov 7, 2026 3:00 PM'), '2026-11-07')
    assert.equal(parseNotionDate('@December 1, 2026'), '2026-12-01')
    assert.equal(parseNotionDate('November 9, 2026 → November 12, 2026'), '2026-11-09')
    assert.equal(parseNotionDate('2026년 11월 7일 오후 3:00'), '2026-11-07')
    assert.equal(parseNotionDate('7 November 2026'), '2026-11-07')
    assert.equal(parseNotionDate('February 30, 2026'), null)
    assert.equal(parseNotionDate('soon'), null)
  })
  it('infers column types', () => {
    assert.equal(inferNotionColumn(['Yes', 'No', 'No']), 'checkbox')
    assert.equal(inferNotionColumn(['No', 'No']), 'checkbox')
    assert.equal(inferNotionColumn(['$1,200', '300', '']), 'number')
    assert.equal(inferNotionColumn(['November 7, 2026', '2026/11/20']), 'date')
    assert.equal(inferNotionColumn(['https://a.example', 'http://b.example/x']), 'url')
    assert.equal(inferNotionColumn(['a@example.com', 'b@example.com']), 'email')
    assert.equal(inferNotionColumn(['web, api', 'web', 'api, data']), 'multiSelect')
    assert.equal(inferNotionColumn(['Hello, world', 'Goodbye, moon']), 'text')
    assert.equal(inferNotionColumn(['A', 'B', 'A', 'B']), 'select')
    assert.equal(inferNotionColumn(['', '']), 'text')
  })
})

describe('Notion export plan (fixture)', () => {
  for (const nested of [true, false]) {
    it(`builds the tree, collections and relations (${nested ? 'nested part zips' : 'flat zip'})`, async () => {
      const plan = await planNotionExport(await JSZip.loadAsync(await buildNotionFixture({ nested })))
      const byTitle = new Map(plan.pages.map((p) => [p.title, p]))
      assert.deepEqual(
        plan.pages.filter((p) => !p.isRow && p.kind === 'doc').map((p) => p.title).sort(),
        ['Getting Started', 'Notes', 'Notes (2)', 'Team Wiki', '로드맵 계획'],
      )
      assert.equal(plan.renamed, 1)
      assert.equal(byTitle.get('Getting Started')?.parent, 'Team Wiki')
      assert.equal(byTitle.get('Projects')?.kind, 'collection')
      assert.equal(byTitle.get('Alpha')?.parent, 'Projects')

      const projects = plan.collections.find((c) => c.title === 'Projects')!
      const people = plan.collections.find((c) => c.title === 'People')!
      assert.equal(projects.rows, 4)
      assert.equal(people.rows, 2)
      const types = Object.fromEntries(projects.fields.map((f) => [f.name, f.type]))
      assert.deepEqual(types, {
        Status: 'select',
        Tags: 'multiSelect',
        Due: 'date',
        Done: 'checkbox',
        Budget: 'number',
        Website: 'url',
        Contact: 'text',
        Lead: 'select',
        Members: 'relation',
      })
      assert.equal(people.fields.find((f) => f.name === 'Projects')?.type, 'relation')

      // values on a row
      const alpha = byTitle.get('Alpha')!.props
      const f = (n: string) => projects.fields.find((x) => x.name === n)!
      assert.equal(alpha[f('Due').id], '2026-11-07')
      assert.equal(alpha[f('Done').id], true)
      assert.equal(alpha[f('Budget').id], 1200)
      assert.equal((alpha[f('Tags').id] as string[]).length, 2)
      assert.equal((alpha[f('Members').id] as string[]).length, 2)
      assert.equal(byTitle.get('Beta')!.props[f('Due').id], '2026-11-09')

      // the view CSV is skipped in favour of _all
      assert.ok(plan.skipped.some((s) => s.path.endsWith(`Projects ${H.projects}.csv`)))
    })
  }

  it('refuses archives over the file cap', async () => {
    const limits = { maxUploadBytes: 25 << 20, maxUnpackedBytes: 50 << 20, maxEntryBytes: 25 << 20, maxFiles: 3, maxPages: 5000 }
    await assert.rejects(planNotionExport(await JSZip.loadAsync(await buildNotionFixture()), limits), /Too many files/)
  })
  it('refuses archives over the page cap', async () => {
    const limits = { maxUploadBytes: 25 << 20, maxUnpackedBytes: 50 << 20, maxEntryBytes: 25 << 20, maxFiles: 300, maxPages: 4 }
    await assert.rejects(planNotionExport(await JSZip.loadAsync(await buildNotionFixture()), limits), /Too many pages/)
  })
  it('counts real decompressed bytes of nested parts', async () => {
    const limits = { maxUploadBytes: 25 << 20, maxUnpackedBytes: 50 << 20, maxEntryBytes: 25 << 20, maxFiles: 300, maxPages: 5000 }
    const tiny = { ...limits, maxUploadBytes: 64 }
    await assert.rejects(planNotionExport(await JSZip.loadAsync(await buildNotionFixture()), tiny), /too large/)
  })
})
