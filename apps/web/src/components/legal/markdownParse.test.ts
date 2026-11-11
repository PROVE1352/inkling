// The Markdown reader for the operator's legal documents (LEGAL_DIR, docs/adr/2519-*): the constructs
// the demo templates use, and HTML or unsafe link targets coming out as text, never as markup.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseInline, parseMarkdown, plainText, safeHref, type Block, type Inline } from './markdownParse'

const links = (nodes: Inline[]): string[] =>
  nodes.flatMap((n) => (n.t === 'link' ? [n.href, ...links(n.c)] : n.t === 'strong' || n.t === 'em' ? links(n.c) : []))
const allLinks = (blocks: Block[]): string[] =>
  blocks.flatMap((b) => {
    if (b.t === 'heading' || b.t === 'paragraph') return links(b.c)
    if (b.t === 'list') return b.items.flatMap(links)
    if (b.t === 'table') return [...b.head.flatMap(links), ...b.rows.flat().flatMap(links)]
    if (b.t === 'quote') return allLinks(b.c)
    return []
  })

describe('legal Markdown', () => {
  test('headings, paragraphs, lists, bold and tables', () => {
    const blocks = parseMarkdown(
      '# Title\n\nFirst line\ncontinues.\n\n## 2. Section\n\n- **Bold:** item one\n- item two\n\n1. first\n2. second\n\n| Item | Kept for |\n|---|---|\n| ID | 14 days |\n| Logs |\n',
    )
    assert.deepEqual(
      blocks.map((b) => b.t),
      ['heading', 'paragraph', 'heading', 'list', 'list', 'table'],
    )
    assert.equal(plainText({ t: 'strong', c: (blocks[1] as { c: Inline[] }).c }), 'First line continues.')
    const list = blocks[3] as Extract<Block, { t: 'list' }>
    assert.equal(list.ordered, false)
    assert.deepEqual(list.items[0][0], { t: 'strong', c: [{ t: 'text', v: 'Bold:' }] })
    assert.equal((blocks[4] as Extract<Block, { t: 'list' }>).ordered, true)
    const table = blocks[5] as Extract<Block, { t: 'table' }>
    assert.equal(table.head.length, 2)
    assert.equal(table.rows.length, 2)
    assert.deepEqual(table.rows[1][1], [], 'a short row is padded to the header')
  })

  test('an empty header cell (the English transfer table) stays a cell', () => {
    const [table] = parseMarkdown('| | Details |\n|---|---|\n| Recipient | Oracle |') as Extract<Block, { t: 'table' }>[]
    assert.equal(table.t, 'table')
    assert.deepEqual(table.head[0], [])
    assert.equal(plainText({ t: 'strong', c: table.rows[0][1] }), 'Oracle')
  })

  test('HTML is text: <script>, <img onerror> and inline handlers come out as the characters they are', () => {
    const src = '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n| a |\n|---|\n| <b onclick="x()">b</b> |'
    const blocks = parseMarkdown(src)
    const text = JSON.stringify(blocks)
    assert.ok(text.includes('<script>alert(1)</script>'))
    assert.ok(text.includes('<img src=x onerror=\\"alert(2)\\">'))
    // nothing but text nodes: no node type can carry markup
    assert.deepEqual(allLinks(blocks), [])
  })

  test('links: only http, https and mailto; anything else keeps its words and loses the link', () => {
    assert.equal(safeHref('https://example.com/a'), 'https://example.com/a')
    assert.equal(safeHref('mailto:op@example.com'), 'mailto:op@example.com')
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>', 'vbscript:x', '/relative', '//evil.example', 'https:evil', 'http://']) {
      assert.equal(safeHref(bad), null, bad)
    }
    const nodes = parseInline('[click](javascript:alert(1)) and [site](https://example.com) and [mail](mailto:a@b.co)')
    assert.deepEqual(links(nodes), ['https://example.com', 'mailto:a@b.co'])
    assert.ok(nodes.some((n) => n.t === 'text' && n.v === 'click'))
  })

  test('bare addresses become links; a placeholder does not', () => {
    const nodes = parseInline('See https://www.oracle.com/legal/privacy/ or write to op@example.com. {{CONTACT_EMAIL}}')
    assert.deepEqual(links(nodes), ['https://www.oracle.com/legal/privacy/', 'mailto:op@example.com'])
    assert.equal(plainText({ t: 'strong', c: nodes }), 'See https://www.oracle.com/legal/privacy/ or write to op@example.com. {{CONTACT_EMAIL}}')
  })

  test('the demo templates parse: every section heading, every table, no stray markup', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/demo/legal')
    for (const file of ['terms.ko.md', 'terms.en.md', 'privacy.ko.md', 'privacy.en.md']) {
      const src = readFileSync(path.join(dir, file), 'utf8')
      const blocks = parseMarkdown(src)
      const h2 = src.split('\n').filter((l) => l.startsWith('## ')).length
      assert.equal(blocks.filter((b) => b.t === 'heading' && b.level === 2).length, h2, file)
      const tables = src.split('\n').filter((l) => /^\|[-| ]+\|$/.test(l.trim())).length
      assert.equal(blocks.filter((b) => b.t === 'table').length, tables, file)
      assert.ok(!JSON.stringify(blocks).includes('**'), `${file}: unparsed bold`)
    }
  })
})
