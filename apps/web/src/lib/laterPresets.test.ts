// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/laterPresets.test.ts
// Reminder presets in the device time zone (docs/adr/1411-*). TZ is set before any Date is made.
process.env.TZ = 'Asia/Seoul'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fromLocalInput, laterPresets, toLocalInput } from './laterPresets'

const byId = (now: Date) => Object.fromEntries(laterPresets(now).map((p) => [p.id, p.at.toISOString()]))

describe('laterPresets (Asia/Seoul, UTC+9)', () => {
  it('a Wednesday afternoon: 20 minutes, tonight 18:00, tomorrow 9:00, next Monday 9:00', () => {
    // 2026-11-11 (Wed) 14:05:30 KST = 05:05:30Z
    const p = byId(new Date('2026-11-11T05:05:30Z'))
    assert.equal(p.in20, '2026-11-11T05:25:00.000Z')
    assert.equal(p.tonight, '2026-11-11T09:00:00.000Z')
    assert.equal(p.tomorrow, '2026-11-12T00:00:00.000Z')
    assert.equal(p.nextWeek, '2026-11-16T00:00:00.000Z')
  })

  it('no "tonight" from 17:30 on; on a Monday "next week" is the Monday after', () => {
    // 2026-11-16 (Mon) 17:40 KST
    const p = byId(new Date('2026-11-16T08:40:00Z'))
    assert.equal(p.tonight, undefined)
    assert.equal(p.nextWeek, '2026-11-23T00:00:00.000Z')
  })

  it('late Sunday night: tomorrow and next week are the same Monday 9:00; month end rolls over', () => {
    // 2026-11-29 (Sun) 23:50 KST
    const p = byId(new Date('2026-11-29T14:50:00Z'))
    assert.equal(p.tomorrow, '2026-11-30T00:00:00.000Z')
    assert.equal(p.nextWeek, '2026-11-30T00:00:00.000Z')
    // 2026-11-30 (Mon) 23:59 KST → tomorrow is Dec 1
    assert.equal(byId(new Date('2026-11-30T14:59:00Z')).tomorrow, '2026-12-01T00:00:00.000Z')
  })

  it('datetime-local values round-trip as local wall time', () => {
    const d = fromLocalInput('2026-12-24T19:30')
    assert.equal(d.toISOString(), '2026-12-24T10:30:00.000Z')
    assert.equal(toLocalInput(d), '2026-12-24T19:30')
    assert.equal(fromLocalInput(''), null)
    assert.equal(fromLocalInput('2026-12-24'), null)
  })
})
