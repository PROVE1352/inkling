// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Mermaid on public pages (docs/adr/2191-*): which server-HTML code blocks are drawn, the image put
// after the hidden code block, the code kept on an error, and the cleanup. A tiny DOM stand-in; the
// renderer is the editor's (tested in mermaid.test.ts), injected here.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setLocaleChoice } from '../i18n'
import { mermaidCodeBlocks, renderMermaidIn } from './mermaidPublic'

setLocaleChoice('en')

function el(tag: string, attrs: Record<string, string> = {}, children: any[] = [], text = '') {
  const node: any = {
    tag,
    attrs,
    children,
    hidden: false,
    style: { display: '' },
    isConnected: true,
    textContent: text,
    getAttribute: (k: string) => attrs[k] ?? null,
    querySelector: (sel: string) => (sel === ':scope > pre' ? children.find((c) => c.tag === 'pre') ?? null : null),
    after: (x: any) => node.siblings.push(x),
    siblings: [] as any[],
    ownerDocument: {
      createElement: (t: string) => {
        const made: any = { tag: t, children: [], appendChild: (c: any) => made.children.push(c), remove: () => (made.removed = true) }
        return made
      },
    },
  }
  return node
}
const block = (language: string, source: string) => el('div', { 'data-content-type': 'codeBlock', 'data-language': language }, [el('pre', {}, [], source)])
const root = (blocks: any[]) => ({
  querySelectorAll: (sel: string) => {
    assert.equal(sel, '[data-content-type="codeBlock"][data-language]')
    return blocks
  },
})
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('Mermaid on public pages', () => {
  it('picks mermaid and mmd code blocks (any case), not other languages or empty ones', () => {
    const blocks = [block('mermaid', 'graph TD\n A-->B'), block('MMD', 'pie\n "a": 1'), block('js', 'x()'), block('mermaid', '   '), block('dataview', 'LIST')]
    assert.deepEqual(mermaidCodeBlocks(root(blocks)).map((b) => b.source), ['graph TD\n A-->B', 'pie\n "a": 1'])
  })

  it('puts the image after the code and hides the code; an error keeps the code; cleanup restores', async () => {
    const good = block('mermaid', 'graph TD\n A-->B')
    const bad = block('mermaid', 'graph ??')
    const calls: string[] = []
    const render = async (source: string, theme: string) => {
      calls.push(`${theme}:${source}`)
      return source.includes('??') ? { ok: false, message: 'Parse error' } : { ok: true, src: 'data:image/svg+xml;base64,PHN2Zy8+', width: 120, height: 80 }
    }
    const stop = renderMermaidIn(root([good, bad]), 'dark', render)
    await tick()
    assert.deepEqual(calls, ['dark:graph TD\n A-->B', 'dark:graph ??'])
    // the image goes after the whole code block (BlockNote draws the block as a dark box), which is hidden
    assert.equal(good.style.display, 'none')
    const [figure] = good.siblings
    assert.equal(figure.tag, 'figure')
    const img = figure.children[0]
    assert.equal(img.tag, 'img')
    assert.match(img.src, /^data:image\/svg\+xml/)
    assert.equal(img.alt, 'Mermaid diagram: graph TD')
    assert.equal(bad.style.display, '')
    assert.equal(bad.siblings.length, 0)
    stop()
    assert.equal(good.style.display, '')
    assert.equal(figure.removed, true)
  })

  it('a page without a diagram renders nothing (Mermaid is never loaded)', () => {
    let called = false
    const stop = renderMermaidIn(root([block('python', 'print(1)')]), 'light', async () => {
      called = true
      return { ok: false, message: '' }
    })
    stop()
    assert.equal(called, false)
  })

  it('a result arriving after the cleanup (new HTML, theme change) is dropped', async () => {
    const b = block('mermaid', 'graph LR\n X-->Y')
    let resolve: (r: any) => void = () => {}
    const stop = renderMermaidIn(root([b]), 'light', () => new Promise((r) => (resolve = r)))
    stop()
    resolve({ ok: true, src: 'data:image/svg+xml;base64,PHN2Zy8+', width: 1, height: 1 })
    await tick()
    assert.equal(b.style.display, '')
    assert.equal(b.siblings.length, 0)
  })
})
