// Unit tests of database automations and buttons (docs/adr/2240-* .. 2245-*): trigger matching, the
// loop marker, conditions with OR / NOT groups, variables, button actions and the one-line summary.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buttonActionsJson,
  isOpenableUrl,
  matchesViewFilter,
  parseButtonActions,
  renderTextVars,
  resolveActionProps,
  resolveDateVar,
  summarizeAutomation,
} from '@inkling/shared'
import type { CollectionField } from '@inkling/shared'
import { nextMarker, triggerFires } from './pure'
import { isAgentVia, isAutomationVia, PUBLIC_FORM_VIA } from '../agentVia'
import { reservedClientName } from '../clientName'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const P1 = '33333333-3333-4333-8333-333333333333'
const fields = [
  { id: 'st', name: 'Status', type: 'select', options: [{ id: 'todo', name: 'To do', color: 'gray' }, { id: 'rv', name: 'Review', color: 'blue' }] },
  { id: 'who', name: 'Owner', type: 'person' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'rel', name: 'Parent', type: 'relation', relation: { targetPageId: P1 } },
  { id: 'note', name: 'Note', type: 'text' },
  { id: 'n', name: 'Points', type: 'number' },
] as unknown as CollectionField[]

describe('triggers and the loop marker', () => {
  it('row added fires on page_added only; field changed on its own field', () => {
    assert.equal(triggerFires({ type: 'rowAdded' }, 'page_added', null), true)
    assert.equal(triggerFires({ type: 'rowAdded' }, 'page_props', ['st']), false)
    assert.equal(triggerFires({ type: 'fieldChanged', fieldId: 'st' }, 'page_props', ['note', 'st']), true)
    assert.equal(triggerFires({ type: 'fieldChanged', fieldId: 'st' }, 'page_props', ['note']), false)
    assert.equal(triggerFires({ type: 'fieldChanged', fieldId: 'st' }, 'page_props', null), false)
    assert.equal(triggerFires({ type: 'dateReached', fieldId: 'due', daysBefore: 1 }, 'page_added', null), false, 'dates come from the tick')
  })

  it('a person write starts depth 0; an automation write carries depth + 1 and the chain', () => {
    assert.deepEqual(nextMarker(null), { depth: 0, chain: [] })
    assert.deepEqual(nextMarker({}), { depth: 0, chain: [] })
    assert.deepEqual(nextMarker({ auto: { ruleId: 'a', depth: 0, chain: [] } }), { depth: 1, chain: ['a'] })
    assert.deepEqual(nextMarker({ auto: { ruleId: 'b', depth: 1, chain: ['a'] } }), { depth: 2, chain: ['a', 'b'] })
    // a rule seen again stays once in the chain
    assert.deepEqual(nextMarker({ auto: { ruleId: 'a', depth: 2, chain: ['a', 'b'] } }).chain, ['a', 'b'])
  })

  it('automation vias are neither agents nor public forms; client names cannot take the prefix', () => {
    assert.equal(isAutomationVia('automation: Triage'), true)
    assert.equal(isAgentVia('automation: Triage'), false)
    assert.equal(isAgentVia('Claude'), true)
    assert.equal(isAgentVia(PUBLIC_FORM_VIA), false)
    assert.equal(reservedClientName('automation: Triage'), 'automation')
    assert.equal(reservedClientName('Automation'), 'automation')
    assert.equal(reservedClientName('Claude Code'), null)
  })
})

describe('conditions (the 0.17 view filter tree)', () => {
  const tree = { mode: 'and' as const, items: [{ fieldId: 'st', op: 'eq' as const, value: 'rv' }, { mode: 'or' as const, not: true, items: [{ fieldId: 'note', op: 'contains' as const, value: 'skip' }, { fieldId: 'n', op: 'gt' as const, value: 10 }] }] }
  it('AND with a NOT-OR group', () => {
    assert.equal(matchesViewFilter({ st: 'rv', note: 'fine', n: 3 }, fields, tree), true)
    assert.equal(matchesViewFilter({ st: 'rv', note: 'please skip', n: 3 }, fields, tree), false)
    assert.equal(matchesViewFilter({ st: 'rv', note: 'fine', n: 30 }, fields, tree), false)
    assert.equal(matchesViewFilter({ st: 'todo', note: 'fine', n: 3 }, fields, tree), false)
    assert.equal(matchesViewFilter({}, fields, null), true, 'no condition: always')
  })
})

