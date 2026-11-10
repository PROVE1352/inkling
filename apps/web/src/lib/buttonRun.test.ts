// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRunGuard, localToday, runButtonActions } from './buttonRun'

const COL = '11111111-2222-4333-8444-555555555555'
const OTHER = '22222222-3333-4444-8555-666666666666'
const PAGE = '33333333-4444-4555-8666-777777777777'
const ME = '44444444-5555-4666-8777-888888888888'
const ROW_COL = '55555555-6666-4777-8888-999999999999'
const HOOK = '66666666-7777-4888-9999-aaaaaaaaaaaa'

const fields = [
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'owner', name: 'Owner', type: 'person' },
  { id: 'from', name: 'From', type: 'relation', relation: { targetPageId: PAGE } },
  { id: 'note', name: 'Note', type: 'text' },
  { id: 'done', name: 'Done', type: 'checkbox' },
]

function harness(failAt = -1) {
  const calls = []
  const opened = []
  const deps = {
    request: async (path, init) => {
      calls.push({ path, method: init.method, body: JSON.parse(init.body) })
      if (calls.length - 1 === failAt) throw new Error('No permission to edit')
      return {}
    },
    loadFields: async () => fields,
    openPage: (id) => opened.push(`page:${id}`),
    openUrl: (u) => opened.push(`url:${u}`),
    tz: 'Asia/Seoul',
  }
  return { calls, opened, deps }
}

const input = {
  pageId: PAGE,
  rowCollectionId: ROW_COL,
  blockId: 'blk-1',
  ctx: { today: '2026-11-10', userId: ME, userName: 'Kim', pageId: PAGE, pageTitle: 'Sprint 3' },
}

