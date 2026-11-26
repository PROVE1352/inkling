// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/buttonTargets.test.ts
// Where a button's "add a row" actions write (sec26 E-2): only databases of the button's workspace the presser
// sees, and the first press names them and asks.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkButtonTargets } from './buttonRun'

const MINE = '11111111-2222-4333-8444-555555555555'
const MINE2 = '77777777-2222-4333-8444-555555555555'
const ELSEWHERE = '22222222-3333-4444-8555-666666666666'
const titles = new Map([
  [MINE, 'Tasks'],
  [MINE2, 'Log'],
])

function deps(answer = true) {
  const asked: string[][] = []
  return {
    asked,
    collectionTitle: (id: string) => titles.get(id) ?? null,
    confirm: async (t: string[]) => {
      asked.push(t)
      return answer
    },
  }
}
const addRow = (collectionId: string) => ({ type: 'addRow', collectionId })

describe('button targets (sec26 E-2)', () => {
  it('a database outside the workspace (or one the presser cannot see) refuses the press, without asking', async () => {
    const d = deps()
    const r = await checkButtonTargets([{ type: 'open', url: 'https://x.example' }, addRow(ELSEWHERE)], 'b1', d, new Set())
    assert.deepEqual(r, { ok: false, reason: 'otherWorkspace', failedIndex: 1 })
    assert.deepEqual(d.asked, [])
  })

  it('the first press names the databases once each and asks; the next press does not', async () => {
    const seen = new Set<string>()
    const d = deps()
    const acts = [addRow(MINE), addRow(MINE2), addRow(MINE)]
    assert.deepEqual(await checkButtonTargets(acts, 'b1', d, seen), { ok: true })
    assert.deepEqual(d.asked, [['Tasks', 'Log']])
    assert.deepEqual(await checkButtonTargets(acts, 'b1', d, seen), { ok: true })
    assert.equal(d.asked.length, 1)
  })

  it('declining runs nothing and asks again next time', async () => {
    const seen = new Set<string>()
    const d = deps(false)
    assert.deepEqual(await checkButtonTargets([addRow(MINE)], 'b1', d, seen), { ok: false, reason: 'cancelled' })
    assert.deepEqual(await checkButtonTargets([addRow(MINE)], 'b1', d, seen), { ok: false, reason: 'cancelled' })
    assert.equal(d.asked.length, 2)
  })

  it('a button whose databases changed asks again; another button asks for itself', async () => {
    const seen = new Set<string>()
    const d = deps()
    await checkButtonTargets([addRow(MINE)], 'b1', d, seen)
    await checkButtonTargets([addRow(MINE2)], 'b1', d, seen)
    await checkButtonTargets([addRow(MINE)], 'b2', d, seen)
    assert.deepEqual(d.asked, [['Tasks'], ['Log'], ['Tasks']])
  })

  it('a button without "add a row" runs as before, without asking', async () => {
    const d = deps()
    assert.deepEqual(await checkButtonTargets([{ type: 'open', pageId: MINE }, { type: 'setFields', props: {} }], 'b1', d, new Set()), { ok: true })
    assert.deepEqual(d.asked, [])
  })
})