describe('variables', () => {
  const ctx = { today: '2026-11-10', userId: U1, userName: 'Minho', pageId: P1, pageTitle: 'Launch', creatorId: U2 }
  it('dates: today and offsets, across month ends', () => {
    assert.equal(resolveDateVar('today', '2026-11-10'), '2026-11-10')
    assert.equal(resolveDateVar('today+7', '2026-11-28'), '2026-12-05')
    assert.equal(resolveDateVar('TODAY-1', '2026-03-01'), '2026-02-28')
    assert.equal(resolveDateVar('2026-01-02', '2026-11-10'), '2026-01-02')
    assert.equal(resolveDateVar('tomorrow', '2026-11-10'), null)
  })
  it('by field type; unknown fields and unresolvable variables are left out', () => {
    const out = resolveActionProps(fields, { st: 'rv', who: 'me', due: 'today+1', rel: 'this', note: 'by {{me}} on {{today}} for {{page}} {{other}}', gone: 'x', n: 3 }, ctx)
    assert.deepEqual(out, { st: 'rv', who: U1, due: '2026-11-11', rel: [P1], note: 'by Minho on 2026-11-10 for Launch {{other}}', n: 3 })
    assert.deepEqual(resolveActionProps(fields, { who: 'creator' }, ctx), { who: U2 })
    assert.deepEqual(resolveActionProps(fields, { who: 'me', rel: 'this' }, { today: '2026-11-10', userId: null }), {}, 'nobody / no page: nothing written')
    assert.deepEqual(resolveActionProps(fields, { who: 'not-an-id', due: 'soon' }, ctx), {})
    assert.deepEqual(resolveActionProps(fields, { note: null }, ctx), { note: null }, 'null clears')
    assert.equal(renderTextVars('{{ TODAY }}', ctx), '2026-11-10')
  })
})

describe('button actions', () => {
  it('parse keeps valid actions only and never throws', () => {
    assert.deepEqual(parseButtonActions(''), [])
    assert.deepEqual(parseButtonActions('{nope'), [])
    assert.deepEqual(parseButtonActions('{"type":"open"}'), [])
    const list = parseButtonActions(JSON.stringify([{ type: 'open', url: 'https://example.com' }, { type: 'webhook', webhookId: 'bad' }, { type: 'setFields', props: { st: 'rv' } }, { type: 'mystery' }]))
    assert.deepEqual(list.map((a) => a.type), ['open', 'setFields'])
  })
  it('canonical JSON sorts keys and round-trips', () => {
    const json = buttonActionsJson([{ type: 'addRow', collectionId: P1, props: { b: 1, a: 2 } }])
    assert.equal(json, `[{"collectionId":"${P1}","props":{"a":2,"b":1},"type":"addRow"}]`)
    assert.deepEqual(parseButtonActions(json), [{ type: 'addRow', collectionId: P1, props: { a: 2, b: 1 } }])
    assert.equal(buttonActionsJson([]), '')
  })
  it('only http(s) URLs open', () => {
    assert.equal(isOpenableUrl('https://example.com/a?b'), true)
    assert.equal(isOpenableUrl('javascript:alert(1)'), false)
    assert.equal(isOpenableUrl('data:text/html,x'), false)
    assert.equal(isOpenableUrl('//example.com'), false)
  })
})

describe('summary line', () => {
  it('names fields and option labels', () => {
    assert.equal(
      summarizeAutomation({ trigger: { type: 'fieldChanged', fieldId: 'st', to: 'rv' }, condition: null, actions: [{ type: 'notify', fieldId: 'who' }, { type: 'setFields', props: { due: 'today' } }] }, fields),
      'Status changed to "Review" → notify Owner, set Due',
    )
    assert.equal(summarizeAutomation({ trigger: { type: 'dateReached', fieldId: 'due', daysBefore: 2 }, condition: { mode: 'and', items: [{ fieldId: 'st', op: 'empty' }] }, actions: [{ type: 'webhook', webhookId: U1 }] }, fields), '2d before Due (if filter) → webhook')
  })
})