describe('button runs (2244)', () => {
  it('runs the actions in order', async () => {
    const { calls, opened, deps } = harness()
    const r = await runButtonActions(
      [
        { type: 'addRow', collectionId: COL, props: { note: 'x' } },
        { type: 'setFields', props: { done: true } },
        { type: 'webhook', webhookId: HOOK },
        { type: 'open', pageId: OTHER },
      ],
      input,
      deps,
    )
    assert.equal(r.ok, true)
    assert.equal(r.done, 4)
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      [`POST /api/pages/${COL}/collection/rows`, `PATCH /api/pages/${PAGE}/props`, `POST /api/pages/${PAGE}/button-webhook`],
    )
    assert.deepEqual(calls[1].body, { props: { done: true } })
    assert.deepEqual(calls[2].body, { blockId: 'blk-1', webhookId: HOOK })
    assert.deepEqual(opened, [`page:${OTHER}`])
    assert.deepEqual(r.collections.sort(), [COL, ROW_COL].sort())
  })

  it('stops at a failing second action: the third never runs, the index is reported', async () => {
    const { calls, opened, deps } = harness(1)
    const r = await runButtonActions(
      [
        { type: 'addRow', collectionId: COL },
        { type: 'setFields', props: { done: true } },
        { type: 'open', pageId: OTHER },
      ],
      input,
      deps,
    )
    assert.equal(r.ok, false)
    assert.equal(r.failedIndex, 1)
    assert.equal(r.failedType, 'setFields')
    assert.equal(r.done, 1)
    assert.equal(r.code, null)
    assert.equal(r.message, 'No permission to edit')
    assert.equal(calls.length, 2)
    assert.deepEqual(opened, [], 'the third action did not run')
    assert.deepEqual(r.collections, [COL], 'the row added before the failure is still refreshed')
  })

  it('resolves variables: today, me, this, text', async () => {
    const { calls, deps } = harness()
    await runButtonActions(
      [
        {
          type: 'addRow',
          collectionId: COL,
          title: 'Review {{page}} {{today}}',
          props: { due: 'today+7', owner: 'me', from: 'this', note: 'by {{me}}', gone: 'x' },
        },
      ],
      input,
      deps,
    )
    assert.deepEqual(calls[0].body, {
      title: 'Review Sprint 3 2026-11-10',
      props: { due: '2026-11-17', owner: ME, from: [PAGE], note: 'by Kim' },
      tz: 'Asia/Seoul',
    })
  })

  it('template: undefined keeps the default, null asks for an empty row, an id picks one', async () => {
    const { calls, deps } = harness()
    await runButtonActions(
      [
        { type: 'addRow', collectionId: COL },
        { type: 'addRow', collectionId: COL, templateId: null },
        { type: 'addRow', collectionId: COL, templateId: OTHER },
      ],
      input,
      deps,
    )
    assert.ok(!('template' in calls[0].body))
    assert.equal(calls[1].body.template, null)
    assert.equal(calls[2].body.template, OTHER)
  })

  it('a variable that cannot resolve is left out, never sent raw', async () => {
    const { calls, deps } = harness()
    await runButtonActions(
      [{ type: 'addRow', collectionId: COL, props: { owner: 'me', from: 'this', due: 'tomorrow' } }],
      { ...input, ctx: { today: '2026-11-10', userId: null, pageId: null } },
      deps,
    )
    assert.ok(!('props' in calls[0].body))
  })

  it('setFields on a page that is not a row fails visibly at that action', async () => {
    const { calls, deps } = harness()
    const r = await runButtonActions(
      [{ type: 'open', url: 'https://example.com/a' }, { type: 'setFields', props: { done: true } }],
      { ...input, rowCollectionId: null },
      deps,
    )
    assert.equal(r.ok, false)
    assert.equal(r.failedIndex, 1)
    assert.equal(r.code, 'notRow')
    assert.equal(calls.length, 0)
  })

  it('refuses URLs that are not http(s), whatever the block JSON says', async () => {
    for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', '//evil.example', 'ftp://x.example', ' ']) {
      const { opened, deps } = harness()
      const r = await runButtonActions([{ type: 'open', url }], input, deps)
      assert.equal(r.ok, false, url)
      assert.ok(r.code === 'badUrl' || r.code === 'nothingToOpen', url)
      assert.deepEqual(opened, [], url)
    }
    const { opened, deps } = harness()
    const ok = await runButtonActions([{ type: 'open', url: 'https://example.com/x?y=1' }], input, deps)
    assert.equal(ok.ok, true)
    assert.deepEqual(opened, ['url:https://example.com/x?y=1'])
  })

  it('a webhook needs the page the button is on', async () => {
    const { calls, deps } = harness()
    const r = await runButtonActions([{ type: 'webhook', webhookId: HOOK }], { ...input, pageId: null }, deps)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'noPage')
    assert.equal(calls.length, 0)
  })

  it('loads the fields of a collection once per run', async () => {
    const { deps } = harness()
    let loads = 0
    deps.loadFields = async () => {
      loads++
      return fields
    }
    await runButtonActions(
      [
        { type: 'addRow', collectionId: COL },
        { type: 'addRow', collectionId: COL },
      ],
      input,
      deps,
    )
    assert.equal(loads, 1)
  })

  it('the guard ignores presses while a run is going', async () => {
    const guard = createRunGuard()
    let release
    let runs = 0
    const first = guard.run(async () => {
      runs++
      await new Promise((r) => (release = r))
      return 'first'
    })
    assert.equal(guard.busy, true)
    const second = await guard.run(async () => {
      runs++
      return 'second'
    })
    assert.equal(second, null)
    release()
    assert.equal(await first, 'first')
    assert.equal(guard.busy, false)
    assert.equal(await guard.run(async () => 'third'), 'third')
    assert.equal(runs, 1, "the ignored press never ran")
  })

  it('the guard frees itself after a failure', async () => {
    const guard = createRunGuard()
    await assert.rejects(guard.run(async () => {
      throw new Error('boom')
    }))
    assert.equal(guard.busy, false)
  })

  it('localToday is the local calendar day', () => {
    assert.equal(localToday(new Date(2026, 0, 2, 0, 30)), '2026-01-02')
    assert.equal(localToday(new Date(2026, 11, 31, 23, 59)), '2026-12-31')
  })
})
