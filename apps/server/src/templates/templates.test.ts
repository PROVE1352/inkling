// Template engine tests (docs/adr/0920-0925).
// Pure tests always run; [db] suites need a migrated scratch database (DATABASE_URL).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { blocksToStateBuffer, markdownToBlocks, stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { builtinTemplates, builtinTree } from './builtins'
import { deriveMeta, previewTree, transformDocState, transformCanvasState, walk } from './structure'
import {
  collectInputs,
  formatDate,
  renderString,
  rewriteTemplater,
  wallClock,
  withIsoDate,
} from './variables'
import type { VarContext } from './variables'

const NOW = { year: 2026, month: 11, day: 7, hour: 9, minute: 5, second: 3 }
const ctx = (over: Partial<VarContext> = {}): VarContext => ({
  title: 'Launch plan',
  author: 'Ada',
  workspace: 'Team',
  locale: 'en',
  now: NOW,
  inputs: {},
  ...over,
})

describe('variables', () => {
  it('substitutes the known variables', () => {
    const r = renderString('{{title}} by {{author}} in {{workspace}} on {{date}} {{time}} ({{weekday}})', ctx())
    assert.equal(r.text, 'Launch plan by Ada in Team on 2026-11-07 09:05 (Saturday)')
  })

  it('formats dates with tokens and locale names', () => {
    assert.equal(renderString('{{date:YYYY/MM/DD}}', ctx()).text, '2026/11/07')
    assert.equal(renderString('{{date:dddd, MMMM Do}}', ctx()).text, 'Saturday, November 7th')
    assert.equal(renderString('{{date:YYYY년 M월 D일 dddd}}', ctx({ locale: 'ko' })).text, '2026년 11월 7일 토요일')
    assert.equal(renderString('{{weekday}}', ctx({ locale: 'ko' })).text, '토요일')
    assert.equal(renderString('{{date:GGGG-[W]WW}}', ctx()).text, '2026-W45')
    assert.equal(renderString('{{time:h:mm A}}', ctx()).text, '9:05 AM')
    assert.equal(renderString('{{time:A h시}}', ctx({ locale: 'ko' })).text, '오전 9시')
    assert.equal(formatDate({ ...NOW, year: 2027, month: 1, day: 1 }, 'GGGG-[W]WW', 'en'), '2026-W53')
  })

  it('uses the creator time zone for today and time', () => {
    // 2026-11-07 23:30 UTC = 2026-11-08 08:30 in Seoul, 2026-11-07 15:30 in Los Angeles
    const instant = new Date(Date.UTC(2026, 10, 7, 23, 30))
    const seoul = wallClock(instant, 'Asia/Seoul')
    const la = wallClock(instant, 'America/Los_Angeles')
    assert.equal(formatDate(seoul, 'YYYY-MM-DD HH:mm', 'en'), '2026-11-08 08:30')
    assert.equal(formatDate(la, 'YYYY-MM-DD HH:mm', 'en'), '2026-11-07 15:30')
    // invalid zone → process zone, never a throw
    assert.doesNotThrow(() => wallClock(instant, 'Not/AZone'))
    // the gallery date replaces the day, keeps the time
    assert.equal(formatDate(withIsoDate(seoul, '2026-12-25'), 'YYYY-MM-DD HH:mm', 'en'), '2026-12-25 08:30')
  })

  it('leaves unknown variables and malformed tags alone', () => {
    const s = '{{unknown}} {{ title }} {{title:x}} {{date:}} {{input:}} {{cursor:1}} {{'
    assert.equal(renderString(s, ctx()).text, '{{unknown}} Launch plan {{title:x}} {{date:}} {{input:}} {{cursor:1}} {{')
  })

  it('fills inputs with answers or their defaults', () => {
    const s = '{{input:Goal?|Ship it}} / {{input:Owner}} / {{input:Goal?|ignored}}'
    // an unanswered prompt falls back to the default written at each occurrence
    assert.equal(renderString(s, ctx()).text, 'Ship it /  / ignored')
    assert.equal(renderString(s, ctx({ inputs: { 'Goal?': 'Win', Owner: 'Bo' } })).text, 'Win / Bo / Win')
    assert.equal(renderString(s, ctx({ inputs: { 'Goal?': '   ' } })).text, 'Ship it /  / ignored')
    assert.deepEqual(collectInputs([s, '{{input:Second}}']), [
      { name: 'Goal?', default: 'Ship it' },
      { name: 'Owner', default: '' },
      { name: 'Second', default: '' },
    ])
  })

  it('reports and removes the first cursor', () => {
    assert.deepEqual(renderString('ab{{cursor}}cd{{cursor}}', ctx(), true), { text: 'abcd', cursor: 2 })
    assert.deepEqual(renderString('ab{{cursor}}', ctx(), false), { text: 'ab' })
  })

  it('maps the Templater subset and never evaluates anything else', () => {
    assert.equal(rewriteTemplater('<% tp.file.title %>'), '{{title}}')
    assert.equal(rewriteTemplater('<%tp.date.now("YYYY-MM-DD")%>'), '{{date:YYYY-MM-DD}}')
    assert.equal(renderString('<% tp.date.now() %>', ctx()).text, '2026-11-07')
    assert.equal(renderString("<% tp.date.now('MMM D', 7) %>", ctx()).text, 'Nov 14')
    assert.equal(renderString('<% tp.date.now("YYYY-MM-DD", -7) %>', ctx()).text, '2026-10-31')
    assert.deepEqual(renderString('x<% tp.file.cursor() %>y', ctx(), true), { text: 'xy', cursor: 1 })
    const code = '<%* tR += require("fs") %> <% tp.system.prompt("x") %> <% tp.file.creation_date() %>'
    assert.equal(renderString(code, ctx()).text, code)
  })
})

