// Section links `[[Page#Heading]]` (docs/adr/2100-*) through vault sync (docs/adr/2169-*), end to end
// with the real `inklingctl sync`: server → vault → server keeps section links, page links to a
// title containing `#` ("C# notes") and the one-line block tokens next to them, also when the
// paragraph holding the links is edited in the vault (the import resolves the links again then).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-vsect-${process.pid}`

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })

describe('[db] vault sync keeps section links and `#` titles', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const kit = await import('./vaultSyncTestKit')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { currentBlocks } = await import('../context/sectionSource')

  const s = await kit.buildSyncApp()
  type U = Awaited<ReturnType<typeof h.makeUser>>
  let alice: U
  let home: string
  const scratch: string[] = []

  before(async () => {
    alice = await h.makeUser('Alice')
    home = await mkdtemp(path.join(tmpdir(), 'inkling-vsect-home-'))
    scratch.push(home)
  })
  after(async () => {
    await collab.destroyCollab()
    await s.close()
    await closeDb()
    for (const d of scratch) await rm(d, { recursive: true, force: true })
  })

  const text = (t: string) => ({ type: 'text', text: t, styles: {} })
  const heading = (t: string) => ({ type: 'heading', props: { level: 2 }, content: [text(t)] })
  const para = (...content: unknown[]) => ({ type: 'paragraph', content })
  const link = (ws: string, pageId: string, shown: string, section?: { heading: string; page: string }) => ({
    type: 'link',
    href: `/w/${ws}/p/${pageId}${section ? `#h=${encodeURIComponent(section.heading)}&p=${encodeURIComponent(section.page)}` : ''}`,
    content: [text(shown)],
  })

  type Link = { href: string; text: string }
  const linksOf = (blocks: unknown): Link[] => {
    const out: Link[] = []
    const walk = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(walk)
      if (!x || typeof x !== 'object') return
      const o = x as { type?: string; href?: string; content?: unknown; children?: unknown }
      if (o.type === 'link' && typeof o.href === 'string') out.push({ href: o.href, text: (o.content as { text: string }[]).map((c) => c.text).join('') })
      walk(o.content)
      walk(o.children)
    }
    walk(blocks)
    return out
  }

  it('server → vault → server, with the paragraph of the links edited in the vault', async () => {
    const ws = (await h.makeWorkspace(alice)).id
    const vault = await mkdtemp(path.join(tmpdir(), 'inkling-vsect-vault-'))
    scratch.push(vault)
    const syncOk = async () => {
      const r = await kit.runSync(s, vault, { workspaceId: ws, auth: alice.cookie, home })
      assert.equal(r.code, 0, r.out)
      return r.out
    }
    const guide = await h.makeDocPage(ws, alice.id, 'Guide', [heading('Setup'), { type: 'paragraph', content: [text('setup body')] }] as never)
    const c = await h.makeDocPage(ws, alice.id, 'C', [{ type: 'paragraph', content: [text('the letter')] }] as never)
    const cs = await h.makeDocPage(ws, alice.id, 'C# notes', [heading('Setup'), { type: 'paragraph', content: [text('dotnet')] }] as never)
    const hub = await h.makeDocPage(
      ws,
      alice.id,
      'Hub',
      [
        para(
          text('See '),
          link(ws, guide.id, 'Guide#Setup', { heading: 'Setup', page: 'Guide' }),
          text(', '),
          link(ws, cs.id, 'C# notes'),
          text(' and '),
          link(ws, cs.id, 'C# notes#Setup', { heading: 'Setup', page: 'C# notes' }),
          text(' and '),
          link(ws, guide.id, 'the guide', { heading: 'Setup', page: 'Guide' }),
          text('.'),
        ),
        { type: 'pageEmbed', props: { pageId: guide.id, viewId: '' } },
        { type: 'codeBlock', props: { language: 'mermaid' }, content: [text('graph TD\n  A[[Guide#Setup]] --> B')] },
        { type: 'paragraph', content: [text('untouched line')] },
      ] as never,
    )
    const expected = (links: Link[]) => {
      assert.deepEqual(
        links.map((l) => [l.href.replace(`/w/${ws}/p/`, ''), l.text]),
        [
          [`${guide.id}#h=Setup&p=Guide`, 'Guide#Setup'],
          [cs.id, 'C# notes'],
          [`${cs.id}#h=Setup&p=C%23%20notes`, 'C# notes#Setup'],
          [`${guide.id}#h=Setup&p=Guide`, 'the guide'],
        ],
      )
    }

    await syncOk()
    const file = path.join(vault, 'Hub.md')
    const md = await readFile(file, 'utf8')
    assert.match(md, /See \[\[Guide#Setup\]\], \[\[C# notes\]\] and \[\[C# notes#Setup\]\] and \[\[Guide#Setup\|the guide\]\]\./)
    assert.match(md, new RegExp(`<!-- inkling:pageEmbed \\{"pageId":"${guide.id}"`))
    assert.match(md, /```mermaid\ngraph TD\n {2}A\[\[Guide#Setup\]\] --> B\n```/)

    // edit the paragraph that holds the links: the import resolves every link again
    await writeFile(file, md.replace('See [[Guide#Setup]]', 'Read [[Guide#Setup]]').replace('untouched line', 'touched line'))
    await syncOk()
    const blocks = await currentBlocks(hub.id)
    assert.ok(JSON.stringify(blocks).includes('Read '), 'the edit arrived')
    const got = linksOf(blocks)
    expected(got)
    assert.ok(!got.some((l) => l.href.includes(c.id)), 'no link moved to the page "C"')
    assert.equal(blocks.filter((b) => b.type === 'pageEmbed').length, 1, 'the block token came back as the embed')
    const fence = blocks.find((b) => b.type === 'codeBlock')
    assert.equal((fence?.content as { text: string }[]).map((x) => x.text).join(''), 'graph TD\n  A[[Guide#Setup]] --> B', '[[…]] in a code block stays code')

    // the page index names the sections; another run has nothing to do and the file is unchanged
    const rows = await db.select().from(schema.pageLinks).where(eq(schema.pageLinks.sourcePageId, hub.id))
    assert.deepEqual(rows.map((r) => r.targetPageId).sort(), [cs.id, guide.id].sort())
    const after1 = await readFile(file, 'utf8')
    assert.match(await syncOk(), /nothing to do/)
    assert.equal(await readFile(file, 'utf8'), after1)
    assert.match(after1, /Read \[\[Guide#Setup\]\], \[\[C# notes\]\] and \[\[C# notes#Setup\]\] and \[\[Guide#Setup\|the guide\]\]\./)
  })

  it('a note written in the vault: `[[C# notes]]` is that page, not "C", also when "C" exists', async () => {
    const ws = (await h.makeWorkspace(alice)).id
    const vault = await mkdtemp(path.join(tmpdir(), 'inkling-vsect-vault-'))
    scratch.push(vault)
    const c = await h.makeDocPage(ws, alice.id, 'C', [{ type: 'paragraph', content: [text('the letter')] }] as never)
    const cs = await h.makeDocPage(ws, alice.id, 'C# notes', [heading('Setup')] as never)
    const r0 = await kit.runSync(s, vault, { workspaceId: ws, auth: alice.cookie, home })
    assert.equal(r0.code, 0, r0.out)
    await writeFile(path.join(vault, 'New.md'), 'links: [[C# notes]], [[C# notes#Setup]], [[C]], [[C#Intro]]\n')
    const r = await kit.runSync(s, vault, { workspaceId: ws, auth: alice.cookie, home })
    assert.equal(r.code, 0, r.out)
    const [page] = await db.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.title, 'New'), eq(schema.pages.workspaceId, ws)))
    const got = linksOf(await currentBlocks(page.id)).filter((l) => l.href.includes(ws))
    assert.deepEqual(
      got.map((l) => l.href.replace(`/w/${ws}/p/`, '')),
      [cs.id, `${cs.id}#h=Setup&p=C%23%20notes`, c.id, `${c.id}#h=Intro&p=C`],
    )
  })
})
