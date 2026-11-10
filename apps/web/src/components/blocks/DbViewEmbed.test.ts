// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Inline database view (docs/adr/2120-*) with 0.17's collection features (docs/adr/2145-*, 2146-*):
// a list view draws as a list, a page guest's person cells take their names from the response's
// `people` (guests get no member list), and the block stays read-only.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setLocaleChoice } from '../../i18n'

// the view components pull in modules that touch the DOM when loaded (theme): a minimal stand-in
const noopEl = { classList: { toggle() {}, add() {}, remove() {} }, style: {}, setAttribute() {}, dataset: {} }
globalThis.document ??= { documentElement: noopEl, addEventListener() {}, removeEventListener() {}, querySelector: () => null }
globalThis.window ??= globalThis
globalThis.addEventListener ??= () => {}
globalThis.removeEventListener ??= () => {}
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
const { DbViewEmbed } = await import('./DbViewEmbed')

setLocaleChoice('en')

const WS = '00000000-0000-4000-8000-0000000000aa'
const COL = '00000000-0000-4000-8000-0000000000c1'
const GUEST_FRIEND = '00000000-0000-4000-8000-0000000000f1'

const meta = (id: string, title: string, parentId: string | null) => ({
  id,
  workspaceId: WS,
  parentId,
  title,
  icon: null,
  kind: 'doc',
  scope: 'shared',
  sortOrder: 0,
  updatedAt: '2026-11-10T00:00:00.000Z',
  createdAt: '2026-11-10T00:00:00.000Z',
})

const fields = [
  { id: 'who', name: 'Owner', type: 'person' },
  { id: 'parent', name: 'Parent item', type: 'relation', relation: { targetPageId: COL, subItems: true } },
]

function render(viewType: string, role: 'guest' | 'member') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['workspaces'], [{ id: WS, name: 'W', role }])
  qc.setQueryData(['collection', COL], {
    collection: { pageId: COL, fields, views: [{ id: 'v1', name: 'Tasks', type: viewType, config: {}, sortOrder: 0 }] },
    rows: [
      { ...meta('00000000-0000-4000-8000-0000000000r1', 'Write the plan', COL), props: { who: GUEST_FRIEND } },
      { ...meta('00000000-0000-4000-8000-0000000000r2', 'Sub step', COL), props: { parent: ['00000000-0000-4000-8000-0000000000r1'] } },
    ],
    people: { [GUEST_FRIEND]: 'Mia Friend' },
  })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        MemoryRouter,
        null,
        createElement(DbViewEmbed, { wsId: WS, target: { ...meta(COL, 'Board', null), kind: 'collection' }, viewId: 'v1', editable: false, onSetView: () => {} }),
      ),
    ),
  )
}

describe('DbViewEmbed with 0.17 collections', () => {
  it('draws a list view as a list (not the table fallback), parent first, without a new-row button', () => {
    const html = render('list', 'guest')
    assert.match(html, /role="list"/)
    assert.doesNotMatch(html, /role="grid"/)
    assert.doesNotMatch(html, /New row/)
    const a = html.indexOf('Write the plan')
    const b = html.indexOf('Sub step')
    assert.ok(a >= 0 && b > a, 'the sub-item follows its parent')
  })

  it("names a guest's person cells from the response's people", () => {
    for (const type of ['list', 'table']) {
      const html = render(type, 'guest')
      assert.match(html, /Mia Friend/, type)
      assert.doesNotMatch(html, new RegExp(GUEST_FRIEND), type)
    }
  })
})