async function docState(md: string): Promise<Buffer> {
  return blocksToStateBuffer(await markdownToBlocks(md, (t) => (t === 'Target' ? '/w/11111111-1111-4111-8111-111111111111/p/22222222-2222-4222-8222-222222222222' : null)))
}

describe('document substitution on Yjs', () => {
  const render = (s: string, allow: boolean) => renderString(s, ctx(), allow)

  it('keeps marks, links and code untouched while substituting text runs', async () => {
    const st = await docState('Plain {{title}} **bold {{author}}** `{{date}}` [[Target]] {{da*te}}*\n\n```\n{{title}}\n```\n')
    const r = transformDocState(st, {
      render,
      remapHref: (h) => (h.endsWith('22222222-2222-4222-8222-222222222222') ? '/w/ws/p/new' : null),
      wantCursor: false,
    })
    const blocks = stateToBlocks(r.state)
    const inl = blocks[0].content as { type: string; text?: string; styles?: Record<string, unknown>; href?: string; content?: { text: string }[] }[]
    assert.equal(inl[0].text, 'Plain Launch plan ')
    const bold = inl.find((i) => i.styles?.bold)!
    assert.equal(bold.text, 'bold Ada')
    const code = inl.find((i) => i.styles?.code)!
    assert.equal(code.text, '{{date}}', 'inline code is never substituted')
    const link = inl.find((i) => i.type === 'link')!
    assert.equal(link.href, '/w/ws/p/new')
    assert.equal(link.content![0].text, 'Target')
    // a variable split across two formats is left as is
    assert.ok(JSON.stringify(inl).includes('{{da'))
    assert.equal(blocks[1].type, 'codeBlock')
    assert.equal((blocks[1].content as { text: string }[])[0].text, '{{title}}')
  })

  it('returns the cursor block and offset', async () => {
    const st = await docState('# Title\n\nHello {{author}}, {{cursor}}here')
    const before = stateToBlocks(st)
    const r = transformDocState(st, { render, remapHref: () => null, wantCursor: true })
    assert.equal(r.cursor?.blockId, before[1].id)
    assert.equal(r.cursor?.offset, 'Hello Ada, '.length)
    assert.equal((stateToBlocks(r.state)[1].content as { text: string }[])[0].text, 'Hello Ada, here')
  })

  it('preserves blocks the server schema does not know (callouts)', async () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await docState('first {{title}}'))
    const group = doc.getXmlFragment('document').get(0) as Y.XmlElement
    const bc = new Y.XmlElement('blockContainer')
    bc.setAttribute('id', 'callout-1')
    const co = new Y.XmlElement('callout')
    co.setAttribute('type', 'tip')
    const tx = new Y.XmlText()
    tx.insert(0, 'inside {{author}}')
    co.insert(0, [tx])
    bc.insert(0, [co])
    group.insert(1, [bc])
    const r = transformDocState(Y.encodeStateAsUpdate(doc), { render, remapHref: () => null, wantCursor: false })
    const out = new Y.Doc()
    Y.applyUpdate(out, r.state)
    const xml = out.getXmlFragment('document').toString()
    assert.match(xml, /<callout type="tip">inside Ada<\/callout>/)
    assert.match(xml, /first Launch plan/)
  })

  it('substitutes canvas text nodes and remaps page nodes', () => {
    const doc = new Y.Doc()
    const nodes = doc.getMap('cnodes')
    nodes.set('a', { id: 'a', type: 'text', text: 'Plan for {{title}}', x: 0, y: 0, width: 10, height: 10 })
    nodes.set('b', { id: 'b', type: 'page', pageId: 'old', x: 0, y: 0, width: 10, height: 10 })
    nodes.set('c', { id: 'c', type: 'page', pageId: 'outside', x: 0, y: 0, width: 10, height: 10 })
    const st = transformCanvasState(Y.encodeStateAsUpdate(doc), (s) => renderString(s, ctx()).text, (id) => (id === 'old' ? 'new' : null))
    const out = new Y.Doc()
    Y.applyUpdate(out, st)
    const m = out.getMap('cnodes').toJSON() as Record<string, { text?: string; pageId?: string }>
    assert.equal(m.a.text, 'Plan for Launch plan')
    assert.equal(m.b.pageId, 'new')
    assert.equal(m.c.pageId, 'outside')
  })
})

describe('built-in templates', () => {
  it('every built-in compiles in both languages with matching structure', async () => {
    for (const locale of ['en', 'ko'] as const) {
      for (const t of builtinTemplates(locale)) {
        const tree = await builtinTree(t)
        const meta = deriveMeta(tree)
        assert.equal(meta.pageCount, t.pageCount, `${t.key}/${locale} page count`)
        assert.equal(meta.kind, t.kind)
        assert.deepEqual(meta.inputs, t.inputs, `${t.key}/${locale} inputs`)
        for (const { node } of walk(tree)) {
          if (node.kind !== 'doc') continue
          const blocks = stateToBlocks(Buffer.from(node.state!, 'base64'))
          assert.ok(blocks.length > 0)
          // no markdown syntax leaked as literal text
          const text = JSON.stringify(blocks)
          assert.ok(!/"text":"(#|\*\*|- \[)/.test(text), `${t.key}/${locale}: stray markdown in ${node.title}`)
        }
      }
      const en = builtinTemplates('en').map((t) => [t.key, t.pageCount, t.inputs.length, t.category])
      const ko = builtinTemplates('ko').map((t) => [t.key, t.pageCount, t.inputs.length, t.category])
      assert.deepEqual(en, ko, 'en/ko built-ins have the same structure')
    }
  })

  it('Project links its overview to the Tasks collection and Meeting notes folder', async () => {
    const t = builtinTemplates('en').find((x) => x.key === 'project')!
    const tree = await builtinTree(t)
    const ids = new Map([...walk(tree)].map(({ node }) => [node.title, node.id]))
    const blocks = stateToBlocks(Buffer.from(tree.state!, 'base64'))
    const hrefs: string[] = []
    const visit = (bs: AnyBlock[]) => {
      for (const b of bs) {
        for (const i of (Array.isArray(b.content) ? b.content : []) as { type: string; href?: string }[]) if (i.type === 'link') hrefs.push(i.href!)
        visit(b.children ?? [])
      }
    }
    visit(blocks)
    assert.ok(hrefs.some((h) => h.endsWith(ids.get('Tasks')!)))
    assert.ok(hrefs.some((h) => h.endsWith(ids.get('Meeting notes')!)))
    const tasks = tree.children.find((c) => c.title === 'Tasks')!
    assert.equal(tasks.kind, 'collection')
    assert.deepEqual(tasks.fields!.map((f) => f.type), ['select', 'person', 'date', 'select'])
    assert.equal(tasks.views![0].type, 'board')
    assert.deepEqual(t.inputs.map((i) => i.name), ['Target date', 'What is this project for?'])
    const preview = previewTree(tree)
    assert.equal(preview.outline[0].title, 'Project')
    assert.ok(preview.blocks.some((b) => b.type === 'h2' && b.text === 'Goal'))
  })
})
